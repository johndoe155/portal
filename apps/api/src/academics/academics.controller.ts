import {
  Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Req, Query,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { courseSections, courses, sectionStaff, enrollments, students, users, terms, academicYears, yearRollovers } from "../db/schema";
import { Perm } from "../common/guards";
import { insertAudit } from "../common/audit";
import { SectionCreateBody, EnrollBody, YearBody, TermBody, StaffAssignBody } from "@portal/contracts";
import { planRollover, commitRollover, revertRollover, MAX_GRADE } from "./rollover.service";
import type { RolloverOptions, PupilAction } from "./rollover.service";
import type { Request } from "express";

@Controller()
export class AcademicsController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  /** teachers see their sections (RLS), admins see all. */
  @Get("sections")
  @Perm("academics:read")
  async sections(@Req() req: Request, @Query("term") term?: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select({
        id: courseSections.id, name: courseSections.name, status: courseSections.status,
        courseCode: courses.code, courseTitle: courses.title, termId: courseSections.termId,
      }).from(courseSections).innerJoin(courses, eq(courses.id, courseSections.courseId))
        .where(term ? eq(courseSections.termId, term) : undefined);
      return { data: rows };
    });
  }

  @Get("sections/:id/roster")
  @Perm("academics:read")
  async roster(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [section] = await tx.select().from(courseSections).where(eq(courseSections.id, id)).limit(1);
      if (!section) throw new NotFoundException({ code: "not_found" });
      const rows = await tx.select({
        studentUserId: students.userId, admissionNo: students.admissionNo,
        gradeLevel: students.gradeLevel, displayName: users.displayName,
        status: enrollments.status,
      }).from(enrollments)
        .innerJoin(students, eq(students.userId, enrollments.studentUserId))
        .innerJoin(users, eq(users.id, students.userId))
        .where(and(eq(enrollments.sectionId, id), eq(enrollments.status, "enrolled")));
      return { data: rows };
    });
  }

  /** Phase 5.3: registrar/admin creates a section (course upserted by code) */
  @Post("sections")
  @Perm("academics:write")
  async createSection(@Req() req: Request, @Body() body: unknown) {
    const parsed = SectionCreateBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const b = parsed.data;
      let [course] = await tx.select().from(courses)
        .where(eq(courses.code, b.course_code.toUpperCase())).limit(1);
      if (!course) {
        [course] = await tx.insert(courses)
          .values({ id: randomUUID(), code: b.course_code.toUpperCase(), title: b.course_title })
          .returning();
      }
      const [dupe] = await tx.select({ id: courseSections.id }).from(courseSections)
        .where(and(eq(courseSections.courseId, course.id), eq(courseSections.termId, b.term_id),
          eq(courseSections.name, b.name))).limit(1);
      if (dupe) throw new ConflictException({ code: "section_exists" });
      const [section] = await tx.insert(courseSections).values({
        id: randomUUID(), courseId: course.id, termId: b.term_id, name: b.name,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "section.created",
        entityType: "course_section", entityId: section.id, ip: req.ip });
      return section;
    });
  }

  /** Phase 5.3: registrar/admin enrolls a student into a section */
  @Post("sections/:id/enrollments")
  @Perm("academics:write")
  async enroll(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = EnrollBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const [section] = await tx.select({ id: courseSections.id }).from(courseSections)
        .where(eq(courseSections.id, id)).limit(1);
      if (!section) throw new NotFoundException({ code: "not_found" });
      const [student] = await tx.select({ userId: students.userId }).from(students)
        .where(eq(students.userId, parsed.data.student_user_id)).limit(1);
      if (!student) throw new UnprocessableEntityException({ code: "not_a_student" });
      const [existing] = await tx.select({ id: enrollments.id, status: enrollments.status })
        .from(enrollments).where(and(eq(enrollments.sectionId, id),
          eq(enrollments.studentUserId, parsed.data.student_user_id))).limit(1);
      if (existing && existing.status === "enrolled") {
        throw new ConflictException({ code: "already_enrolled" });
      }
      const [row] = await tx.insert(enrollments).values({
        id: randomUUID(), sectionId: id, studentUserId: parsed.data.student_user_id, status: "enrolled",
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "enrollment.created",
        entityType: "course_section", entityId: id,
        after: { student: parsed.data.student_user_id }, ip: req.ip });
      return row;
    });
  }

  /** terms list (reference data — readable by any authenticated actor) */
  @Get("terms")
  async listTerms(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(terms);
      return { data: rows };
    });
  }

  /* ── phase 6: academic years + terms (production has no seed to make them) ── */

  @Get("academic-years")
  @Perm("academics:read")
  async listYears(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      return { data: await tx.select().from(academicYears) };
    });
  }

  @Post("academic-years")
  @Perm("academics:write")
  async createYear(@Req() req: Request, @Body() body: unknown) {
    const parsed = YearBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const b = parsed.data;
    if (b.end_date <= b.start_date) {
      throw new UnprocessableEntityException({ code: "validation", detail: "end_date must be after start_date" });
    }
    const p = req.principal!;
    // SERVICE actor: years_wr RLS is admin-tier; the @Perm gate is the API-level check
    return withActor(this.db, SERVICE, async (tx) => {
      const [dupe] = await tx.select({ id: academicYears.id }).from(academicYears)
        .where(eq(academicYears.name, b.name)).limit(1);
      if (dupe) throw new ConflictException({ code: "year_exists" });
      if (b.make_current) {
        await tx.update(academicYears).set({ isCurrent: false }).where(eq(academicYears.isCurrent, true));
      }
      const [year] = await tx.insert(academicYears).values({
        id: randomUUID(), name: b.name, startDate: b.start_date, endDate: b.end_date,
        isCurrent: b.make_current ?? false,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "academic_year.created",
        entityType: "academic_year", entityId: year.id, after: { name: year.name }, ip: req.ip });
      return year;
    });
  }

  @Post("terms")
  @Perm("academics:write")
  async createTerm(@Req() req: Request, @Body() body: unknown) {
    const parsed = TermBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const b = parsed.data;
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [year] = await tx.select({ id: academicYears.id }).from(academicYears)
        .where(eq(academicYears.id, b.academic_year_id)).limit(1);
      if (!year) throw new NotFoundException({ code: "year_not_found" });
      const [dupe] = await tx.select({ id: terms.id }).from(terms)
        .where(and(eq(terms.academicYearId, b.academic_year_id), eq(terms.termNo, b.term_no))).limit(1);
      if (dupe) throw new ConflictException({ code: "term_exists" });
      const [term] = await tx.insert(terms).values({
        id: randomUUID(), academicYearId: b.academic_year_id, termNo: b.term_no, name: b.name,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "term.created",
        entityType: "term", entityId: term.id, after: { name: term.name }, ip: req.ip });
      return term;
    });
  }

  /** one current year at a time — switching is explicit */
  @Post("academic-years/:id/set-current")
  @Perm("academics:write")
  async setCurrentYear(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [year] = await tx.select({ id: academicYears.id }).from(academicYears)
        .where(eq(academicYears.id, id)).limit(1);
      if (!year) throw new NotFoundException({ code: "year_not_found" });
      await tx.update(academicYears).set({ isCurrent: false }).where(eq(academicYears.isCurrent, true));
      await tx.update(academicYears).set({ isCurrent: true }).where(eq(academicYears.id, id));
      await insertAudit(tx, { actorUserId: p.userId, action: "academic_year.set_current",
        entityType: "academic_year", entityId: id, ip: req.ip });
      return { ok: true };
    });
  }

  /* ── Academic year rollover ───────────────────────────────────────────────
   * Promotion, graduation and carrying the timetable forward. Without this
   * the portal cannot start a second year.
   * ──────────────────────────────────────────────────────────────────────── */

  private rolloverOptions(body: unknown, dryRunDefault: boolean): RolloverOptions {
    const b = (body ?? {}) as Record<string, any>;
    const overrides: Record<string, PupilAction> = {};
    const allowed: PupilAction[] = ["promote", "retain", "graduate", "withdraw", "transfer"];
    for (const o of Array.isArray(b.overrides) ? b.overrides : []) {
      if (o && typeof o.student_user_id === "string" && allowed.includes(o.action)) {
        overrides[o.student_user_id] = o.action;
      }
    }
    return {
      // Dry run is the DEFAULT. Promoting a whole school is not something that
      // should ever happen because a flag was omitted.
      dryRun: b.dry_run === false ? false : dryRunDefault,
      toYearId: typeof b.to_year_id === "string" ? b.to_year_id : undefined,
      nextYear: b.next_year && typeof b.next_year.name === "string" ? {
        name: b.next_year.name,
        startDate: b.next_year.start_date, endDate: b.next_year.end_date,
      } : undefined,
      termTemplate: Array.isArray(b.terms) ? b.terms
        .filter((t: any) => Number.isInteger(t?.term_no) && typeof t?.name === "string")
        .map((t: any) => ({ termNo: t.term_no, name: t.name })) : undefined,
      graduatingGrade: Number.isInteger(b.graduating_grade) ? b.graduating_grade : undefined,
      carrySections: b.carry_sections !== false,
      carryStaff: b.carry_staff !== false,
      setCurrent: b.set_current === true,
      overrides,
    };
  }

  /** What rollover would do — writes nothing. */
  @Post("academic-years/:id/rollover-preview")
  @Perm("academics:write")
  async rolloverPreview(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const opts = this.rolloverOptions(body, true);
    return withActor(this.db, SERVICE, (tx) => planRollover(tx, id, { ...opts, dryRun: true }));
  }

  /**
   * Run the rollover. `dry_run` defaults to true: a caller must explicitly
   * send `dry_run: false` to move every pupil in the school.
   */
  @Post("academic-years/:id/rollover")
  @Perm("academics:write")
  async rollover(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = req.principal!;
    const opts = this.rolloverOptions(body, true);
    return withActor(this.db, SERVICE, async (tx) => {
      if (opts.dryRun) return planRollover(tx, id, opts);
      const result = await commitRollover(tx, id, opts, { userId: p.userId, role: p.activeRole });
      if (result.blockers.length) {
        throw new UnprocessableEntityException({
          code: "rollover_blocked", title: "This rollover cannot run",
          detail: result.blockers.join(" "),
        });
      }
      return result;
    });
  }

  /** Rollover history, newest first. */
  @Get("rollovers")
  @Perm("academics:read")
  async rolloverHistory(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select().from(yearRollovers)
        .orderBy(desc(yearRollovers.performedAt)).limit(50);
      return {
        data: rows.map((r) => ({
          id: r.id, fromYearId: r.fromYearId, toYearId: r.toYearId,
          performedAt: r.performedAt, performedBy: r.performedBy,
          summary: r.summary, revertedAt: r.revertedAt,
          // Per-pupil state can be large and is only needed for the undo.
          pupils: Array.isArray(r.studentStates) ? r.studentStates.length : 0,
        })),
      };
    });
  }

  /** Undo a rollover, restoring every pupil's previous year group. */
  @Post("rollovers/:id/revert")
  @Perm("academics:write")
  async rolloverRevert(@Req() req: Request, @Param("id") id: string) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const res = await revertRollover(tx, id, { userId: p.userId, role: p.activeRole });
      if (!res.ok) {
        throw new UnprocessableEntityException({
          code: "revert_failed", title: "This rollover cannot be reverted", detail: res.detail,
        });
      }
      return res;
    });
  }

  /* ── phase 6: teacher→section assignment (gates attendance/grades/exams) ── */

  @Post("sections/:id/staff")
  @Perm("academics:write")
  async assignStaff(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const parsed = StaffAssignBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const b = parsed.data;
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [sec] = await tx.select({ id: courseSections.id }).from(courseSections)
        .where(eq(courseSections.id, id)).limit(1);
      if (!sec) throw new NotFoundException({ code: "not_found" });
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, b.user_id)).limit(1);
      if (!u) throw new NotFoundException({ code: "user_not_found" });
      const [dupe] = await tx.select({ id: sectionStaff.id }).from(sectionStaff)
        .where(and(eq(sectionStaff.sectionId, id), eq(sectionStaff.userId, b.user_id))).limit(1);
      if (dupe) throw new ConflictException({ code: "already_assigned" });
      // DB CHECK allows ('teacher','assistant')
      const dbRole = b.role === "teacher_assistant" ? "assistant" : "teacher";
      const [row] = await tx.insert(sectionStaff).values({
        id: randomUUID(), sectionId: id, userId: b.user_id, role: dbRole,
      }).returning();
      await insertAudit(tx, { actorUserId: p.userId, action: "section.staff_assigned",
        entityType: "course_section", entityId: id, after: { userId: b.user_id, role: b.role }, ip: req.ip });
      return row;
    });
  }

  @Delete("sections/:id/staff/:userId")
  @Perm("academics:write")
  async unassignStaff(@Req() req: Request, @Param("id") id: string, @Param("userId") userId: string) {
    const p = req.principal!;
    return withActor(this.db, SERVICE, async (tx) => {
      const [row] = await tx.select({ id: sectionStaff.id }).from(sectionStaff)
        .where(and(eq(sectionStaff.sectionId, id), eq(sectionStaff.userId, userId))).limit(1);
      if (!row) throw new NotFoundException({ code: "not_found" });
      await tx.delete(sectionStaff).where(eq(sectionStaff.id, row.id));
      await insertAudit(tx, { actorUserId: p.userId, action: "section.staff_unassigned",
        entityType: "course_section", entityId: id, after: { userId }, ip: req.ip });
      return { ok: true };
    });
  }
}
