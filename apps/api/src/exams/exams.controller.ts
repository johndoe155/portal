import {
  Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor } from "../db/actor";
import { exams, sectionStaff, enrollments } from "../db/schema";
import { Perm } from "../common/guards";
import { insertAudit } from "../common/audit";
import { ExamCreateBody } from "@portal/contracts";
import type { Request } from "express";

/**
 * Exams: scheduling per section; results live in grades(source_type='exam',
 * source_id=exams.id) so the existing release/revision machinery applies.
 */
@Controller()
export class ExamsController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  @Get("sections/:id/exams")
  @Perm("academics:read")
  async list(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(exams).where(eq(exams.sectionId, id));
      return { data: rows };
    });
  }

  @Post("sections/:id/exams")
  @Perm("gradebook:write")
  async create(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = ExamCreateBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    const b = parsed.data;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      // gate 1: only staff of this section may schedule its exams (RLS re-checks)
      const [staff] = await tx.select({ id: sectionStaff.id }).from(sectionStaff)
        .where(and(eq(sectionStaff.sectionId, id), eq(sectionStaff.userId, p.userId))).limit(1);
      if (!staff) throw new ForbiddenException({ code: "outside_section_scope" });
      const [exam] = await tx.insert(exams).values({
        id: randomUUID(), sectionId: id, title: b.title, examDate: b.exam_date,
        maxScore: b.max_score, weightPct: b.weight_pct ?? null,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "exam.scheduled",
        entityType: "exam", entityId: exam.id, ip: req.ip });
      return exam;
    });
  }

  /** student's upcoming exams across enrolled sections */
  @Get("student/exams")
  @Perm("self:read")
  async myExams(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.selectDistinct({
        id: exams.id, sectionId: exams.sectionId, title: exams.title,
        examDate: exams.examDate, maxScore: exams.maxScore, weightPct: exams.weightPct,
      }).from(exams)
        .innerJoin(enrollments, eq(enrollments.sectionId, exams.sectionId))
        .where(and(eq(enrollments.studentUserId, p.userId), eq(enrollments.status, "enrolled")));
      return { data: rows };
    });
  }

  /** guardian: child's exams */
  @Get("parent/children/:id/exams")
  @Perm("family:read")
  async childExams(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.selectDistinct({
        id: exams.id, sectionId: exams.sectionId, title: exams.title,
        examDate: exams.examDate, maxScore: exams.maxScore, weightPct: exams.weightPct,
      }).from(exams)
        .innerJoin(enrollments, eq(enrollments.sectionId, exams.sectionId))
        .where(and(eq(enrollments.studentUserId, id), eq(enrollments.status, "enrolled")));
      return { data: rows };
    });
  }
}
