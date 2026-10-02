import {
  Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { notifications, pushSubscriptions, users } from "../db/schema";
import { insertAudit } from "../common/audit";
import { Perm } from "../common/guards";
import { outboxStats, requeueNotification } from "./notify.service";
import { PushSubscribeBody } from "@portal/contracts";
import type { Request } from "express";

/**
 * Own notification inbox (RLS: recipients only) + Web Push subscription
 * management. Note: parents are blocked from subscribing by the blanket
 * parent_read_only guard — guardians receive email alerts/digests instead.
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

  @Post("notifications/push")
  async subscribe(@Req() req: Request, @Body() body: unknown) {
    const parsed = PushSubscribeBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [row] = await tx.insert(pushSubscriptions).values({
        userId: p.userId,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys?.p256dh ?? null,
        authKey: parsed.data.keys?.auth ?? null,
        userAgent: (req.headers["user-agent"] ?? "").slice(0, 300) || null,
      }).onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { p256dh: parsed.data.keys?.p256dh ?? null, authKey: parsed.data.keys?.auth ?? null },
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "push.subscribed",
        entityType: "push_subscription", entityId: row.id });
      return row;
    });
  }

  @Post("notifications/push/:id/unsubscribe")
  async unsubscribe(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [row] = await tx.select().from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, p.userId))).limit(1);
      if (!row) return { ok: true, removed: 0 };
      await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
      await insertAudit(tx, { actorUserId: p.userId, action: "push.unsubscribed",
        entityType: "push_subscription", entityId: id });
      return { ok: true, removed: 1 };
    });
  }
}
