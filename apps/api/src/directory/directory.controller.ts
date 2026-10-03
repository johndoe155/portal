import {
  Body, ConflictException, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException,
  Param, Patch, Post, Query, Req, UnauthorizedException, UnprocessableEntityException,
} from "@nestjs/common";
import { eq, sql, and, isNull } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import {
  users, students, userRoles, identities, roles, sessions, enrollments, grades,
  attendanceRecords, feeInvoices, feePayments, messageThreads, messages,
  notifications, auditLog, transportAssignments, guardians,
} from "../db/schema";
import { Perm, ParentWrite } from "../common/guards";
import { insertAudit } from "../common/audit";
import { assertCanGrant } from "../common/role-policy";
import { hashPassword, assertPasswordPolicy, PasswordPolicyError } from "../crypto/password";
import { UserCreateBody, RoleGrantBody, IssueInviteBody, StudentPatchBody, GuardianLinkBody, GuardianConfirmBody } from "@portal/contracts";
import { AuthService } from "../auth/auth.service";
import { enqueue } from "../notify/notify.service";
import { buildOffboardPreview, deactivateUser, reactivateUser } from "./offboard.service";
import { config } from "../config";
import type { Request } from "express";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

@Controller()
export class DirectoryController {
  constructor(@Inject(DB_TOKEN) private db: Db, private auth: AuthService) {}

  /**
   * Invite flow (production review blocker #7): admins never set or see
   * passwords. The invitee receives a single-use link and chooses their own
   * password via POST /auth/invite/accept.
   */
  @Post("invites")
  @Perm("directory:write")
  issueInvite(@Body() body: unknown, @Req() req: Request) {
    const parsed = IssueInviteBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    return this.auth.issueInvite(req.principal!, parsed.data);
  }

  /** review-4 #5: visibility into pending invites (the unstick path). */
  @Get("invites")
  @Perm("directory:read")
  listInvites(@Req() req: Request) {
    return this.auth.listInvites(req.principal!);
  }

  /** review-4 #5: rotate token + re-send (typo'd email, failed delivery). */
  @Post("invites/:id/resend")
  @Perm("directory:write")
  resendInvite(@Param("id") id: string, @Req() req: Request) {
    return this.auth.resendInvite(req.principal!, id);
  }

  /** review-4 #5: revoke a pending invite. */
  @Post("invites/:id/revoke")
  @Perm("directory:write")
  revokeInvite(@Param("id") id: string, @Req() req: Request) {
    return this.auth.revokeInvite(req.principal!, id);
  }

  /** Admin-issued single-use MFA enrollment token (controlled TOTP setup). */
  @Post("users/:id/mfa-enroll-token")
  @Perm("directory:write")
  issueMfaEnrollToken(@Param("id") id: string, @Req() req: Request) {
    return this.auth.issueMfaEnrollToken(req.principal!, id);
  }

  /** Admin MFA reset (review-2 #5): clears factors so the user can re-enroll. */
  @Post("users/:id/mfa-reset")
  @Perm("directory:write")
  mfaReset(@Param("id") id: string, @Req() req: Request) {
    return this.auth.adminMfaReset(req.principal!, id);
  }

  @Get("users")
  @Perm("directory:read")
  async listUsers(@Req() req: Request, @Query("page") page = "1", @Query("per") per = "25",
                  @Query("q") q?: string) {
    const p = req.principal!;
    const limit = Math.min(Number(per) || 25, 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
    // Paging through 600 accounts to find one person is not a workflow.
    const term = (q ?? "").trim();
    const where = term
      ? sql`(${users.displayName} ilike ${"%" + term + "%"} or ${users.email} ilike ${"%" + term + "%"})`
      : undefined;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const base = tx.select({
        id: users.id, email: users.email, displayName: users.displayName, status: users.status,
      }).from(users);
      const rows = await (where ? base.where(where) : base)
        .orderBy(users.displayName).limit(limit).offset(offset);
      const countQ = tx.select({ total: sql<number>`count(*)::int` }).from(users);
      const [{ total }] = await (where ? countQ.where(where) : countQ);
      return { data: rows, meta: { page: Number(page) || 1, per: limit, total, q: term || null } };
    });
  }

  @Get("students/:id")
  @Perm("directory:read")
  async studentProfile(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [row] = await tx.select({
        userId: students.userId, admissionNo: students.admissionNo,
        gradeLevel: students.gradeLevel, status: students.status,
        displayName: users.displayName, email: users.email,
      }).from(students).innerJoin(users, eq(users.id, students.userId))
        .where(and(eq(students.userId, id))).limit(1);
      if (!row) throw new NotFoundException({ code: "not_found" });
      return row;
    });
  }

  @Get("users/:id/roles")
  @Perm("roles:read")
  async userRoles(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(userRoles).where(eq(userRoles.userId, id));
      return { data: rows };
    });
  }

  /**
   * Offboarding preview — everything deactivation will affect, BEFORE it
   * happens. A registrar clicking "deactivate" on a teacher needs to know
   * they are about to leave four classes without anyone able to mark the
   * register; finding that out afterwards is how a term falls apart.
   */
  @Get("users/:id/offboard-preview")
  @Perm("directory:write")
  async offboardPreview(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    const preview = await withActor(this.db, SERVICE, (tx) => buildOffboardPreview(tx, id, p.userId));
    if (!preview) throw new NotFoundException({ code: "not_found", title: "No such user" });
    return preview;
  }

  /**
   * Deactivate (offboard) a user. Reversible: history is retained, access is
   * not. See offboard.service.ts for exactly what is revoked.
   */
  @Post("users/:id/deactivate")
  @Perm("directory:write")
  async deactivate(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = req.principal!;
    const b = (body ?? {}) as { reason?: string; end_guardian_links?: boolean; mode?: string };
    return withActor(this.db, SERVICE, async (tx) => {
      const preview = await buildOffboardPreview(tx, id, p.userId);
      if (!preview) throw new NotFoundException({ code: "not_found", title: "No such user" });
      if (preview.blockers.length) {
        throw new UnprocessableEntityException({
          code: "deactivation_blocked",
          title: "This account cannot be deactivated",
          detail: preview.blockers.join(" "),
        });
      }
      const result = await deactivateUser(tx, id, { userId: p.userId, role: p.activeRole }, {
        reason: typeof b.reason === "string" ? b.reason : undefined,
        // Ending guardian links is the right default for a leaver, but it is
        // destructive for a parent deactivated by mistake, so it is explicit.
        endGuardianLinks: b.end_guardian_links === true,
        mode: b.mode === "suspended" ? "suspended" : "left",
      });
      return { ...result, warnings: preview.warnings };
    });
  }

  /** Undo a deactivation, restoring exactly the roles it revoked. */
  @Post("users/:id/reactivate")
  @Perm("directory:write")
  async reactivate(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = req.principal!;
    const b = (body ?? {}) as { reason?: string };
    return withActor(this.db, SERVICE, async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
      if (!u) throw new NotFoundException({ code: "not_found", title: "No such user" });
      if (u.status === "active") {
        throw new UnprocessableEntityException({
          code: "already_active", title: "This account is already active",
        });
      }
      return reactivateUser(tx, id, { userId: p.userId, role: p.activeRole },
        { reason: typeof b.reason === "string" ? b.reason : undefined });
    });
  }

  /** registrar lookup by admission number (enrollment UX) */
  @Get("students-lookup")
  @Perm("directory:read")
  async lookup(@Req() req: Request, @Query("admission_no") admissionNo: string) {
    if (!admissionNo) throw new UnprocessableEntityException({ code: "validation", detail: "admission_no required" });
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [row] = await tx.select({
        userId: students.userId, admissionNo: students.admissionNo,
        gradeLevel: students.gradeLevel, displayName: users.displayName,
      }).from(students).innerJoin(users, eq(users.id, students.userId))
        .where(eq(students.admissionNo, admissionNo.toUpperCase())).limit(1);
      if (!row) throw new NotFoundException({ code: "not_found" });
      return row;
    });
  }

  /** Phase 5.3: admin creates accounts. identities_* is service-only in RLS,
   *  so the write transaction runs as SERVICE after the capability gate. */
  @Post("users")
  @Perm("directory:write")
  async createUser(@Req() req: Request, @Body() body: unknown) {
    const parsed = UserCreateBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    const b = parsed.data;
    // review-2 #1: no account may be minted above the caller's tier
    assertCanGrant(p.activeRole, b.roles);
    // review-2 #6: admin-set temporary passwords meet the same policy as self-set
    try { assertPasswordPolicy(b.password); }
    catch (e) {
      if (e instanceof PasswordPolicyError) {
        throw new UnprocessableEntityException({ code: "password_policy", detail: e.detail });
      }
      throw e;
    }
    const out = await withActor(this.db, SERVICE, async (tx) => {
      const [dupe] = await tx.select({ id: users.id }).from(users)
        .where(eq(sql`lower(${users.email})`, b.email.toLowerCase())).limit(1);
      if (dupe) throw new ConflictException({ code: "email_taken", detail: b.email });
      for (const r of b.roles) {
        const [role] = await tx.select({ code: roles.code }).from(roles).where(eq(roles.code, r)).limit(1);
        if (!role) throw new UnprocessableEntityException({ code: "unknown_role", detail: r });
      }
      const [user] = await tx.insert(users).values({
        email: b.email, displayName: b.display_name, passwordHash: await hashPassword(b.password),
      }).returning({ id: users.id, email: users.email, displayName: users.displayName });
      await tx.insert(identities).values({ userId: user.id, provider: "local", subject: b.email });
      for (const r of b.roles) {
        await tx.insert(userRoles).values({ id: randomUUID(), userId: user.id, roleCode: r });
      }
      // phase 6: a student LOGIN without a students row can't be enrolled,
      // invoiced or shown to a parent — create the record in the same breath
      if (b.roles.includes("student")) {
        if (!b.grade_level) {
          throw new UnprocessableEntityException({ code: "grade_level_required",
            detail: "grade_level is required when roles include 'student'" });
        }
        let admissionNo = b.admission_no?.trim().toUpperCase();
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
        await tx.insert(students).values({
          userId: user.id, admissionNo, gradeLevel: b.grade_level,
        });
      }
      await insertAudit(tx, { actorUserId: p.userId, action: "user.created",
        entityType: "user", entityId: user.id, after: { roles: b.roles }, ip: req.ip });
      return user;
    });
    return out;
  }

  /* ── phase 6: student records ── */

  @Get("students")
  @Perm("directory:read")
  async listStudents(@Req() req: Request, @Query("page") page = "1", @Query("per") per = "25",
                     @Query("q") q = "") {
    const p = req.principal!;
    const limit = Math.min(Number(per) || 25, 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
    const needle = `%${(q ?? "").toLowerCase()}%`;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select({
        userId: students.userId, admissionNo: students.admissionNo,
        gradeLevel: students.gradeLevel, status: students.status,
        email: users.email, displayName: users.displayName,
      }).from(students).innerJoin(users, eq(users.id, students.userId))
        .where(sql`lower(${users.displayName}) LIKE ${needle} OR lower(${students.admissionNo}) LIKE ${needle}`)
        .limit(limit).offset(offset);
      const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(students);
      return { data: rows, meta: { page: Number(page) || 1, per: limit, total } };
    });
  }

  @Patch("students/:id")
  @Perm("directory:write")
  async updateStudent(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = StudentPatchBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const b = parsed.data;
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [stu] = await tx.select().from(students).where(eq(students.userId, id)).limit(1);
      if (!stu) throw new NotFoundException({ code: "not_found" });
      if (b.admission_no) {
        const admissionNo = b.admission_no.trim().toUpperCase();
        const [taken] = await tx.select({ userId: students.userId }).from(students)
          .where(and(eq(students.admissionNo, admissionNo), sql`${students.userId} <> ${id}`)).limit(1);
        if (taken) throw new ConflictException({ code: "admission_no_taken", detail: admissionNo });
        await tx.update(students).set({ admissionNo }).where(eq(students.userId, id));
      }
      if (b.grade_level) {
        await tx.update(students).set({ gradeLevel: b.grade_level }).where(eq(students.userId, id));
      }
      if (b.status) {
        await tx.update(students).set({ status: b.status }).where(eq(students.userId, id));
      }
      await insertAudit(tx, { actorUserId: p.userId, action: "student.updated",
        entityType: "student", entityId: id, after: b, ip: req.ip });
      const [fresh] = await tx.select().from(students).where(eq(students.userId, id)).limit(1);
      return fresh;
    });
  }

  /* ── phase 6: guardian links with verification ── */

  @Get("students/:id/guardians")
  @Perm("directory:read")
  async listGuardians(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select({
        id: guardians.id, relationship: guardians.relationship,
        verifiedAt: guardians.verifiedAt, endedAt: guardians.endedAt,
        email: users.email, displayName: users.displayName,
      }).from(guardians).innerJoin(users, eq(users.id, guardians.userId))
        .where(eq(guardians.studentUserId, id));
      return { data: rows };
    });
  }

  @Post("students/:id/guardians")
  @Perm("directory:write")
  async linkGuardian(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = GuardianLinkBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const b = parsed.data;
    const p = req.principal!;
    const out = await withActor(this.db, SERVICE, async (tx) => {
      const [stu] = await tx.select({ userId: students.userId }).from(students)
        .where(eq(students.userId, id)).limit(1);
      if (!stu) throw new NotFoundException({ code: "not_found" });
      const [guardian] = await tx.select({ id: users.id, displayName: users.displayName }).from(users)
        .where(eq(sql`lower(${users.email})`, b.guardian_email.toLowerCase())).limit(1);
      if (!guardian) {
        throw new UnprocessableEntityException({ code: "guardian_not_found",
          detail: "no account with that email — invite the parent first (roles: [parent])" });
      }
      const [dupe] = await tx.select({ id: guardians.id }).from(guardians)
        .where(and(eq(guardians.studentUserId, id), eq(guardians.userId, guardian.id))).limit(1);
      if (dupe) throw new ConflictException({ code: "link_exists" });
      const token = randomBytes(24).toString("base64url");
      const [row] = await tx.insert(guardians).values({
        studentUserId: id, userId: guardian.id, relationship: b.relationship,
        verifiedAt: null, verifyTokenHash: sha(token), requestedBy: p.userId,
      }).returning({ id: guardians.id });
      await insertAudit(tx, { actorUserId: p.userId, action: "guardian.linked",
        entityType: "guardian_link", entityId: row.id,
        after: { student: id, guardian: guardian.id, relationship: b.relationship }, ip: req.ip });
      const verifyUrl = `${config.publicWebOrigin}/parent/verify?token=${token}`;
      await enqueue(tx, { recipientEmail: b.guardian_email, channel: "email",
        kind: "guardian_verify", payload: { display_name: guardian.displayName, verifyUrl } });
      // same rule as invites: the verify link leaves the API only when SMTP is off
      if (process.env.SMTP_URL) return { id: row.id, delivery: "email" as const };
      return { id: row.id, verifyToken: token, verifyUrl };
    });
    return out;
  }

  /** the guardian themself confirms the link (email-proven) — deliberate
   * parent-writable exception (like fees:pay): confirming your OWN link */
  @Post("family/guardian-verify")
  @ParentWrite()
  async guardianVerify(@Req() req: Request, @Body() body: unknown) {
    const parsed = GuardianConfirmBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select().from(guardians)
        .where(eq(guardians.verifyTokenHash, sha(parsed.data.token))).limit(1);
      if (!row || row.endedAt) {
        throw new UnauthorizedException({ code: "verify_token_invalid",
          title: "Verification link invalid or expired" });
      }
      if (row.userId !== p.userId) {
        throw new ForbiddenException({ code: "verify_wrong_account",
          title: "Sign in with the account this link was sent to" });
      }
      await tx.update(guardians)
        .set({ verifiedAt: new Date(), verifyTokenHash: null })
        .where(eq(guardians.id, row.id));
      await insertAudit(tx, { actorUserId: p.userId, action: "guardian.verified",
        entityType: "guardian_link", entityId: row.id, after: { method: "email" }, ip: req.ip });
      return { ok: true };
    });
  }

  /** office/phone verification by an admin — explicit and audited */
  @Post("guardian-links/:id/confirm")
  @Perm("directory:write")
  async guardianConfirm(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select().from(guardians).where(eq(guardians.id, id)).limit(1);
      if (!row || row.endedAt) throw new NotFoundException({ code: "not_found" });
      await tx.update(guardians)
        .set({ verifiedAt: new Date(), verifyTokenHash: null })
        .where(eq(guardians.id, id));
      await insertAudit(tx, { actorUserId: p.userId, action: "guardian.verified",
        entityType: "guardian_link", entityId: id, after: { method: "admin" }, ip: req.ip });
      return { ok: true };
    });
  }

  @Post("guardian-links/:id/revoke")
  @Perm("directory:write")
  async guardianRevoke(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select().from(guardians)
        .where(and(eq(guardians.id, id), isNull(guardians.endedAt))).limit(1);
      if (!row) throw new NotFoundException({ code: "not_found" });
      await tx.update(guardians)
        .set({ endedAt: new Date(), canView: false, verifyTokenHash: null })
        .where(eq(guardians.id, id));
      await insertAudit(tx, { actorUserId: p.userId, action: "guardian.revoked",
        entityType: "guardian_link", entityId: id, ip: req.ip });
      return { ok: true };
    });
  }

  @Post("users/:id/roles")
  @Perm("roles:write")
  async grantRole(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = RoleGrantBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    assertCanGrant(p.activeRole, [parsed.data.role_code]);
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
      if (!user) throw new NotFoundException({ code: "not_found" });
      const [active] = await tx.select({ id: userRoles.id }).from(userRoles)
        .where(and(eq(userRoles.userId, id), eq(userRoles.roleCode, parsed.data.role_code),
          isNull(userRoles.revokedAt))).limit(1);
      if (active) throw new ConflictException({ code: "role_already_granted" });
      const [row] = await tx.insert(userRoles)
        .values({ id: randomUUID(), userId: id, roleCode: parsed.data.role_code }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "role.granted",
        entityType: "user", entityId: id, after: { role: parsed.data.role_code }, ip: req.ip });
      return row;
    });
  }

  @Delete("users/:id/roles/:roleCode")
  @Perm("roles:write")
  async revokeRole(@Req() req: Request, @Param("id") id: string, @Param("roleCode") roleCode: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.update(userRoles)
        .set({ revokedAt: new Date() })
        .where(and(eq(userRoles.userId, id), eq(userRoles.roleCode, roleCode),
          isNull(userRoles.revokedAt))).returning();
      if (rows.length === 0) throw new NotFoundException({ code: "not_found" });
      await insertAudit(tx, { actorUserId: p.userId, action: "role.revoked",
        entityType: "user", entityId: id, after: { role: roleCode }, ip: req.ip });
      return { revoked: rows.length };
    });
  }

  /**
   * Data-subject export (NDPA 2023 §34 / FERPA right of access): one JSON
   * bundle of everything the portal holds about a user. Runs as SERVICE so
   * RLS admin-tier policies apply uniformly; secrets (password hash, TOTP,
   * session token hashes) are excluded — this is a personal-data export, not
   * a credential dump.
   */
  @Get("users/:id/export")
  @Perm("exports:write")
  async exportUser(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [profile] = await tx.select({
        id: users.id, email: users.email, displayName: users.displayName,
        status: users.status, directoryOptOut: users.directoryOptOut,
        createdAt: users.createdAt,
      }).from(users).where(eq(users.id, id)).limit(1);
      if (!profile) throw new NotFoundException({ code: "not_found" });

      const [roleRows, identityRows, sessionRows, guardianRows, notifRows] = await Promise.all([
        tx.select({ roleCode: userRoles.roleCode, grantedAt: userRoles.grantedAt,
          revokedAt: userRoles.revokedAt }).from(userRoles).where(eq(userRoles.userId, id)),
        tx.select({ provider: identities.provider, subject: identities.subject,
          lastSeenAt: identities.lastSeenAt }).from(identities).where(eq(identities.userId, id)),
        tx.select({ id: sessions.id, activeRole: sessions.activeRole, amr: sessions.amr,
          ip: sessions.ip, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.userId, id)),
        tx.select().from(guardians).where(sql`${guardians.userId} = ${id} OR ${guardians.studentUserId} = ${id}`),
        tx.select({ kind: notifications.kind, channel: notifications.channel,
          status: notifications.status, createdAt: notifications.createdAt })
          .from(notifications).where(eq(notifications.recipientUserId, id)),
      ]);

      const [studentRow] = await tx.select().from(students).where(eq(students.userId, id)).limit(1);
      let academic = null;
      if (studentRow) {
        const [enrollRows, gradeRows, attendRows, invoiceRows, transportRows] = await Promise.all([
          tx.select().from(enrollments).where(eq(enrollments.studentUserId, id)),
          tx.select({ id: grades.id, sectionId: grades.sectionId, label: grades.label,
            sourceType: grades.sourceType, points: grades.points, maxPoints: grades.maxPoints,
            weightPct: grades.weightPct, releasedAt: grades.releasedAt,
            gradedAt: grades.gradedAt }).from(grades).where(eq(grades.studentUserId, id)),
          tx.select({ sessionId: attendanceRecords.sessionId, status: attendanceRecords.status,
            note: attendanceRecords.note })
            .from(attendanceRecords).where(eq(attendanceRecords.studentUserId, id)),
          tx.select().from(feeInvoices).where(eq(feeInvoices.studentUserId, id)),
          tx.select().from(transportAssignments).where(eq(transportAssignments.studentUserId, id)),
        ]);
        academic = { student: studentRow, enrollments: enrollRows, grades: gradeRows,
          attendance: attendRows, feeInvoices: invoiceRows, transport: transportRows };
      }

      const paymentRows = await tx.select({ id: feePayments.id, invoiceId: feePayments.invoiceId,
        amountKobo: feePayments.amountKobo, channel: feePayments.channel,
        status: feePayments.status, createdAt: feePayments.createdAt })
        .from(feePayments).where(eq(feePayments.paidBy, id));
      const threadRows = await tx.select().from(messageThreads).where(eq(messageThreads.createdBy, id));
      const sentMsgs = await tx.select({ id: messages.id, threadId: messages.threadId,
        body: messages.bodyText, createdAt: messages.createdAt })
        .from(messages).where(eq(messages.senderUserId, id));
      const auditRows = await tx.select({ action: auditLog.action, entityType: auditLog.entityType,
        occurredAt: auditLog.occurredAt }).from(auditLog).where(eq(auditLog.actorUserId, id));

      await insertAudit(tx, { actorUserId: p.userId, action: "user.exported",
        entityType: "user", entityId: id, ip: req.ip });

      return {
        exportedAt: new Date().toISOString(),
        subject: profile,
        roles: roleRows,
        identities: identityRows,
        sessions: sessionRows,
        guardianLinks: guardianRows,
        notifications: notifRows,
        payments: paymentRows,
        messaging: { threadsStarted: threadRows, messagesSent: sentMsgs },
        academic,
        auditTrail: auditRows,
      };
    });
  }
}
