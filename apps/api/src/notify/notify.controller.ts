import { Body, Controller, Get, Inject, Param, Post, Req, UnprocessableEntityException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor } from "../db/actor";
import { notifications, pushSubscriptions } from "../db/schema";
import { insertAudit } from "../common/audit";
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
