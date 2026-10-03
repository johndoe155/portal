import {
  Body, Controller, Get, Inject, NotFoundException, Param, Post, Put, Query, Req,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { notifications, users } from "../db/schema";
import { insertAudit } from "../common/audit";
import { ParentWrite, Perm } from "../common/guards";
import { outboxStats, requeueNotification } from "./notify.service";
import {
  KIND_LABELS, OPTIONAL_KINDS, getPrefs, normalisePrefs, verifyUnsubscribeToken, wantsKind,
} from "./preferences";
import { NotificationPrefsBody } from "@portal/contracts";
import type { Request } from "express";

/**
 * Own notification inbox (RLS: recipients only), the admin outbox, and the
 * notification preferences behind every List-Unsubscribe header we send.
 */
@Controller()
export class NotifyController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  @Get("notifications")
  async inbox(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(notifications)
        .where(eq(notifications.recipientUserId, p.userId))
        .limit(50);
      return { data: rows };
    });
  }

  /**
   * Outbox oversight — the school's only visibility into bounced mail.
   *
   * With plain SMTP there is no provider webhook telling us a message hard-
   * bounced, so this screen IS the bounce report: an admin can see that Mrs
   * Okoye's reset link failed, read the SMTP error, fix the address and retry
   * — without a DBA.
   */
  @Get("admin/notifications")
  @Perm("audit:read")
  async outbox(@Req() req: Request,
               @Query("status") status?: string,
               @Query("kind") kind?: string,
               @Query("page") page?: string,
               @Query("per") per?: string) {
    const p = req.principal!;
    const perPage = Math.min(Math.max(Number(per) || 50, 1), 200);
    const pageNum = Math.max(Number(page) || 1, 1);
    const statuses = status && status !== "all"
      ? status.split(",").map((s) => s.trim()).filter(Boolean)
      : ["failed", "dead", "queued"];

    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const where = kind
        ? and(inArray(notifications.status, statuses), eq(notifications.kind, kind))
        : inArray(notifications.status, statuses);

      const rows = await tx.select({
        id: notifications.id, kind: notifications.kind, channel: notifications.channel,
        status: notifications.status, attempts: notifications.attempts,
        lastError: notifications.lastError, createdAt: notifications.createdAt,
        sentAt: notifications.sentAt, nextAttemptAt: notifications.nextAttemptAt,
        failedPermanently: notifications.failedPermanently,
        recipientEmail: notifications.recipientEmail,
        recipientName: users.displayName,
        recipientUserEmail: users.email,
      }).from(notifications)
        .leftJoin(users, eq(users.id, notifications.recipientUserId))
        .where(where)
        .orderBy(desc(notifications.createdAt))
        .limit(perPage).offset((pageNum - 1) * perPage);

      const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` })
        .from(notifications).where(where);

      // Payloads are deliberately NOT returned: for sensitive kinds they hold
      // live reset/invite tokens, and an admin does not need them to diagnose
      // a bounce.
      return {
        data: rows.map((r) => ({
          ...r,
          recipient: r.recipientUserEmail ?? r.recipientEmail ?? "(unknown)",
          recipientName: r.recipientName ?? null,
          recipientUserEmail: undefined,
        })),
        meta: { total, page: pageNum, per: perPage },
      };
    });
  }

  /** Aggregate counters for the admin overview and monitoring. */
  @Get("admin/notifications/stats")
  @Perm("audit:read")
  async outboxStatsEndpoint() {
    return outboxStats(this.db);
  }

  /** Put a failed/dead notification back on the queue for immediate delivery. */
  @Post("admin/notifications/:id/retry")
  @Perm("settings:write")
  async retry(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select({ id: notifications.id, status: notifications.status })
        .from(notifications).where(eq(notifications.id, id)).limit(1);
      if (!row) throw new NotFoundException({ code: "not_found" });
      await requeueNotification(tx, id);
      await insertAudit(tx, {
        actorUserId: p.userId, action: "notification.retried",
        entityType: "notification", entityId: id,
        before: { status: row.status }, after: { status: "queued" }, ip: req.ip,
      });
      return { ok: true, id, status: "queued" };
    });
  }

  /** Retry every dead letter at once — after fixing SMTP, for example. */
  @Post("admin/notifications/retry-all")
  @Perm("settings:write")
  async retryAll(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const rows = await tx.select({ id: notifications.id }).from(notifications)
        .where(inArray(notifications.status, ["failed", "dead"])).limit(1000);
      for (const r of rows) await requeueNotification(tx, r.id);
      await insertAudit(tx, {
        actorUserId: p.userId, action: "notification.retried_bulk",
        entityType: "notification", after: { count: rows.length }, ip: req.ip,
      });
      return { ok: true, requeued: rows.length };
    });
  }

  /* ── notification preferences ──────────────────────────────────────── */

  /**
   * What this recipient currently receives.
   *
   * Every bulk email has always carried `List-Unsubscribe:
   * <ORIGIN/account/notifications>` — and that page did not exist. These
   * routes, and the page that calls them, are what makes that promise true.
   */
  @Get("account/notifications")
  async getPreferences(@Req() req: Request) {
    const p = req.principal!;
    const prefs = await withActor(this.db, SERVICE, (tx) => getPrefs(tx, p.userId));
    return {
      data: OPTIONAL_KINDS.map((kind) => ({
        kind,
        label: KIND_LABELS[kind].label,
        detail: KIND_LABELS[kind].detail,
        enabled: wantsKind(prefs, kind),
      })),
      note: "Security and account emails — password resets, invitations, "
        + "two-factor set-up and account closures — are always sent.",
    };
  }

  // Parents are read-only everywhere else, but muting your own absence
  // alerts is the one write a guardian must be able to make — it is the
  // whole point of the List-Unsubscribe header we put on their mail.
  @Put("account/notifications")
  @ParentWrite()
  async setPreferences(@Req() req: Request, @Body() body: unknown) {
    const parsed = NotificationPrefsBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    // SERVICE actor: `users` has no self-UPDATE policy, and widening it so
    // people can edit their own row would expose far more than a preferences
    // blob. The write is pinned to the caller's own id either way.
    return withActor(this.db, SERVICE, async (tx) => {
      const before = await getPrefs(tx, p.userId);
      const next = { ...before, ...normalisePrefs(parsed.data) };
      await tx.update(users).set({ notificationPrefs: next }).where(eq(users.id, p.userId));
      await insertAudit(tx, {
        actorUserId: p.userId, action: "notification.preferences_changed",
        entityType: "user", entityId: p.userId, before, after: next, ip: req.ip,
      });
      return {
        data: OPTIONAL_KINDS.map((kind) => ({
          kind, label: KIND_LABELS[kind].label, detail: KIND_LABELS[kind].detail,
          enabled: wantsKind(next, kind),
        })),
      };
    });
  }

  /**
   * RFC 8058 one-click unsubscribe.
   *
   * Gmail and Yahoo POST this URL directly from the mail client when the
   * reader hits "Unsubscribe" — no cookies, no CSRF token, no session, and no
   * confirmation page allowed. Authority therefore comes from the HMAC in the
   * token, which is scoped to one recipient and one category.
   *
   * GET is accepted too: some clients and link-scanners follow the URL, and a
   * reader who copies it into a browser should not meet an error.
   */
  @Post("notifications/unsubscribe")
  @ParentWrite()
  async oneClickUnsubscribe(@Query("t") token: string) {
    return this.applyUnsubscribe(token);
  }

  @Get("notifications/unsubscribe")
  async oneClickUnsubscribeGet(@Query("t") token: string) {
    return this.applyUnsubscribe(token);
  }

  private async applyUnsubscribe(token: string) {
    const claim = verifyUnsubscribeToken(String(token ?? ""));
    // A bad token is not an error worth advertising: mail clients retry, and
    // a 4xx here makes a provider treat our unsubscribe as broken.
    if (!claim) return { ok: true, unsubscribed: false };
    return withActor(this.db, SERVICE, async (tx) => {
      const [u] = await tx.select({ id: users.id }).from(users)
        .where(eq(users.id, claim.userId)).limit(1);
      if (!u) return { ok: true, unsubscribed: false };
      const before = await getPrefs(tx, claim.userId);
      const next = { ...before, [claim.kind]: false };
      await tx.update(users).set({ notificationPrefs: next }).where(eq(users.id, claim.userId));
      await insertAudit(tx, {
        actorUserId: null, action: "notification.unsubscribed_one_click",
        entityType: "user", entityId: claim.userId,
        before, after: { kind: claim.kind },
      });
      return { ok: true, unsubscribed: true, kind: claim.kind, label: KIND_LABELS[claim.kind].label };
    });
  }
}
