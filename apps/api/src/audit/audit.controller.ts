import {
  Controller, Get, Inject, Query, Req, Res, UnprocessableEntityException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { and, desc, eq, gte, lte, lt, or, sql, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { auditLog, users } from "../db/schema";
import { Perm } from "../common/guards";
import { computeRowHash, insertAudit } from "../common/audit";

/**
 * The audit log, finally reachable.
 *
 * `audit:read` was granted to super_admin, school_admin and auditor, and the
 * table has been collecting tamper-evident rows since day one — but there was
 * no endpoint and no screen, so the permission granted access to nothing and
 * the tamper evidence could never be checked. An audit trail nobody can read
 * is not an audit trail.
 *
 * Reads run under the caller's own role so the RLS policy on audit_log is the
 * thing enforcing access, not just the route guard.
 */

/** Human wording for the action codes, so the screen is readable by a registrar. */
const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.logout": "Signed out",
  "auth.password_changed": "Changed their password",
  "auth.password_forgot": "Requested a password reset",
  "auth.password_reset": "Reset a password",
  "auth.role_switch": "Switched role",
  "auth.sso_linked": "Linked an SSO account",
  "auth.sso_login": "Signed in via SSO",
  "auth.bootstrap_admin": "Bootstrapped the first administrator",
  "user.created": "Created an account",
  "user.invited": "Invited someone",
  "user.invite_accepted": "Accepted an invitation",
  "user.deactivated": "Offboarded an account",
  "user.reactivated": "Reactivated an account",
  "user.exported": "Exported the user directory",
  "invite.resent": "Resent an invitation",
  "invite.revoked": "Revoked an invitation",
  "mfa.enrolled": "Enrolled in two-factor authentication",
  "mfa.verified": "Passed two-factor verification",
  "mfa.admin_reset": "Reset someone's two-factor authentication",
  "mfa.enroll_token_issued": "Issued a two-factor enrolment token",
  "mfa.recovery_used": "Used a two-factor recovery code",
  "guardian.linked": "Linked a guardian",
  "guardian.verified": "Verified a guardian link",
  "guardian.revoked": "Removed a guardian link",
  "enrollment.created": "Enrolled a pupil",
  "attendance.upsert": "Recorded attendance",
  "attendance.finalized": "Finalised a register",
  "gradebook.bulk_upsert": "Entered marks",
  "grades.released": "Released results",
  "grading.updated": "Changed the grading scale",
  "invoice.created": "Raised an invoice",
  "fee_template.created": "Created a fee template",
  "fee_template.generated": "Generated invoices from a template",
  "payment.initiated": "Started a payment",
  "import.queued": "Queued a roster import",
  "import.completed": "Completed a roster import",
  "import.cancelled": "Cancelled a roster import",
  "import.credentials_downloaded": "Downloaded import credentials",
  "message.posted": "Posted a message",
  "thread.created": "Started a conversation",
  "thread.closed": "Closed a conversation",
  "notification.retried": "Retried a notification",
  "notification.retried_bulk": "Retried notifications in bulk",
  "audit.exported": "Exported the audit log",
  "webhook.orphan": "Payment webhook with no matching invoice",
  "webhook.amount_mismatch": "Payment webhook amount mismatch",
  "webhook.currency_mismatch": "Payment webhook currency mismatch",
  "webhook.overpaid": "Payment webhook overpayment",
};

export function labelFor(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  // Fall back to something readable rather than showing a raw code.
  const [group, verb] = action.split(".");
  if (!verb) return action;
  return `${verb.replace(/_/g, " ")} (${group.replace(/_/g, " ")})`;
}

const MAX_PER = 200;

function parseDate(v: string | undefined, what: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v);
  if (Number.isNaN(d.getTime())) {
    throw new UnprocessableEntityException({
      code: "bad_date", title: `Invalid ${what} date`,
      detail: `Expected YYYY-MM-DD or an ISO timestamp, got "${v}".`,
    });
  }
  return d;
}

@Controller("audit")
export class AuditController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  /**
   * Keyset ("seek") pagination on (occurred_at, id) rather than OFFSET: the
   * audit log only grows, and OFFSET 50000 gets slower every term while also
   * skipping or repeating rows when new ones land mid-browse.
   */
  @Get()
  @Perm("audit:read")
  async list(
    @Req() req: Request,
    @Query("actor") actor?: string,
    @Query("action") action?: string,
    @Query("entity_type") entityType?: string,
    @Query("entity_id") entityId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("q") q?: string,
    @Query("cursor") cursor?: string,
    @Query("per") per = "50",
  ) {
    const p = req.principal!;
    const limit = Math.min(Math.max(Number(per) || 50, 1), MAX_PER);
    const fromAt = parseDate(from, "from");
    const toAt = parseDate(to, "to");

    const where = [] as any[];
    if (actor) where.push(eq(auditLog.actorUserId, actor));
    if (action) {
      const list = action.split(",").map((a) => a.trim()).filter(Boolean);
      where.push(list.length > 1 ? inArray(auditLog.action, list) : eq(auditLog.action, list[0]));
    }
    if (entityType) where.push(eq(auditLog.entityType, entityType));
    if (entityId) where.push(eq(auditLog.entityId, entityId));
    if (fromAt) where.push(gte(auditLog.occurredAt, fromAt));
    if (toAt) where.push(lte(auditLog.occurredAt, toAt));
    if (q) where.push(sql`${auditLog.action} ilike ${"%" + q + "%"}`);

    if (cursor) {
      const [ts, id] = cursor.split("|");
      const at = new Date(ts);
      if (!Number.isNaN(at.getTime())) {
        where.push(or(lt(auditLog.occurredAt, at),
          and(eq(auditLog.occurredAt, at), lt(auditLog.id, id))));
      }
    }

    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select({
        id: auditLog.id, action: auditLog.action, entityType: auditLog.entityType,
        entityId: auditLog.entityId, actorUserId: auditLog.actorUserId,
        before: auditLog.beforeJson, after: auditLog.afterJson,
        ip: auditLog.ip, userAgent: auditLog.userAgent,
        occurredAt: auditLog.occurredAt, rowHash: auditLog.rowHash,
      }).from(auditLog)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const actorNames = await this.resolveActors(tx, page.map((r) => r.actorUserId));

      return {
        data: page.map((r) => ({
          ...r,
          label: labelFor(r.action),
          actor: r.actorUserId
            ? actorNames.get(r.actorUserId) ?? { id: r.actorUserId, displayName: "(deleted account)", email: null }
            : { id: null, displayName: "System", email: null },
        })),
        meta: {
          per: limit,
          hasMore: rows.length > limit,
          nextCursor: rows.length > limit && page.length
            ? `${page[page.length - 1].occurredAt.toISOString()}|${page[page.length - 1].id}`
            : null,
        },
      };
    });
  }

  /** Distinct actions actually present, for the filter dropdown. */
  @Get("actions")
  @Perm("audit:read")
  async actions(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select({
        action: auditLog.action, n: sql<number>`count(*)::int`,
      }).from(auditLog).groupBy(auditLog.action).orderBy(auditLog.action);
      return { data: rows.map((r) => ({ action: r.action, label: labelFor(r.action), count: Number(r.n) })) };
    });
  }

  /**
   * Tamper check. Every row stores sha256 over its canonical payload; this
   * recomputes them and reports any that no longer match — i.e. a row that was
   * edited in the database after the fact. This is the feature the hash column
   * was always for, and until now there was no way to run it.
   */
  @Get("verify")
  @Perm("audit:read")
  async verify(
    @Req() req: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limitRaw = "5000",
  ) {
    const p = req.principal!;
    const limit = Math.min(Math.max(Number(limitRaw) || 5000, 1), 50_000);
    const fromAt = parseDate(from, "from");
    const toAt = parseDate(to, "to");
    const where = [] as any[];
    if (fromAt) where.push(gte(auditLog.occurredAt, fromAt));
    if (toAt) where.push(lte(auditLog.occurredAt, toAt));

    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(auditLog)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(auditLog.occurredAt)).limit(limit);

      const mismatched: { id: string; action: string; occurredAt: string }[] = [];
      for (const r of rows) {
        const expected = computeRowHash({
          actorUserId: r.actorUserId, action: r.action,
          entityType: r.entityType ?? undefined, entityId: r.entityId ?? undefined,
          before: r.beforeJson ?? undefined, after: r.afterJson ?? undefined,
        }, r.occurredAt);
        if (expected !== r.rowHash) {
          mismatched.push({ id: r.id, action: r.action, occurredAt: r.occurredAt.toISOString() });
        }
      }
      return {
        checked: rows.length,
        intact: rows.length - mismatched.length,
        mismatched,
        ok: mismatched.length === 0,
        detail: mismatched.length
          ? "One or more audit rows no longer match their recorded hash. They have been " +
            "modified in the database since they were written. Treat this as a security incident."
          : "Every row checked matches its recorded hash.",
        range: { from: fromAt?.toISOString() ?? null, to: toAt?.toISOString() ?? null, limit },
      };
    });
  }

  /** CSV export for an inspector or a board pack. Exporting is itself audited. */
  @Get("export.csv")
  @Perm("audit:read")
  async exportCsv(
    @Req() req: Request, @Res() res: Response,
    @Query("action") action?: string,
    @Query("actor") actor?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limitRaw = "10000",
  ) {
    const p = req.principal!;
    const limit = Math.min(Math.max(Number(limitRaw) || 10_000, 1), 50_000);
    const fromAt = parseDate(from, "from");
    const toAt = parseDate(to, "to");
    const where = [] as any[];
    if (actor) where.push(eq(auditLog.actorUserId, actor));
    if (action) where.push(eq(auditLog.action, action));
    if (fromAt) where.push(gte(auditLog.occurredAt, fromAt));
    if (toAt) where.push(lte(auditLog.occurredAt, toAt));

    const { csv, count } = await withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(auditLog)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(auditLog.occurredAt)).limit(limit);
      const names = await this.resolveActors(tx, rows.map((r) => r.actorUserId));
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const head = "occurred_at,action,description,actor_name,actor_email,entity_type,entity_id,ip,before,after,row_hash";
      const body = rows.map((r) => [
        r.occurredAt.toISOString(), r.action, labelFor(r.action),
        r.actorUserId ? names.get(r.actorUserId)?.displayName ?? "(deleted account)" : "System",
        r.actorUserId ? names.get(r.actorUserId)?.email ?? "" : "",
        r.entityType ?? "", r.entityId ?? "", r.ip ?? "",
        r.beforeJson ?? "", r.afterJson ?? "", r.rowHash,
      ].map(esc).join(","));
      return { csv: [head, ...body].join("\r\n") + "\r\n", count: rows.length };
    });

    // Reading the whole audit trail is itself a sensitive act — record it.
    await withActor(this.db, SERVICE, (tx) => insertAudit(tx, {
      actorUserId: p.userId, action: "audit.exported", entityType: "audit_log",
      after: { rows: count, filters: { action: action ?? null, actor: actor ?? null, from: from ?? null, to: to ?? null } },
      ip: req.ip, userAgent: req.get("user-agent") ?? undefined,
    }));

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${stamp}.csv"`);
    res.send(csv);
  }

  private async resolveActors(tx: Db, ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    const map = new Map<string, { id: string; displayName: string; email: string | null }>();
    if (!unique.length) return map;
    const rows = await tx.select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users).where(inArray(users.id, unique));
    for (const r of rows) map.set(r.id, r);
    return map;
  }
}
