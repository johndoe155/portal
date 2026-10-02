import { Controller, Get, Inject, NotFoundException, Param, Req } from "@nestjs/common";
import { eq, and, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor } from "../db/actor";
import {
  grades, attendanceRecords, attendanceSessions, guardians, students, users,
} from "../db/schema";
import { Perm } from "../common/guards";
import type { Request } from "express";

@Controller()
export class StudentController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  @Get("student/grades")
  @Perm("self:read")
  async myGrades(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(grades)
        .where(and(eq(grades.studentUserId, p.userId), isNotNull(grades.releasedAt)));
      return { data: rows };
    });
  }

  @Get("student/attendance")
  @Perm("self:read")
  async myAttendance(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select({
        date: attendanceSessions.date, status: attendanceRecords.status,
        sectionId: attendanceSessions.sectionId, note: attendanceRecords.note,
      }).from(attendanceRecords)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
        .where(eq(attendanceRecords.studentUserId, p.userId));
      return { data: rows };
    });
  }

  @Get("parent/children")
  @Perm("family:read")
  async children(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      // LEFT joins on purpose: until the link is VERIFIED the student's own
      // row is RLS-invisible to this parent — the link shows as pending
      // instead of the child silently not existing.
      const rows = await tx.select({
        studentUserId: guardians.studentUserId, admissionNo: students.admissionNo,
        gradeLevel: students.gradeLevel, displayName: users.displayName,
        relationship: guardians.relationship, verified: guardians.verifiedAt,
      }).from(guardians)
        .leftJoin(students, eq(students.userId, guardians.studentUserId))
        .leftJoin(users, eq(users.id, guardians.studentUserId))
        .where(and(eq(guardians.userId, p.userId), isNull(guardians.endedAt)));
      return { data: rows };
    });
  }

  @Get("parent/children/:id/grades")
  @Perm("family:read")
  async childGrades(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      await this.assertGuardian(tx, p.userId, id);
      const rows = await tx.select().from(grades)
        .where(and(eq(grades.studentUserId, id), isNotNull(grades.releasedAt)));
      return { data: rows };
    });
  }

  @Get("parent/children/:id/attendance")
  @Perm("family:read")
  async childAttendance(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      await this.assertGuardian(tx, p.userId, id);
      const rows = await tx.select({
        date: attendanceSessions.date, status: attendanceRecords.status,
      }).from(attendanceRecords)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
        .where(eq(attendanceRecords.studentUserId, id));
      return { data: rows };
    });
  }

  private async assertGuardian(tx: Db, userId: string, studentId: string) {
    const [g] = await tx.select().from(guardians).where(and(
      eq(guardians.userId, userId), eq(guardians.studentUserId, studentId),
      isNull(guardians.endedAt))).limit(1);
    if (!g) throw new NotFoundException({ code: "not_found" });
  }
}
