import { Inject, Injectable, UnauthorizedException, ForbiddenException, HttpException, HttpStatus, NotFoundException, ConflictException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import {
  users, sessions, mfaFactors, mfaRecoveryCodes, userRoles, rolePermissions, identities,
  passwordResetTokens, userInvites, mfaEnrollTokens, students,
} from "../db/schema";
import { hashPassword, verifyPassword, assertPasswordPolicy, PasswordPolicyError } from "../crypto/password";
import { newTotpSecret, verifyTotpCounter } from "../crypto/totp";
import { encryptText, decryptText } from "../crypto/enc";
import { insertAudit } from "../common/audit";
import { assertCanGrant } from "../common/role-policy";
import { verifyLinkToken } from "./sso.service";
import { enqueue } from "../notify/notify.service";
import { defaultActiveRole } from "../common/session.middleware";
import type { Principal } from "../common/principal";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;          // 1 h
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 d
const ENROLL_TTL_MS = 24 * 60 * 60 * 1000;     // 24 h

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

@Injectable()
export class AuthService {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  async login(email: string, password: string, meta: { ip?: string; ua?: string }) {
    // NOTE: the failure/lockout counters must COMMIT even though the request
    // ends in 401 — so the transaction returns an outcome object and the
    // exceptions are thrown AFTER commit (a throw inside would roll back).
    const outcome = await withActor(this.db, SERVICE, async (tx) => {
      const [user] = await tx.select().from(users)
        .where(eq(sql`lower(${users.email})`, email.toLowerCase())).limit(1);

      // DB-backed lockout: survives restarts, shared across nodes.
      if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        return { kind: "locked" as const, retryAfterMs: user.lockedUntil.getTime() - Date.now() };
      }

      const ok = user && user.status === "active" && await verifyPassword(password, user.passwordHash);
      if (!user || !ok) {
        if (user) {
          const fails = user.failedLoginCount + 1;
          const lock = fails >= config.lockout.maxFailures;
          await tx.update(users).set({
            failedLoginCount: lock ? 0 : fails,
            lockedUntil: lock ? new Date(Date.now() + config.lockout.durationMs) : user.lockedUntil,
          }).where(eq(users.id, user.id));
          await insertAudit(tx, { actorUserId: user.id, action: "auth.login_failed",
            after: { fails, locked: lock }, ip: meta.ip, userAgent: meta.ua });
        }
        return { kind: "invalid" as const };
      }

      const roleRows = await tx.select().from(userRoles)
        .where(and(eq(userRoles.userId, user.id), isNull(userRoles.revokedAt)));
      const roles = roleRows.map((r) => r.roleCode);
      if (roles.length === 0) return { kind: "invalid" as const };
      if (user.failedLoginCount > 0 || user.lockedUntil) {
        await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null })
          .where(eq(users.id, user.id));
      }
      const token = randomBytes(32).toString("base64url");
      const activeRole = defaultActiveRole(roles);
      await tx.insert(sessions).values({
        id: randomUUID(), userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        activeRole, amr: JSON.stringify(["pwd"]),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        ip: meta.ip ?? null, userAgent: meta.ua ?? null,
      });
      await insertAudit(tx, { actorUserId: user.id, action: "auth.login", entityType: "session",
        ip: meta.ip, userAgent: meta.ua });
      return { kind: "ok" as const, token, userId: user.id, roles, activeRole,
        mfaRequired: true, mfaVerified: false,
        mustChangePassword: user.mustChangePassword === true };
    });

    if (outcome.kind === "locked") {
      throw new HttpException(
        { code: "account_locked", title: "Account temporarily locked",
          status: 423, detail: "Too many failed sign-in attempts",
          retryAfterMs: outcome.retryAfterMs },
        HttpStatus.LOCKED);
    }
    if (outcome.kind === "invalid") {
      throw new UnauthorizedException({ code: "invalid_credentials", title: "Invalid credentials" });
    }
    const { kind: _kind, ...result } = outcome;
    return result;
  }

  /**
   * TOTP enrollment — CONTROLLED FLOW (production review blocker #5).
   * Requires a single-use token issued by an admin (directory:write) via
   * POST /admin/users/:id/mfa-enroll-token. A password-only session can no
   * longer self-register an authenticator.
   */
  async totpEnroll(p: Principal, enrollToken: string | undefined) {
    if (!enrollToken) {
      throw new ForbiddenException({ code: "enroll_token_required",
        title: "Enrollment token required",
        detail: "Ask an administrator to issue an MFA enrollment token" });
    }
    return withActor(this.db, SERVICE, async (tx) => {
      const [tok] = await tx.select().from(mfaEnrollTokens)
        .where(and(eq(mfaEnrollTokens.tokenHash, sha(enrollToken)),
          eq(mfaEnrollTokens.userId, p.userId))).limit(1);
      if (!tok || tok.usedAt || tok.expiresAt.getTime() < Date.now()) {
        throw new ForbiddenException({ code: "enroll_token_invalid",
          title: "Enrollment token invalid or expired" });
      }
      const [existing] = await tx.select({ id: mfaFactors.id }).from(mfaFactors)
        .where(and(eq(mfaFactors.userId, p.userId), eq(mfaFactors.kind, "totp"))).limit(1);
      if (existing) {
        throw new ConflictException({ code: "factor_exists",
          title: "An authenticator is already enrolled" });
      }
      await tx.update(mfaEnrollTokens).set({ usedAt: new Date() })
        .where(eq(mfaEnrollTokens.id, tok.id));
      const secret = newTotpSecret();
      await tx.insert(mfaFactors).values({
        id: randomUUID(), userId: p.userId, kind: "totp",
        label: `totp-${Date.now()}`, secretEnc: encryptText(secret),
      });
      // review-2 #5: lost-phone path — 10 single-use recovery codes, hashed at
      // rest, shown exactly once here. Any one of them completes MFA.
      const recoveryCodes: string[] = [];
      for (let i = 0; i < 10; i++) {
        const raw = randomBytes(10).toString("hex");           // 20 hex chars
        const pretty = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`;
        recoveryCodes.push(pretty);
        await tx.insert(mfaRecoveryCodes).values({
          id: randomUUID(), userId: p.userId, codeHash: sha(pretty.replace(/-/g, "")),
        });
      }
      await insertAudit(tx, { actorUserId: p.userId, action: "mfa.enrolled",
        entityType: "mfa_factor", entityId: p.userId });
      const otpauth = `otpauth://totp/Portal:${encodeURIComponent(p.email)}?secret=${secret}&issuer=Portal`;
      return { secret, otpauthUrl: otpauth, recoveryCodes };
    });
  }

  /**
   * Recovery-code step-up (review-2 #5): consumes ONE code and marks the
   * session MFA-verified. Codes are single-use; a lost phone is no longer a
   * permanent lockout, and an admin reset (POST /users/:id/mfa-reset) remains
   * the last resort.
   */
  async recoveryVerify(p: Principal, code: string, meta: { ip?: string; ua?: string }) {
    const normalized = code.replace(/[\s-]/g, "").toLowerCase();
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select().from(mfaRecoveryCodes)
        .where(and(eq(mfaRecoveryCodes.userId, p.userId),
          eq(mfaRecoveryCodes.codeHash, sha(normalized)))).limit(1);
      if (!row || row.usedAt) {
        throw new UnauthorizedException({ code: "recovery_code_invalid",
          title: "Recovery code invalid or already used" });
      }
      await tx.update(mfaRecoveryCodes).set({ usedAt: new Date() })
        .where(eq(mfaRecoveryCodes.id, row.id));
      await tx.update(sessions).set({ mfaVerifiedAt: new Date() })
        .where(eq(sessions.id, p.sessionId));
      await insertAudit(tx, { actorUserId: p.userId, action: "mfa.recovery_used",
        entityType: "mfa_factor", entityId: p.userId, ip: meta.ip, userAgent: meta.ua });
      return { mfaVerified: true };
    });
  }

  /**
   * Admin MFA reset (review-2 #5): clears a user's factors + recovery codes so
   * they can re-enroll with a fresh token. Hierarchy-checked upstream.
   */
  async adminMfaReset(admin: Principal, targetUserId: string) {
    return withActor(this.db, SERVICE, async (tx) => {
      const [target] = await tx.select({ id: users.id }).from(users)
        .where(eq(users.id, targetUserId)).limit(1);
      if (!target) throw new NotFoundException({ code: "user_not_found" });
      const targetRoles = await tx.select({ roleCode: userRoles.roleCode }).from(userRoles)
        .where(and(eq(userRoles.userId, targetUserId), isNull(userRoles.revokedAt)));
      assertCanGrant(admin.activeRole, targetRoles.map((r) => r.roleCode));
      const factors = await tx.delete(mfaFactors)
        .where(eq(mfaFactors.userId, targetUserId)).returning({ id: mfaFactors.id });
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, targetUserId));
      await tx.update(users).set({ mfaLastCounter: null }).where(eq(users.id, targetUserId));
      await insertAudit(tx, { actorUserId: admin.userId, action: "mfa.admin_reset",
        entityType: "user", entityId: targetUserId, after: { factorsRemoved: factors.length } });
      return { ok: true, factorsRemoved: factors.length };
    });
  }

  /** Admin-issued, single-use MFA enrollment token (controlled enrollment). */
  async issueMfaEnrollToken(admin: Principal, targetUserId: string) {
    return withActor(this.db, SERVICE, async (tx) => {
      const [target] = await tx.select({ id: users.id, email: users.email }).from(users)
        .where(eq(users.id, targetUserId)).limit(1);
      if (!target) throw new NotFoundException({ code: "user_not_found" });
      // review-2 #1: no MFA lifecycle actions on users above the caller's tier
      const targetRoles = await tx.select({ roleCode: userRoles.roleCode }).from(userRoles)
        .where(and(eq(userRoles.userId, targetUserId), isNull(userRoles.revokedAt)));
      assertCanGrant(admin.activeRole, targetRoles.map((r) => r.roleCode));
      const token = randomBytes(24).toString("base64url");
      await tx.insert(mfaEnrollTokens).values({
        id: randomUUID(), userId: targetUserId, tokenHash: sha(token),
        expiresAt: new Date(Date.now() + ENROLL_TTL_MS), createdBy: admin.userId,
      });
      await enqueue(tx, { recipientUserId: targetUserId, channel: "email",
        kind: "mfa_enroll_token", payload: { token, expiresHours: ENROLL_TTL_MS / 3_600_000 } });
      await insertAudit(tx, { actorUserId: admin.userId, action: "mfa.enroll_token_issued",
        entityType: "user", entityId: targetUserId });
      return { token, expiresAt: new Date(Date.now() + ENROLL_TTL_MS).toISOString() };
    });
  }

  async totpVerify(p: Principal, code: string, meta: { ip?: string; ua?: string }) {
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, p.userId)).limit(1);
      const factors = await tx.select().from(mfaFactors)
        .where(and(eq(mfaFactors.userId, p.userId), eq(mfaFactors.kind, "totp")));
      let matched: string | null = null;
      let counter = -1;
      for (const f of factors) {
        const c = verifyTotpCounter(decryptText(f.secretEnc), code);
        if (c >= 0) { matched = f.id; counter = c; break; }
      }
      if (!matched) {
        throw new UnauthorizedException({ code: "totp_invalid", title: "Invalid code" });
      }
      // Replay protection: a time-step at or below the last accepted one is a
      // reused code (RFC 6238 §5.2 RECOMMENDED).
      if (user?.mfaLastCounter != null && counter <= user.mfaLastCounter) {
        throw new UnauthorizedException({ code: "totp_replayed", title: "Code already used" });
      }
      await tx.update(users).set({ mfaLastCounter: counter }).where(eq(users.id, p.userId));
      await tx.update(mfaFactors).set({ lastUsedAt: new Date() }).where(eq(mfaFactors.id, matched));
      await tx.update(sessions).set({ mfaVerifiedAt: new Date() })
        .where(eq(sessions.id, p.sessionId));
      await insertAudit(tx, { actorUserId: p.userId, action: "mfa.verified", entityType: "mfa_factor",
        entityId: matched, ip: meta.ip, userAgent: meta.ua });
      return { mfaVerified: true };
    });
  }

  async logout(p: Principal) {
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, p.sessionId));
      await insertAudit(tx, { actorUserId: p.userId, action: "auth.logout" });
      return { ok: true };
    });
  }

  async switchRole(p: Principal, role: string) {
    if (!p.roles.includes(role)) {
      throw new ForbiddenException({ code: "role_not_held", detail: `you do not hold ${role}` });
    }
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      await tx.update(sessions).set({ activeRole: role }).where(eq(sessions.id, p.sessionId));
      const perms = await tx.select().from(rolePermissions).where(eq(rolePermissions.roleCode, role));
      await insertAudit(tx, { actorUserId: p.userId, action: "auth.role_switch", after: { role } });
      return { activeRole: role, permissions: perms.map((r) => r.permission) };
    });
  }

  /* ── account lifecycle (production review blocker #7) ── */

  /**
   * Forgot-password: always 202 (no account enumeration). If the email exists,
   * a single-use 1 h token is created and emailed through the outbox.
   */
  async forgotPassword(email: string, meta: { ip?: string; ua?: string }): Promise<{ ok: true }> {
    await withActor(this.db, SERVICE, async (tx) => {
      const [user] = await tx.select({ id: users.id }).from(users)
        .where(and(eq(sql`lower(${users.email})`, email.toLowerCase()),
          eq(users.status, "active"))).limit(1);
      if (!user) return;
      const token = randomBytes(24).toString("base64url");
      await tx.insert(passwordResetTokens).values({
        id: randomUUID(), userId: user.id, tokenHash: sha(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
      await enqueue(tx, { recipientUserId: user.id, channel: "email",
        kind: "password_reset",
        payload: { link: `${config.publicWebOrigin}/reset?token=${token}` } });
      await insertAudit(tx, { actorUserId: user.id, action: "auth.password_forgot", ip: meta.ip });
    });
    return { ok: true };
  }

  /** Reset with a valid token: sets the password, revokes every session. */
  async resetPassword(token: string, newPassword: string, meta: { ip?: string; ua?: string }) {
    try { assertPasswordPolicy(newPassword); }
    catch (e) {
      if (e instanceof PasswordPolicyError) {
        throw new HttpException({ code: "password_policy", title: "Password too weak",
          status: 400, detail: e.detail }, HttpStatus.BAD_REQUEST);
      }
      throw e;
    }
    return withActor(this.db, SERVICE, async (tx) => {
      const [tok] = await tx.select().from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, sha(token))).limit(1);
      if (!tok || tok.usedAt || tok.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedException({ code: "reset_token_invalid",
          title: "Reset link invalid or expired" });
      }
      await tx.update(users).set({
        passwordHash: await hashPassword(newPassword),
        failedLoginCount: 0, lockedUntil: null, updatedAt: new Date(),
      }).where(eq(users.id, tok.userId));
      await tx.update(passwordResetTokens).set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, tok.id));
      await tx.update(sessions).set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, tok.userId), isNull(sessions.revokedAt)));
      await insertAudit(tx, { actorUserId: tok.userId, action: "auth.password_reset", ip: meta.ip });
      return { ok: true };
    });
  }

  /** Authenticated self-service password change; other sessions are revoked. */
  async changePassword(p: Principal, currentPassword: string, newPassword: string) {
    try { assertPasswordPolicy(newPassword); }
    catch (e) {
      if (e instanceof PasswordPolicyError) {
        throw new HttpException({ code: "password_policy", title: "Password too weak",
          status: 400, detail: e.detail }, HttpStatus.BAD_REQUEST);
      }
      throw e;
    }
    return withActor(this.db, SERVICE, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, p.userId)).limit(1);
      if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
        throw new UnauthorizedException({ code: "invalid_credentials",
          title: "Current password incorrect" });
      }
      await tx.update(users).set({ passwordHash: await hashPassword(newPassword),
        mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, p.userId));
      await tx.update(sessions).set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, p.userId), isNull(sessions.revokedAt),
          sql`${sessions.id} <> ${p.sessionId}`));
      await insertAudit(tx, { actorUserId: p.userId, action: "auth.password_changed" });
      return { ok: true };
    });
  }

  /** Admin issues an invite; the user sets their own password on accept. */
  async issueInvite(admin: Principal, b: { email: string; display_name: string; roles: string[];
    grade_level?: number; admission_no?: string }) {
    // review-2 #1: a caller may never invite roles above their own tier
    assertCanGrant(admin.activeRole, b.roles);
    return withActor(this.db, SERVICE, async (tx) => {
      const [dupe] = await tx.select({ id: users.id }).from(users)
        .where(eq(sql`lower(${users.email})`, b.email.toLowerCase())).limit(1);
      if (dupe) throw new ConflictException({ code: "email_taken", detail: b.email });
      // review-4 #5: a PENDING invite (unaccepted + unexpired) still blocks a
      // duplicate. An unaccepted but expired/revoked one does NOT: the DB's
      // partial unique index (user_invites_open_uq) claims one unaccepted row
      // per email, so we REUSE that row (fresh token/roles/expiry) instead of
      // inserting a second — history stays in the audit log.
      const [openInvite] = await tx.select({ id: userInvites.id, expiresAt: userInvites.expiresAt })
        .from(userInvites)
        .where(and(eq(sql`lower(${userInvites.email})`, b.email.toLowerCase()),
          isNull(userInvites.acceptedAt))).limit(1);
      if (openInvite && openInvite.expiresAt.getTime() > Date.now()) {
        throw new ConflictException({ code: "invite_exists", detail: b.email });
      }
      for (const r of b.roles) {
        const [role] = await tx.select({ code: rolePermissions.roleCode }).from(rolePermissions)
          .where(eq(rolePermissions.roleCode, r)).limit(1);
        if (!role) throw new HttpException({ code: "unknown_role", detail: r, status: 422 },
          HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const token = randomBytes(24).toString("base64url");
      let inviteId: string = randomUUID();
      if (openInvite) {
        inviteId = openInvite.id;
        await tx.update(userInvites).set({
          displayName: b.display_name, roleCodes: JSON.stringify(b.roles),
          tokenHash: sha(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          gradeLevel: b.grade_level ?? null, admissionNo: b.admission_no?.toUpperCase() ?? null,
          createdBy: admin.userId,
        }).where(eq(userInvites.id, inviteId));
      } else {
        await tx.insert(userInvites).values({
          id: inviteId, email: b.email, displayName: b.display_name,
          roleCodes: JSON.stringify(b.roles), tokenHash: sha(token),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          gradeLevel: b.grade_level ?? null, admissionNo: b.admission_no?.toUpperCase() ?? null,
          createdBy: admin.userId,
        });
      }
      await insertAudit(tx, { actorUserId: admin.userId, action: "user.invited",
        entityType: "invite", entityId: inviteId, after: { email: b.email, roles: b.roles } });
      // review-2 #6: enqueue the invite email (bare-email recipient — no user row yet)
      const acceptUrl = `${config.publicWebOrigin}/invite?token=${token}`;
      await enqueue(tx, { recipientEmail: b.email, channel: "email", kind: "user_invite",
        payload: { display_name: b.display_name, acceptUrl, roles: b.roles } });
      // review-3 #6: the accept link is a password-setting credential. With
      // SMTP configured it travels to the invitee by email ONLY — returning it
      // to the admin would let any directory:write caller accept their own
      // invite and take over the account. Without SMTP (dev sink) there is no
      // other channel, so the API surfaces it for local/dev flows.
      if (process.env.SMTP_URL) {
        return { inviteId, email: b.email, delivery: "email" as const };
      }
      return { inviteId, inviteToken: token, email: b.email, acceptUrl };
    });
  }

  /** review-4 #5: pending invites, so admins can see (and unstick) them. */
  async listInvites(caller: Principal) {
    return withActor(this.db, SERVICE, async (tx) => {
      const rows = await tx.select({
        id: userInvites.id, email: userInvites.email, displayName: userInvites.displayName,
        roleCodes: userInvites.roleCodes, createdAt: userInvites.createdAt,
        expiresAt: userInvites.expiresAt,
      }).from(userInvites)
        .where(and(isNull(userInvites.acceptedAt), gt(userInvites.expiresAt, new Date())))
        .limit(100);
      void caller; // directory:read is enforced by the route guard
      return { data: rows.map((r) => ({ ...r, roles: JSON.parse(r.roleCodes) })) };
    });
  }

  /**
   * review-4 #5: resend an invite — rotates the token (the old link dies),
   * extends the TTL and re-queues the email. Fixes typo'd/failed deliveries
   * without the admin having to revoke+recreate. Same tier rules as issuing.
   */
  async resendInvite(admin: Principal, inviteId: string) {
    return withActor(this.db, SERVICE, async (tx) => {
      // pending only — resend must not resurrect a revoked/expired invite
      // (create a fresh one instead)
      const [inv] = await tx.select().from(userInvites)
        .where(and(eq(userInvites.id, inviteId), isNull(userInvites.acceptedAt),
          gt(userInvites.expiresAt, new Date()))).limit(1);
      if (!inv) throw new NotFoundException({ code: "not_found" });
      const roles = JSON.parse(inv.roleCodes) as string[];
      assertCanGrant(admin.activeRole, roles); // can't resend above your tier
      const token = randomBytes(24).toString("base64url");
      await tx.update(userInvites)
        .set({ tokenHash: sha(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
        .where(eq(userInvites.id, inviteId));
      await insertAudit(tx, { actorUserId: admin.userId, action: "invite.resent",
        entityType: "invite", entityId: inviteId, after: { email: inv.email, roles } });
      const acceptUrl = `${config.publicWebOrigin}/invite?token=${token}`;
      await enqueue(tx, { recipientEmail: inv.email, channel: "email", kind: "user_invite",
        payload: { display_name: inv.displayName, acceptUrl, roles } });
      // review-3 #6 rule holds: token only leaves the API when SMTP is off
      if (process.env.SMTP_URL) return { email: inv.email, delivery: "email" as const };
      return { inviteToken: token, email: inv.email, acceptUrl };
    });
  }

  /** review-4 #5: revoke a pending invite (expiry — keeps the audit trail). */
  async revokeInvite(admin: Principal, inviteId: string) {
    return withActor(this.db, SERVICE, async (tx) => {
      const [inv] = await tx.select().from(userInvites)
        .where(and(eq(userInvites.id, inviteId), isNull(userInvites.acceptedAt))).limit(1);
      if (!inv) throw new NotFoundException({ code: "not_found" });
      // review-5 #2: same tier rule as resend/issue — a registrar must not be
      // able to revoke a school_admin's invite
      const roles = JSON.parse(inv.roleCodes) as string[];
      assertCanGrant(admin.activeRole, roles);
      await tx.update(userInvites).set({ expiresAt: new Date() })
        .where(eq(userInvites.id, inviteId));
      await insertAudit(tx, { actorUserId: admin.userId, action: "invite.revoked",
        entityType: "invite", entityId: inviteId, after: { email: inv.email } });
      return { ok: true, revoked: inv.email };
    });
  }

  /** Invitee sets their own password — admins never see or set passwords. */
  async acceptInvite(token: string, password: string, meta: { ip?: string; ua?: string }) {
    try { assertPasswordPolicy(password); }
    catch (e) {
      if (e instanceof PasswordPolicyError) {
        throw new HttpException({ code: "password_policy", title: "Password too weak",
          status: 400, detail: e.detail }, HttpStatus.BAD_REQUEST);
      }
      throw e;
    }
    return withActor(this.db, SERVICE, async (tx) => {
      const [inv] = await tx.select().from(userInvites)
        .where(eq(userInvites.tokenHash, sha(token))).limit(1);
      if (!inv || inv.acceptedAt || inv.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedException({ code: "invite_invalid",
          title: "Invite invalid or expired" });
      }
      const [dupe] = await tx.select({ id: users.id }).from(users)
        .where(eq(sql`lower(${users.email})`, inv.email.toLowerCase())).limit(1);
      if (dupe) throw new ConflictException({ code: "email_taken", detail: inv.email });
      const id = randomUUID();
      await tx.insert(users).values({ id, email: inv.email, displayName: inv.displayName,
        passwordHash: await hashPassword(password), status: "active" });
      await tx.insert(identities).values({ userId: id, provider: "local", subject: inv.email });
      const roleCodes: string[] = JSON.parse(inv.roleCodes);
      for (const r of roleCodes) {
        await tx.insert(userRoles).values({ id: randomUUID(), userId: id, roleCode: r });
      }
      // phase 6: an invited student must land WITH a students row, or they
      // can't be enrolled, invoiced or shown to a parent
      if (roleCodes.includes("student")) {
        // review-6 #4: grade/admission come from the INVITE only. Invitee-supplied
        // values used to be a fallback — a made-up admission number would later
        // collide with the real one and get the real CSV row skipped as duplicate.
        const grade = inv.gradeLevel;
        if (!grade) {
          throw new HttpException({ code: "grade_level_required", status: 422,
            title: "Grade level required",
            detail: "the admin must set grade_level when issuing the invite" },
            HttpStatus.UNPROCESSABLE_ENTITY);
        }
        let admissionNo = (inv.admissionNo ?? "").trim().toUpperCase();
        if (admissionNo) {
          const [taken] = await tx.select({ userId: students.userId }).from(students)
            .where(eq(students.admissionNo, admissionNo)).limit(1);
          if (taken) throw new ConflictException({ code: "admission_no_taken", detail: admissionNo });
        } else {
          const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(students);
          admissionNo = `STU-${String(n + 1).padStart(4, "0")}`;
          while (true) {
            const [taken] = await tx.select({ userId: students.userId }).from(students)
              .where(eq(students.admissionNo, admissionNo!)).limit(1);
            if (!taken) break;
            admissionNo = `STU-${String(Number(admissionNo.slice(4)) + 1).padStart(4, "0")}`;
          }
        }
        await tx.insert(students).values({ userId: id, admissionNo, gradeLevel: grade });
      }
      await tx.update(userInvites).set({ acceptedAt: new Date() })
        .where(eq(userInvites.id, inv.id));
      await insertAudit(tx, { actorUserId: id, action: "user.invite_accepted",
        entityType: "user", entityId: id, ip: meta.ip });
      return { ok: true, email: inv.email };
    });
  }

  /** used by seed & tests */
  static hashPassword = hashPassword;

  /**
   * Phase 5.3 — SSO (OIDC authorization-code).
   * The id_token was signature-verified by sso.service BEFORE this call.
   * Identity link → user resolution (link-by-email or JIT) → session issuance.
   * Runs as SERVICE because identities_* policies are service-only.
   */
  /**
   * review-3 #3 (nOAuth): `allowEmailLink` must be false for providers whose
   * id_tokens lack a verified-email guarantee (Entra). With it false, a
   * federated identity may ONLY (a) match an already-linked provider subject
   * (oid:tid) or (b) JIT-provision a BRAND-NEW account — it can never claim
   * an existing directory account just by asserting its email. Otherwise an
   * attacker who can set an unverified email claim to a staff address owns
   * that account. Email linking stays available for providers that DO verify
   * (email_verified=true enforced in verifyIdToken), e.g. Google.
   */
  async ssoLogin(provider: string, claims: { sub: string; email: string; name?: string },
                 jitRole: string | undefined, meta: { ip?: string; ua?: string },
                 opts?: { allowEmailLink?: boolean }) {
    const allowEmailLink = opts?.allowEmailLink !== false;
    return withActor(this.db, SERVICE, async (tx) => {
      let userId: string | null = null;
      const [ident] = await tx.select().from(identities)
        .where(and(eq(identities.provider, provider), eq(identities.subject, claims.sub))).limit(1);
      if (ident) {
        userId = ident.userId;
        await tx.update(identities).set({ lastSeenAt: new Date(), emailSnapshot: claims.email })
          .where(and(eq(identities.provider, provider), eq(identities.subject, claims.sub)));
      } else {
        const [byEmail] = await tx.select().from(users)
          .where(eq(sql`lower(${users.email})`, claims.email.toLowerCase())).limit(1);
        if (byEmail && allowEmailLink) {
          userId = byEmail.id; // verified-email provider → safe to link the identity
        } else if (jitRole && !byEmail) {
          // JIT only for emails NOT already in the directory — creating a
          // second account over an existing email would collide anyway, and
          // linking is exactly what the nOAuth guard forbids here.
          const [created] = await tx.insert(users).values({
            email: claims.email, displayName: claims.name ?? claims.email.split("@")[0],
          }).returning();
          userId = created.id;
          await tx.insert(userRoles).values({ id: randomUUID(), userId, roleCode: jitRole });
        }
        if (!userId) {
          if (byEmail && !allowEmailLink) {
            // review-4 #4: the account EXISTS but the provider can't prove
            // mailbox ownership — offer password-proven linking instead of a
            // dead end. The controller turns err.ssoLink into a redirect to
            // /login?sso_error=sso_link_required&link_token=…
            const err: any = new ForbiddenException({ code: "sso_link_required",
              title: "Sign-in not linked yet",
              detail: "Confirm your portal password once to link this work sign-in to your account" });
            err.ssoLink = { provider, sub: claims.sub, email: claims.email };
            throw err;
          }
          throw new ForbiddenException({ code: "sso_user_not_provisioned",
            title: "No portal account is linked to this identity",
            detail: "Ask your administrator to create your account first" });
        }
        await tx.insert(identities).values({
          userId, provider, subject: claims.sub, emailSnapshot: claims.email, lastSeenAt: new Date(),
        });
      }
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user || user.status !== "active") {
        throw new UnauthorizedException({ code: "account_inactive", title: "Account is not active" });
      }
      const roleRows = await tx.select().from(userRoles)
        .where(and(eq(userRoles.userId, user.id), isNull(userRoles.revokedAt)));
      const roles = roleRows.map((r) => r.roleCode);
      if (roles.length === 0) {
        throw new ForbiddenException({ code: "no_roles", title: "Account has no portal role" });
      }
      const token = randomBytes(32).toString("base64url");
      await tx.insert(sessions).values({
        id: randomUUID(), userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        activeRole: defaultActiveRole(roles), amr: JSON.stringify([`sso:${provider}`]),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        ip: meta.ip ?? null, userAgent: meta.ua ?? null,
      });
      await insertAudit(tx, { actorUserId: user.id, action: "auth.sso_login", entityType: "session",
        after: { provider, sub: claims.sub }, ip: meta.ip, userAgent: meta.ua });
      return { token, userId: user.id, email: user.email, roles,
        activeRole: defaultActiveRole(roles) };
    });
  }

  /**
   * review-4 #4: password-proven linking of a federated identity to an
   * EXISTING portal account (the Entra path — no email_verified claim, so
   * never auto-link). The link_token was issued by the SSO callback and
   * binds provider+sub+email; the caller must know the account's password.
   * Staff still face the normal MFA gate afterwards (session middleware).
   */
  async ssoLink(linkToken: string, email: string, password: string,
                meta: { ip?: string; ua?: string }) {
    let claims: { provider: string; sub: string; email: string };
    try { claims = verifyLinkToken(linkToken); }
    catch {
      throw new ForbiddenException({ code: "link_token_invalid",
        title: "Link session expired",
        detail: "Start the sign-in again from your work account" });
    }
    // review-5 #1: this form is a PASSWORD ORACLE aimed at exactly the accounts
    // an attacker can make the IdP assert — it must share the DB-backed login
    // lockout (counters commit even on 401, so exceptions throw AFTER commit).
    const outcome = await withActor(this.db, SERVICE, async (tx) => {
      const [user] = await tx.select().from(users)
        .where(eq(sql`lower(${users.email})`, email.toLowerCase())).limit(1);

      if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        return { kind: "locked" as const, retryAfterMs: user.lockedUntil.getTime() - Date.now() };
      }

      // the account must be the one the IdP asserted, active, and password-owned
      const credentialOk = !!user && user.status === "active" && !!user.passwordHash &&
        user.email.toLowerCase() === claims.email.toLowerCase() &&
        await verifyPassword(password, user.passwordHash);
      if (!credentialOk) {
        if (user) {
          const fails = user.failedLoginCount + 1;
          const lock = fails >= config.lockout.maxFailures;
          await tx.update(users).set({
            failedLoginCount: lock ? 0 : fails,
            lockedUntil: lock ? new Date(Date.now() + config.lockout.durationMs) : user.lockedUntil,
          }).where(eq(users.id, user.id));
          await insertAudit(tx, { actorUserId: user.id, action: "auth.login_failed",
            after: { fails, locked: lock, via: "sso-link" }, ip: meta.ip, userAgent: meta.ua });
        }
        return { kind: "invalid" as const };
      }
      // success clears the counters, exactly like login
      if (user!.failedLoginCount > 0 || user!.lockedUntil) {
        await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null })
          .where(eq(users.id, user!.id));
      }
      const [existing] = await tx.select().from(identities)
        .where(and(eq(identities.provider, claims.provider),
          eq(identities.subject, claims.sub))).limit(1);
      if (existing && existing.userId !== user!.id) {
        throw new ConflictException({ code: "identity_linked_elsewhere",
          title: "That work identity is already linked to another account" });
      }
      if (!existing) {
        await tx.insert(identities).values({
          userId: user!.id, provider: claims.provider, subject: claims.sub,
          emailSnapshot: claims.email, lastSeenAt: new Date(),
        });
      }
      const roleRows = await tx.select().from(userRoles)
        .where(and(eq(userRoles.userId, user!.id), isNull(userRoles.revokedAt)));
      const roles = roleRows.map((r) => r.roleCode);
      if (roles.length === 0) {
        throw new ForbiddenException({ code: "no_roles", title: "Account has no portal role" });
      }
      const token = randomBytes(32).toString("base64url");
      await tx.insert(sessions).values({
        id: randomUUID(), userId: user!.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        activeRole: defaultActiveRole(roles),
        amr: JSON.stringify(["pwd", `sso-link:${claims.provider}`]),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        ip: meta.ip ?? null, userAgent: meta.ua ?? null,
      });
      await insertAudit(tx, { actorUserId: user!.id, action: "auth.sso_linked",
        entityType: "identity", after: { provider: claims.provider, sub: claims.sub },
        ip: meta.ip, userAgent: meta.ua });
      return { kind: "ok" as const, token, userId: user!.id, email: user!.email, roles,
        activeRole: defaultActiveRole(roles) };
    });

    if (outcome.kind === "locked") {
      throw new HttpException(
        { code: "account_locked", title: "Account temporarily locked",
          status: 423, detail: "Too many failed sign-in attempts",
          retryAfterMs: outcome.retryAfterMs },
        HttpStatus.LOCKED);
    }
    if (outcome.kind === "invalid") {
      throw new UnauthorizedException({ code: "invalid_credentials", title: "Invalid credentials" });
    }
    const { kind: _kind, ...result } = outcome;
    return result;
  }
}
