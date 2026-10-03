import {
  Body, Controller, Get, Inject, Post, Query, Req, Res, UnprocessableEntityException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql, notInArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { users, userRoles, mfaFactors, mfaEnrollTokens } from "../db/schema";
import { Perm } from "../common/guards";
import { insertAudit } from "../common/audit";
import { assertCanGrant } from "../common/role-policy";
import { enqueue } from "../notify/notify.service";
import { mailConfigured } from "../notify/mailer";
import { STAFF_ROLES } from "../common/principal";

/**
 * Bulk MFA onboarding.
 *
 * Staff MFA is enforced, and enrolment requires an admin-issued single-use
 * token — correct, but tokens could only be issued one user at a time. Rolling
 * that out to sixty teachers meant sixty round trips through the UI, which in
 * practice means it does not get done, or gets done by turning enforcement
 * off. Neither is acceptable for a system holding children's records.
 *
 * So: a coverage view that answers "who still has not set this up", and a bulk
 * issue that can cover everyone outstanding in one action, with a printable
 * hand-out sheet for the staff meeting where it actually happens.
 */

const ENROLL_TTL_MS = 7 * 24 * 3_600_000;   // a week: long enough for a staff INSET day
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_BULK = 500;

interface Candidate {
  id: string; email: string; displayName: string; roles: string[];
  enrolled: boolean; pendingToken: boolean; status: string;
}

@Controller("mfa")
export class MfaAdminController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  /**
   * Who has two-factor set up and who does not. This is the screen that turns
   * "we should roll out MFA" into a finishable task with a visible number.
   */
  @Get("coverage")
  @Perm("directory:write")
  async coverage(@Req() req: Request) {
    return withActor(this.db, SERVICE, async (tx) => {
      const rows = await this.staffWithMfaState(tx);
      const enrolled = rows.filter((r) => r.enrolled);
      const outstanding = rows.filter((r) => !r.enrolled);
      return {
        total: rows.length,
        enrolled: enrolled.length,
        outstanding: outstanding.length,
        pendingTokens: outstanding.filter((r) => r.pendingToken).length,
        percent: rows.length ? Math.round((enrolled.length / rows.length) * 100) : 100,
        data: rows,
      };
    });
  }

  /**
   * Issue enrolment tokens for many staff at once.
   *
   * `scope: "outstanding"` covers everyone who still has no second factor,
   * which is the common case. Explicit `user_ids` is there for re-issuing to
   * the three people who lost their slip.
   */
  @Post("enroll-tokens/bulk")
  @Perm("directory:write")
  async bulkIssue(@Req() req: Request, @Body() body: unknown) {
    const p = req.principal!;
    const b = (body ?? {}) as { user_ids?: string[]; scope?: string; deliver?: string };
    const wantsPrint = b.deliver === "print" || !mailConfigured();

    return withActor(this.db, SERVICE, async (tx) => {
      let targets: Candidate[];
      if (Array.isArray(b.user_ids) && b.user_ids.length) {
        if (b.user_ids.length > MAX_BULK) {
          throw new UnprocessableEntityException({
            code: "too_many", title: "Too many users in one request",
            detail: `Issue at most ${MAX_BULK} tokens at a time.`,
          });
        }
        const all = await this.staffWithMfaState(tx);
        const wanted = new Set(b.user_ids);
        targets = all.filter((r) => wanted.has(r.id));
      } else if (b.scope === "outstanding") {
        targets = (await this.staffWithMfaState(tx)).filter((r) => !r.enrolled);
      } else {
        throw new UnprocessableEntityException({
          code: "nothing_selected",
          title: "Choose who to issue tokens for",
          detail: 'Pass either user_ids: [...] or scope: "outstanding".',
        });
      }

      const issued: { userId: string; email: string; displayName: string; token?: string }[] = [];
      const skipped: { userId: string; email: string; reason: string }[] = [];

      for (const t of targets) {
        if (t.status !== "active") {
          skipped.push({ userId: t.id, email: t.email, reason: `account is ${t.status}` });
          continue;
        }
        // The tier check is per-user: a registrar bulk-issuing must not be able
        // to mint an enrolment token for a super admin by widening the scope.
        try { assertCanGrant(p.activeRole, t.roles); }
        catch { skipped.push({ userId: t.id, email: t.email, reason: "above your role tier" }); continue; }

        const token = randomBytes(24).toString("base64url");
        await tx.insert(mfaEnrollTokens).values({
          id: randomUUID(), userId: t.id, tokenHash: sha(token),
          expiresAt: new Date(Date.now() + ENROLL_TTL_MS), createdBy: p.userId,
        });
        if (mailConfigured()) {
          await enqueue(tx, {
            recipientUserId: t.id, channel: "email", kind: "mfa_enroll_token",
            payload: { token, expiresHours: ENROLL_TTL_MS / 3_600_000 },
          });
        }
        issued.push({
          userId: t.id, email: t.email, displayName: t.displayName,
          ...(wantsPrint ? { token } : {}),
        });
      }

      await insertAudit(tx, {
        actorUserId: p.userId, action: "mfa.enroll_tokens_bulk_issued",
        entityType: "user",
        after: {
          issued: issued.length, skipped: skipped.length,
          scope: b.scope ?? "explicit", delivery: wantsPrint ? "print" : "email",
        },
        ip: req.ip, userAgent: req.get("user-agent") ?? undefined,
      });

      return {
        issued: issued.length,
        skipped,
        emailed: mailConfigured() ? issued.length : 0,
        expiresAt: new Date(Date.now() + ENROLL_TTL_MS).toISOString(),
        // Tokens are returned only for the print workflow, and this is the one
        // and only time they are readable — they are stored hashed.
        data: issued,
        note: wantsPrint
          ? "These tokens are shown once. Print or save this sheet now; they are stored hashed and cannot be shown again."
          : "Each person has been emailed their enrolment link.",
      };
    });
  }

  /**
   * Printable hand-out sheet. Issues fresh tokens and returns them as CSV —
   * the realistic way a school does this is one page per person, handed out
   * at a staff meeting, not sixty separate emails nobody opens.
   */
  @Post("enroll-tokens/bulk.csv")
  @Perm("directory:write")
  async bulkCsv(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    const result = await this.bulkIssue(req, { ...(body as object), deliver: "print" });
    const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = (result.data as { displayName: string; email: string; token?: string }[])
      .map((r) => [r.displayName, r.email, r.token ?? "", result.expiresAt].map(esc).join(","));
    const csv = ["name,email,enrolment_token,expires_at", ...rows].join("\r\n") + "\r\n";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",
      `attachment; filename="mfa-enrolment-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }

  /** Staff, each with whether they already hold a TOTP factor. */
  private async staffWithMfaState(tx: Db): Promise<Candidate[]> {
    const staffRoles = [...STAFF_ROLES];
    const rows = await tx.select({
      id: users.id, email: users.email, displayName: users.displayName, status: users.status,
      roleCode: userRoles.roleCode,
    }).from(users)
      .innerJoin(userRoles, and(eq(userRoles.userId, users.id), isNull(userRoles.revokedAt)))
      .where(inArray(userRoles.roleCode, staffRoles));

    const byUser = new Map<string, Candidate>();
    for (const r of rows) {
      const existing = byUser.get(r.id);
      if (existing) { existing.roles.push(r.roleCode); continue; }
      byUser.set(r.id, {
        id: r.id, email: r.email, displayName: r.displayName, status: r.status,
        roles: [r.roleCode], enrolled: false, pendingToken: false,
      });
    }
    if (!byUser.size) return [];
    const ids = [...byUser.keys()];

    const factors = await tx.select({ userId: mfaFactors.userId }).from(mfaFactors)
      .where(and(inArray(mfaFactors.userId, ids), eq(mfaFactors.kind, "totp")));
    for (const f of factors) { const c = byUser.get(f.userId); if (c) c.enrolled = true; }

    const pending = await tx.select({ userId: mfaEnrollTokens.userId }).from(mfaEnrollTokens)
      .where(and(
        inArray(mfaEnrollTokens.userId, ids),
        isNull(mfaEnrollTokens.usedAt),
        sql`${mfaEnrollTokens.expiresAt} > now()`));
    for (const t of pending) { const c = byUser.get(t.userId); if (c) c.pendingToken = true; }

    return [...byUser.values()].sort((a, b) =>
      Number(a.enrolled) - Number(b.enrolled) || a.displayName.localeCompare(b.displayName));
  }
}
