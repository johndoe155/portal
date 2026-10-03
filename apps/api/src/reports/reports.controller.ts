import {
  Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req,
} from "@nestjs/common";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import {
  reportCards, terms, enrollments, courseSections, courses, grades, gradingConfig,
  attendanceRecords, attendanceSessions, guardians, students, users, userRoles,
} from "../db/schema";
import { Perm } from "../common/guards";
import { goLiveReadiness } from "../ops/go-live.service";
import { insertAudit } from "../common/audit";
import { ReportGenerateBody } from "@portal/contracts";
import type { Request } from "express";

const ADMIN_ROLES = new Set(["super_admin", "school_admin"]);

/** Report-card snapshots: point-in-time JSON per student+term (exports:write to generate). */
@Controller()
export class ReportsController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  /**
   * Phase 6 (pre-go-live checks): reconciliation — head-counts per class,
   * parents with no child, students with no guardian/enrolment, unverified
   * links. Admin-tier only (directory:read + role gate).
   */
  @Get("reports/go-live")
  @Perm("directory:read")
  async goLive(@Req() req: Request) {
    const p = req.principal!;
    if (!ADMIN_ROLES.has(p.activeRole)) {
      throw new ForbiddenException({ code: "admin_only" });
    }
    // The runbook's prose checklist, executed. See go-live.service.ts for why
    // each check is a failure rather than a warning.
    return goLiveReadiness(this.db);
  }

  @Get("reports/reconciliation")
  @Perm("directory:read")
  async reconciliation(@Req() req: Request) {
    const p = req.principal!;
    if (!ADMIN_ROLES.has(p.activeRole)) {
      throw new ForbiddenException({ code: "admin_only" });
    }
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const sections = await tx.select({
        id: courseSections.id, name: courseSections.name, code: courses.code,
        headCount: sql<number>`(SELECT count(*)::int FROM enrollments e
          WHERE e.section_id = ${courseSections.id} AND e.status = 'enrolled')`,
      }).from(courseSections).innerJoin(courses, eq(courses.id, courseSections.courseId));

      const parentsWithoutChildren = await tx.select({
        id: users.id, email: users.email, displayName: users.displayName,
      }).from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .where(and(eq(userRoles.roleCode, "parent"), isNull(userRoles.revokedAt),
          sql`NOT EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = ${users.id} AND g.ended_at IS NULL)`));

      const studentsWithoutGuardians = await tx.select({
        userId: students.userId, admissionNo: students.admissionNo, displayName: users.displayName,
      }).from(students).innerJoin(users, eq(users.id, students.userId))
        .where(and(eq(students.status, "active"),
          sql`NOT EXISTS (SELECT 1 FROM guardians g WHERE g.student_user_id = ${students.userId}
            AND g.verified_at IS NOT NULL AND g.ended_at IS NULL)`));

      const studentsWithoutEnrollments = await tx.select({
        userId: students.userId, admissionNo: students.admissionNo,
      }).from(students)
        .where(and(eq(students.status, "active"),
          sql`NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_user_id = ${students.userId}
            AND e.status = 'enrolled')`));

      const [{ pendingLinks }] = await tx.select({
        pendingLinks: sql<number>`count(*)::int`,
      }).from(guardians).where(and(isNull(guardians.verifiedAt), isNull(guardians.endedAt)));

      return {
        sections: sections.map((s) => ({ id: s.id, name: s.name, course: s.code, head_count: s.headCount })),
        parents_without_children: parentsWithoutChildren,
        students_without_guardians: studentsWithoutGuardians,
        students_without_enrollments: studentsWithoutEnrollments,
        pending_guardian_links: pendingLinks,
      };
    });
  }

  @Post("report-cards/generate")
  @Perm("exports:write")
  async generate(@Req() req: Request, @Body() body: unknown) {
    const parsed = ReportGenerateBody.safeParse(body ?? {});
    if (!parsed.success) throw new ForbiddenException({ code: "validation", detail: parsed.error.message });
    const p = req.principal!;

    // read phase runs as the admin actor (RLS still applies); writes run as SERVICE
    // review-6 #1: term_id is REQUIRED — the old fallback silently picked the
    // first term in the table, producing arbitrary report cards.
    const termId = parsed.data.term_id;
    const data = await withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const term = (await tx.select().from(terms).where(eq(terms.id, termId)).limit(1))[0];
      if (!term) throw new NotFoundException({ code: "no_term" });
      // review-6 #1: the school-wide grading scale + weights are read here and
      // baked into every snapshot (report cards are historical documents —
      // later scale edits must not rewrite them).
      const [gc] = await tx.select().from(gradingConfig).where(eq(gradingConfig.id, 1)).limit(1);
      const grading = (gc?.config ?? {}) as {
        scale?: { letter: string; min_pct: number; point: number }[];
        weights?: Record<string, number>;
      };
      const scale = [...(grading.scale ?? [])].sort((a, b) => b.min_pct - a.min_pct);
      const weights = { exam: 70, coursework: 30, ...(grading.weights ?? {}) };
      const letterFor = (pct: number) =>
        scale.find((b) => pct >= b.min_pct) ?? null;
      const categoryOf = (sourceType: string) => (sourceType === "exam" ? "exam" : "coursework");
      const sections = await tx.select({
        id: courseSections.id, name: courseSections.name, code: courses.code,
      }).from(courseSections).innerJoin(courses, eq(courses.id, courseSections.courseId))
        .where(eq(courseSections.termId, term.id));
      const rows: { student: string; snapshot: Record<string, unknown> }[] = [];
      const studentIds = await tx.selectDistinct({ id: enrollments.studentUserId }).from(enrollments)
        .where(and(eq(enrollments.status, "enrolled"),
          sql`${enrollments.sectionId} IN (${sql.join(sections.map((s) => s.id), sql`, `)})`));
      for (const { id: stuId } of studentIds) {
        const perSection = [];
        for (const sec of sections) {
          const [enrolled] = await tx.select({ id: enrollments.id }).from(enrollments)
            .where(and(eq(enrollments.sectionId, sec.id), eq(enrollments.studentUserId, stuId),
              eq(enrollments.status, "enrolled"))).limit(1);
          if (!enrolled) continue;
          const g = await tx.select({
            label: grades.label, points: grades.points, maxPoints: grades.maxPoints,
            sourceType: grades.sourceType, feedbackText: grades.feedbackText,
          }).from(grades).where(and(eq(grades.sectionId, sec.id), eq(grades.studentUserId, stuId),
            isNotNull(grades.releasedAt)));
          const att = await tx.select({
            status: attendanceRecords.status, n: sql<number>`count(*)::int`,
          }).from(attendanceRecords)
            .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
            .where(and(eq(attendanceRecords.studentUserId, stuId),
              eq(attendanceSessions.sectionId, sec.id)))
            .groupBy(attendanceRecords.status);
          // category percentages → weighted percentage → letter/point
          const sums: Record<string, { pts: number; max: number }> = {
            exam: { pts: 0, max: 0 }, coursework: { pts: 0, max: 0 },
          };
          for (const gr of g) {
            const c = categoryOf(gr.sourceType);
            sums[c].pts += Number(gr.points); sums[c].max += Number(gr.maxPoints);
          }
          const pctOf = (c: string) => (sums[c].max > 0 ? (sums[c].pts / sums[c].max) * 100 : null);
          const examPct = pctOf("exam"), courseworkPct = pctOf("coursework");
          let weightedPct: number | null = null;
          {
            let num = 0, den = 0;
            if (examPct !== null) { num += examPct * weights.exam; den += weights.exam; }
            if (courseworkPct !== null) { num += courseworkPct * weights.coursework; den += weights.coursework; }
            if (den > 0) weightedPct = num / den;
          }
          const letter = weightedPct === null ? null : letterFor(weightedPct);
          perSection.push({
            section: sec.name, course: sec.code, grades: g,
            exam_pct: examPct === null ? null : Math.round(examPct * 10) / 10,
            coursework_pct: courseworkPct === null ? null : Math.round(courseworkPct * 10) / 10,
            weighted_pct: weightedPct === null ? null : Math.round(weightedPct * 10) / 10,
            letter: letter?.letter ?? null, point: letter?.point ?? null,
            attendance: Object.fromEntries(att.map((a) => [a.status, a.n])),
          });
        }
        // overall across the student's sections
        const graded = perSection.filter((x) => x.weighted_pct !== null);
        const overallPct = graded.length
          ? graded.reduce((acc, x) => acc + (x.weighted_pct as number), 0) / graded.length : null;
        const points = graded.map((x) => x.point).filter((v): v is number => typeof v === "number");
        const overall = {
          average_pct: overallPct === null ? null : Math.round(overallPct * 10) / 10,
          gpa: points.length ? Math.round((points.reduce((a, b) => a + b, 0) / points.length) * 100) / 100 : null,
          letter: overallPct === null ? null : letterFor(overallPct)?.letter ?? null,
        };
        rows.push({ student: stuId, snapshot: {
          term: term.name, generatedAt: new Date().toISOString(),
          grading: { scale, weights }, sections: perSection, overall,
        } });
      }
      return { termId: term.id, rows };
    });

    const out = await withActor(this.db, SERVICE, async (tx) => {
      for (const r of data.rows) {
        await tx.insert(reportCards).values({
          studentUserId: r.student, termId: data.termId,
          snapshot: r.snapshot, generatedBy: p.userId,
        }).onConflictDoUpdate({
          target: [reportCards.studentUserId, reportCards.termId],
          set: { snapshot: r.snapshot, generatedBy: p.userId, generatedAt: new Date() },
        });
      }
      await insertAudit(tx, { actorUserId: p.userId, action: "report_cards.generated",
        entityType: "term", entityId: data.termId, after: { count: data.rows.length }, ip: req.ip });
      return { generated: data.rows.length, termId: data.termId };
    });
    return out;
  }

  /** self / guardian / admin — RLS is the backstop; role check here gives clean errors */
  @Get("students/:id/report-card")
  async read(@Req() req: Request, @Param("id") id: string, @Query("term_id") termId?: string) {
    const p = req.principal!;
    if (p.activeRole === "student" && p.userId !== id) {
      throw new ForbiddenException({ code: "missing_capability", detail: "own report card only" });
    }
    const isAdmin = ADMIN_ROLES.has(p.activeRole);
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      if (p.activeRole === "parent") {
        const [g] = await tx.select({ id: guardians.id }).from(guardians)
          .where(and(eq(guardians.userId, p.userId), eq(guardians.studentUserId, id),
            sql`${guardians.verifiedAt} IS NOT NULL`, sql`${guardians.endedAt} IS NULL`)).limit(1);
        if (!g) throw new NotFoundException({ code: "not_found" });
      } else if (!isAdmin && p.activeRole !== "student") {
        throw new ForbiddenException({ code: "missing_capability" });
      }
      const filter = termId
        ? and(eq(reportCards.studentUserId, id), eq(reportCards.termId, termId))
        : eq(reportCards.studentUserId, id);
      const rows = await tx.select().from(reportCards).where(filter);
      if (rows.length === 0) throw new NotFoundException({ code: "not_found", detail: "no snapshot yet" });
      return { data: rows };
    });
  }
}
