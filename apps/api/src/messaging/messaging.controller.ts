import {
  Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor } from "../db/actor";
import { messageThreads, messages, users, sectionStaff, enrollments } from "../db/schema";
import { Perm } from "../common/guards";
import { insertAudit } from "../common/audit";
import { enqueueMessagePosted } from "../notify/notify.service";
import { ThreadCreateBody, MessageBody } from "@portal/contracts";
import type { Request } from "express";

/**
 * Teacher↔parent messaging (Phase-1 decision: parents READ ONLY).
 * Gate 1 here (Perm + authorship); gate 2 = RLS policies from 0002.
 */
@Controller()
export class MessagingController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  /** threads visible to the caller: authoring teacher / guardian / admin (RLS filters) */
  @Get("threads")
  async list(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select({
        id: messageThreads.id, subject: messageThreads.subject, status: messageThreads.status,
        createdAt: messageThreads.createdAt,
        studentUserId: messageThreads.studentUserId, studentName: users.displayName,
      }).from(messageThreads)
        .innerJoin(users, eq(users.id, messageThreads.studentUserId));
      return { data: rows };
    });
  }

  @Post("threads")
  @Perm("messaging:write")
  async create(@Req() req: Request, @Body() body: unknown) {
    const parsed = ThreadCreateBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      await this.assertTeaches(tx, p.userId, parsed.data.student_user_id);
      const [thread] = await tx.insert(messageThreads).values({
        studentUserId: parsed.data.student_user_id,
        createdBy: p.userId,
        subject: parsed.data.subject,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "thread.created",
        entityType: "message_thread", entityId: thread.id, ip: req.ip });
      return thread;
    });
  }

  @Get("threads/:id")
  async thread(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [thread] = await tx.select().from(messageThreads).where(eq(messageThreads.id, id)).limit(1);
      if (!thread) throw new NotFoundException({ code: "not_found" }); // also covers RLS-invisible
      // sender_name is snapshotted on the row: guardians cannot read staff rows
      // in users, so a join here would hide every teacher message from parents.
      const msgs = await tx.select().from(messages).where(eq(messages.threadId, id));
      const [student] = await tx.select({ displayName: users.displayName })
        .from(users).where(eq(users.id, thread.studentUserId)).limit(1);
      return { thread: { ...thread, studentName: student?.displayName ?? null }, messages: msgs };
    });
  }

  @Post("threads/:id/messages")
  @Perm("messaging:write")
  async post(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = MessageBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      // only the thread author (the teaching side) may post — parents are read-only by design
      const [thread] = await tx.select().from(messageThreads)
        .where(and(eq(messageThreads.id, id), eq(messageThreads.createdBy, p.userId))).limit(1);
      if (!thread) throw new NotFoundException({ code: "not_found" });
      if (thread.status === "closed") {
        throw new UnprocessableEntityException({ code: "thread_closed", detail: "reopen or start a new thread" });
      }
      const [msg] = await tx.insert(messages).values({
        threadId: id, senderUserId: p.userId, senderName: p.displayName,
        bodyText: parsed.data.body_text,
      }).returning();
      await enqueueMessagePosted(tx, thread.studentUserId, id, thread.subject);
      await insertAudit(tx, { actorUserId: p.userId, action: "message.posted",
        entityType: "message_thread", entityId: id, ip: req.ip });
      return msg;
    });
  }

  @Post("threads/:id/close")
  @Perm("messaging:write")
  async close(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [thread] = await tx.select().from(messageThreads)
        .where(and(eq(messageThreads.id, id), eq(messageThreads.createdBy, p.userId))).limit(1);
      if (!thread) throw new NotFoundException({ code: "not_found" });
      const [updated] = await tx.update(messageThreads)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(messageThreads.id, id)).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "thread.closed",
        entityType: "message_thread", entityId: id });
      return updated;
    });
  }

  /** teacher must staff ≥1 section the student is enrolled in (mirrors is_teacher_of in RLS) */
  private async assertTeaches(tx: Db, userId: string, studentUserId: string) {
    const [row] = await tx.select({ id: sectionStaff.id }).from(sectionStaff)
      .innerJoin(enrollments, eq(enrollments.sectionId, sectionStaff.sectionId))
      .where(and(
        eq(sectionStaff.userId, userId),
        eq(enrollments.studentUserId, studentUserId), eq(enrollments.status, "enrolled"),
      )).limit(1);
    if (!row) {
      throw new ForbiddenException({ code: "outside_section_scope",
        detail: "you do not teach this student" });
    }
  }
}
