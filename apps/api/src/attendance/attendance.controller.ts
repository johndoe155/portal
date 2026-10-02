import {
  Body, ConflictException, Controller, Get, Inject, Param, Post, Query, Req, UnprocessableEntityException,
} from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor } from "../db/actor";
import { attendanceSessions, attendanceRecords, enrollments, sectionStaff } from "../db/schema";
import { ForbiddenException } from "@nestjs/common";
import { Perm } from "../common/guards";
import { requireIdempotencyKey, claimIdempotency, completeIdempotency, releaseIdempotency } from "../common/idempotency";
import { insertAudit } from "../common/audit";
import { AttendanceBulkBody } from "@portal/contracts";
import type { Request } from "express";
import { enqueueAbsence } from "../notify/notify.service";

@Controller()
export class AttendanceController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  @Get("sections/:id/attendance")
  @Perm("attendance:read")
  async get(@Req() req: Request, @Param("id") sectionId: string, @Query("date") date: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [session] = await tx.select().from(attendanceSessions)
        .where(and(eq(attendanceSessions.sectionId, sectionId), eq(attendanceSessions.date, date))).limit(1);
      if (!session) return { session: null, records: [] };
      const records = await tx.select().from(attendanceRecords)
        .where(eq(attendanceRecords.sessionId, session.id));
      return { session, records };
    });
  }

  @Post("sections/:id/attendance")
  @Perm("attendance:write")
  async bulk(@Req() req: Request, @Param("id") sectionId: string, @Body() body: unknown) {
    const key = requireIdempotencyKey(req);
    const p = req.principal!;
    const claim = await claimIdempotency(this.db, key, p.userId, req);
    if (claim.status === "replay") return claim.body;
    if (claim.status === "conflict") {
      throw new ConflictException({ code: "idempotency_in_progress",
        detail: "A request with this Idempotency-Key is still processing" });
    }
    try {
    const parsed = AttendanceBulkBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const out = await withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [staffRow] = await tx.select().from(sectionStaff)
        .where(and(eq(sectionStaff.sectionId, sectionId), eq(sectionStaff.userId, p.userId))).limit(1);
      if (!staffRow) throw new ForbiddenException({ code: "outside_section_scope" });
      const enrolled = await tx.select({ id: enrollments.studentUserId }).from(enrollments)
        .where(and(eq(enrollments.sectionId, sectionId), eq(enrollments.status, "enrolled")));
      const enrolledSet = new Set(enrolled.map((e) => e.id));
      const bad = parsed.data.records.filter((r) => !enrolledSet.has(r.student_user_id));
      if (bad.length) {
        throw new UnprocessableEntityException({ code: "not_enrolled",
          detail: `${bad.length} student(s) not enrolled in this section` });
      }
      let [session] = await tx.select().from(attendanceSessions)
        .where(and(eq(attendanceSessions.sectionId, sectionId), eq(attendanceSessions.date, parsed.data.date))).limit(1);
      if (session && session.status === "final") {
        throw new ConflictException({ code: "register_finalized", detail: "register is locked" });
      }
      if (!session) {
        [session] = await tx.insert(attendanceSessions).values({
          sectionId, date: parsed.data.date, takenBy: p.userId,
        }).returning();
      }
      for (const r of parsed.data.records) {
        const [prev] = await tx.select({ status: attendanceRecords.status }).from(attendanceRecords)
          .where(and(eq(attendanceRecords.sessionId, session.id),
            eq(attendanceRecords.studentUserId, r.student_user_id))).limit(1);
        await tx.insert(attendanceRecords).values({
          sessionId: session.id, studentUserId: r.student_user_id, status: r.status, note: r.note ?? null,
        }).onConflictDoUpdate({
          target: [attendanceRecords.sessionId, attendanceRecords.studentUserId],
          set: { status: r.status, note: r.note ?? null },
        });
        // 5.3: transition INTO absent fires guardian alerts (email + push) via the outbox
        if (r.status === "absent" && prev?.status !== "absent") {
          await enqueueAbsence(tx, r.student_user_id, parsed.data.date, sectionId);
        }
      }
      await insertAudit(tx, { actorUserId: p.userId, action: "attendance.upsert",
        entityType: "attendance_session", entityId: session.id,
        after: { date: parsed.data.date, rows: parsed.data.records.length },
        ip: req.ip, userAgent: req.headers["user-agent"] });
      return { sessionId: session.id, status: session.status, written: parsed.data.records.length };
    });
    await completeIdempotency(this.db, key, p.userId, req, 201, out);
    return out;
    } catch (e) {
      // review-3 #4: a FAILED save must not strand the key — release the
      // claim so the client can retry with the same Idempotency-Key.
      await releaseIdempotency(this.db, key, p.userId, req);
      throw e;
    }
  }

  @Post("sections/:id/attendance/finalize")
  @Perm("attendance:write")
  async finalize(@Req() req: Request, @Param("id") sectionId: string, @Body() body: { date?: string }) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [staffRow] = await tx.select().from(sectionStaff)
        .where(and(eq(sectionStaff.sectionId, sectionId), eq(sectionStaff.userId, p.userId))).limit(1);
      if (!staffRow) throw new ForbiddenException({ code: "outside_section_scope" });
      const [session] = await tx.select().from(attendanceSessions)
        .where(and(eq(attendanceSessions.sectionId, sectionId), eq(attendanceSessions.date, body?.date ?? ""))).limit(1);
      if (!session) throw new UnprocessableEntityException({ code: "no_session", detail: "no register for date" });
      const [updated] = await tx.update(attendanceSessions)
        .set({ status: "final", finalizedAt: new Date() })
        .where(eq(attendanceSessions.id, session.id)).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "attendance.finalized",
        entityType: "attendance_session", entityId: session.id, ip: req.ip });
      return updated;
    });
  }
}
