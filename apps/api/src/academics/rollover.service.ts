import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  academicYears, terms, courseSections, sectionStaff, students, users,
  enrollments, yearRollovers, userRoles, sessions,
} from "../db/schema";
import { insertAudit } from "../common/audit";

/**
 * Academic year rollover.
 *
 * Without this the portal is a one-year tool: no way to start a new year,
 * move pupils up, or graduate the leaving cohort. A school reaching July
 * would have had to edit the database by hand.
 *
 * Design constraints that shaped this:
 *
 *   - It touches every pupil at once, so it must be previewable. Dry run is
 *     the default; committing requires saying so explicitly.
 *   - It must be idempotent. A half-finished rollover that someone re-runs
 *     must not promote everyone twice — Year 7 becoming Year 9 overnight
 *     would be very hard to unpick.
 *   - It must be reversible. Rolling over a week early, or with the wrong
 *     graduating year, is an easy mistake; the per-pupil before-state is
 *     recorded so it can be put back.
 *   - It must not touch history. Last year's enrolments, marks, attendance
 *     and invoices stay exactly where they are — they are the school's
 *     records, and the new year is additive.
 */

/** The schema caps grade_level at 13; promoting past it is a data error. */
export const MAX_GRADE = 13;

export type PupilAction = "promote" | "retain" | "graduate" | "withdraw" | "transfer";

export interface RolloverOptions {
  dryRun: boolean;
  /** Reuse an existing year, or create one from `nextYear`. */
  toYearId?: string;
  nextYear?: { name: string; startDate: string; endDate: string };
  /** Terms to create in the new year. Defaults to copying the outgoing year's. */
  termTemplate?: { termNo: number; name: string }[];
  /** Pupils at this grade leave rather than move up. */
  graduatingGrade?: number;
  carrySections: boolean;
  carryStaff: boolean;
  /** Make the new year current when committing. */
  setCurrent: boolean;
  overrides: Record<string, PupilAction>;
}

export interface PupilPlan {
  studentUserId: string;
  displayName: string;
  admissionNo: string;
  fromGrade: number;
  toGrade: number | null;
  action: PupilAction;
  /** True when an override changed what would have happened. */
  overridden: boolean;
}

export interface RolloverPlan {
  dryRun: boolean;
  alreadyDone: boolean;
  fromYear: { id: string; name: string };
  toYear: { id: string | null; name: string; created: boolean };
  terms: { termNo: number; name: string; created: boolean }[];
  pupils: PupilPlan[];
  counts: Record<PupilAction, number> & { total: number };
  sections: { carried: number; skipped: number; detail: { name: string; course: string; reason?: string }[] };
  warnings: string[];
  blockers: string[];
  rolloverId?: string;
}

const EMPTY_COUNTS = (): Record<PupilAction, number> & { total: number } =>
  ({ promote: 0, retain: 0, graduate: 0, withdraw: 0, transfer: 0, total: 0 });

/**
 * Work out what rollover would do. Used both for the preview and, unchanged,
 * as the plan the commit executes — so what the registrar approved is exactly
 * what runs.
 */
export async function planRollover(
  tx: Db, fromYearId: string, opts: RolloverOptions,
): Promise<RolloverPlan> {
  const warnings: string[] = [];
  const blockers: string[] = [];

  const [fromYear] = await tx.select().from(academicYears)
    .where(eq(academicYears.id, fromYearId)).limit(1);
  if (!fromYear) {
    return {
      dryRun: opts.dryRun, alreadyDone: false,
      fromYear: { id: fromYearId, name: "(unknown)" },
      toYear: { id: null, name: "", created: false },
      terms: [], pupils: [], counts: EMPTY_COUNTS(),
      sections: { carried: 0, skipped: 0, detail: [] },
      warnings: [], blockers: ["That academic year does not exist."],
    };
  }

  // ── Target year ───────────────────────────────────────────────────────────
  let toYear: { id: string | null; name: string; created: boolean };
  if (opts.toYearId) {
    const [existing] = await tx.select().from(academicYears)
      .where(eq(academicYears.id, opts.toYearId)).limit(1);
    if (!existing) blockers.push("The target academic year does not exist.");
    toYear = { id: existing?.id ?? null, name: existing?.name ?? "(unknown)", created: false };
  } else if (opts.nextYear?.name) {
    const [clash] = await tx.select({ id: academicYears.id }).from(academicYears)
      .where(eq(academicYears.name, opts.nextYear.name)).limit(1);
    if (clash) {
      // Reuse rather than refuse: re-running after a partial failure is normal.
      toYear = { id: clash.id, name: opts.nextYear.name, created: false };
      warnings.push(`An academic year named "${opts.nextYear.name}" already exists; it will be reused.`);
    } else {
      toYear = { id: null, name: opts.nextYear.name, created: true };
    }
  } else {
    blockers.push("Choose or name the academic year to roll into.");
    toYear = { id: null, name: "", created: false };
  }
  if (toYear.id && toYear.id === fromYearId) {
    blockers.push("The outgoing and incoming years are the same.");
  }

  // ── Already done? ─────────────────────────────────────────────────────────
  let alreadyDone = false;
  if (toYear.id) {
    const [prev] = await tx.select().from(yearRollovers).where(and(
      eq(yearRollovers.fromYearId, fromYearId),
      eq(yearRollovers.toYearId, toYear.id),
      isNull(yearRollovers.revertedAt))).limit(1);
    if (prev) {
      alreadyDone = true;
      blockers.push(
        `These two years were already rolled over on ${prev.performedAt.toISOString().slice(0, 10)}. ` +
        "Re-running would promote every pupil a second time. Revert that rollover first if it was wrong.");
    }
  }

  // ── Terms ─────────────────────────────────────────────────────────────────
  const sourceTerms = await tx.select().from(terms)
    .where(eq(terms.academicYearId, fromYearId)).orderBy(terms.termNo);
  const template = opts.termTemplate?.length
    ? opts.termTemplate
    : sourceTerms.map((t) => ({ termNo: t.termNo, name: t.name }));
  if (!template.length) {
    warnings.push("The outgoing year has no terms, so none will be created. Add them manually afterwards.");
  }
  const existingTargetTerms = toYear.id
    ? await tx.select().from(terms).where(eq(terms.academicYearId, toYear.id))
    : [];
  const targetTermNos = new Set(existingTargetTerms.map((t) => t.termNo));
  const termPlan = template.map((t) => ({
    termNo: t.termNo, name: t.name, created: !targetTermNos.has(t.termNo),
  }));

  // ── Pupils ────────────────────────────────────────────────────────────────
  const graduatingGrade = opts.graduatingGrade ?? MAX_GRADE;
  const roster = await tx.select({
    userId: students.userId, admissionNo: students.admissionNo,
    gradeLevel: students.gradeLevel, status: students.status,
    displayName: users.displayName, userStatus: users.status,
  }).from(students)
    .innerJoin(users, eq(users.id, students.userId))
    .where(eq(students.status, "active"))
    .orderBy(students.gradeLevel, students.admissionNo);

  const counts = EMPTY_COUNTS();
  const pupils: PupilPlan[] = roster.map((s) => {
    const override = opts.overrides[s.userId];
    const natural: PupilAction = s.gradeLevel >= graduatingGrade ? "graduate" : "promote";
    const action = override ?? natural;
    const toGrade =
      action === "promote" ? s.gradeLevel + 1
      : action === "retain" ? s.gradeLevel
      : null;
    counts[action]++; counts.total++;
    return {
      studentUserId: s.userId, displayName: s.displayName, admissionNo: s.admissionNo,
      fromGrade: s.gradeLevel, toGrade, action, overridden: Boolean(override && override !== natural),
    };
  });

  // A promotion that would exceed the schema's ceiling is a configuration
  // mistake — almost always a graduating grade set too high.
  const overflow = pupils.filter((p) => p.action === "promote" && (p.toGrade ?? 0) > MAX_GRADE);
  if (overflow.length) {
    blockers.push(
      `${overflow.length} pupil(s) would be promoted past Year ${MAX_GRADE}. ` +
      `Set the graduating year to ${MAX_GRADE} or lower, or mark them as graduating individually.`);
  }
  if (!roster.length) {
    warnings.push("No active pupils found, so nobody will be promoted.");
  }
  if (counts.graduate > 0) {
    warnings.push(
      `${counts.graduate} pupil(s) will be marked as graduated and their portal access ended. ` +
      "Their marks, attendance and invoices are kept.");
  }

  // ── Sections ──────────────────────────────────────────────────────────────
  const sections: RolloverPlan["sections"] = { carried: 0, skipped: 0, detail: [] };
  if (opts.carrySections && sourceTerms.length) {
    const srcTermIds = sourceTerms.map((t) => t.id);
    const srcSections = srcTermIds.length
      ? await tx.select({
          id: courseSections.id, name: courseSections.name, courseId: courseSections.courseId,
          termId: courseSections.termId, status: courseSections.status,
        }).from(courseSections).where(and(
          inArray(courseSections.termId, srcTermIds),
          ne(courseSections.status, "archived")))
      : [];
    const termNoById = new Map(sourceTerms.map((t) => [t.id, t.termNo]));
    const plannedTermNos = new Set(termPlan.map((t) => t.termNo));
    for (const s of srcSections) {
      const termNo = termNoById.get(s.termId);
      if (termNo === undefined || !plannedTermNos.has(termNo)) {
        sections.skipped++;
        sections.detail.push({ name: s.name, course: s.courseId, reason: "no matching term in the new year" });
        continue;
      }
      sections.carried++;
      sections.detail.push({ name: s.name, course: s.courseId });
    }
    if (sections.carried) {
      warnings.push(
        `${sections.carried} section(s) will be recreated in the new year, empty. ` +
        "Last year's enrolments, marks and attendance stay with last year's sections.");
    }
  }

  return {
    dryRun: opts.dryRun, alreadyDone,
    fromYear: { id: fromYear.id, name: fromYear.name },
    toYear, terms: termPlan, pupils, counts, sections, warnings, blockers,
  };
}

/**
 * Execute a plan. Everything happens in the caller's transaction, so a failure
 * part-way leaves the school exactly where it started rather than half
 * promoted.
 */
export async function commitRollover(
  tx: Db, fromYearId: string, opts: RolloverOptions,
  actor: { userId: string; role: string },
): Promise<RolloverPlan> {
  const plan = await planRollover(tx, fromYearId, { ...opts, dryRun: false });
  if (plan.blockers.length) return plan;

  const now = new Date();

  // 1. The year itself.
  let toYearId = plan.toYear.id;
  if (!toYearId) {
    toYearId = randomUUID();
    await tx.insert(academicYears).values({
      id: toYearId, name: plan.toYear.name,
      startDate: opts.nextYear!.startDate, endDate: opts.nextYear!.endDate,
      isCurrent: false,
    });
  }
  if (opts.setCurrent) {
    await tx.update(academicYears).set({ isCurrent: false }).where(eq(academicYears.isCurrent, true));
    await tx.update(academicYears).set({ isCurrent: true }).where(eq(academicYears.id, toYearId));
  }

  // 2. Terms.
  const existing = await tx.select().from(terms).where(eq(terms.academicYearId, toYearId));
  const have = new Map(existing.map((t) => [t.termNo, t.id]));
  for (const t of plan.terms) {
    if (have.has(t.termNo)) continue;
    const id = randomUUID();
    await tx.insert(terms).values({ id, academicYearId: toYearId, termNo: t.termNo, name: t.name });
    have.set(t.termNo, id);
  }

  // 3. Sections, carried forward empty.
  let carried = 0;
  if (opts.carrySections) {
    const sourceTerms = await tx.select().from(terms)
      .where(eq(terms.academicYearId, fromYearId)).orderBy(terms.termNo);
    const srcTermIds = sourceTerms.map((t) => t.id);
    if (srcTermIds.length) {
      const termNoById = new Map(sourceTerms.map((t) => [t.id, t.termNo]));
      const srcSections = await tx.select().from(courseSections).where(and(
        inArray(courseSections.termId, srcTermIds), ne(courseSections.status, "archived")));
      for (const s of srcSections) {
        const targetTermId = have.get(termNoById.get(s.termId)!);
        if (!targetTermId) continue;
        // Idempotent: the unique key is (term_id, course_id, name).
        const [dupe] = await tx.select({ id: courseSections.id }).from(courseSections).where(and(
          eq(courseSections.termId, targetTermId), eq(courseSections.courseId, s.courseId),
          eq(courseSections.name, s.name))).limit(1);
        if (dupe) continue;
        const newId = randomUUID();
        await tx.insert(courseSections).values({
          id: newId, courseId: s.courseId, termId: targetTermId, name: s.name, status: "active",
        });
        carried++;
        if (opts.carryStaff) {
          const staff = await tx.select().from(sectionStaff).where(eq(sectionStaff.sectionId, s.id));
          for (const st of staff) {
            await tx.insert(sectionStaff).values({
              id: randomUUID(), sectionId: newId, userId: st.userId, role: st.role,
            });
          }
        }
      }
    }
  }

  // 4. Pupils. Record the prior state first — this is what makes revert real.
  const studentStates = plan.pupils.map((p) => ({
    userId: p.studentUserId, fromGrade: p.fromGrade, action: p.action,
  }));

  const leavers: string[] = [];
  for (const p of plan.pupils) {
    if (p.action === "promote" || p.action === "retain") {
      if (p.toGrade !== p.fromGrade) {
        await tx.update(students).set({ gradeLevel: p.toGrade! })
          .where(eq(students.userId, p.studentUserId));
      }
      continue;
    }
    const studentStatus =
      p.action === "graduate" ? "graduated"
      : p.action === "withdraw" ? "withdrawn"
      : "transferred";
    await tx.update(students).set({ status: studentStatus })
      .where(eq(students.userId, p.studentUserId));
    leavers.push(p.studentUserId);
  }

  // Leavers lose portal access the same way any other leaver does: sessions
  // and roles revoked, records untouched.
  if (leavers.length) {
    await tx.update(sessions).set({ revokedAt: now })
      .where(and(inArray(sessions.userId, leavers), isNull(sessions.revokedAt)));
    await tx.update(userRoles).set({ revokedAt: now })
      .where(and(inArray(userRoles.userId, leavers), isNull(userRoles.revokedAt)));
    await tx.update(users).set({
      status: "left", deactivatedAt: now, deactivatedBy: actor.userId,
      deactivationReason: `Year rollover ${plan.fromYear.name} → ${plan.toYear.name}`,
      updatedAt: now,
    }).where(inArray(users.id, leavers));
  }

  const rolloverId = randomUUID();
  await tx.insert(yearRollovers).values({
    id: rolloverId, fromYearId, toYearId, performedBy: actor.userId, performedAt: now,
    summary: {
      ...plan.counts, sectionsCarried: carried,
      fromYear: plan.fromYear.name, toYear: plan.toYear.name,
    },
    studentStates,
  });

  await insertAudit(tx, {
    actorUserId: actor.userId, action: "academic_year.rolled_over",
    entityType: "academic_year", entityId: toYearId,
    before: { fromYear: plan.fromYear.name },
    after: { toYear: plan.toYear.name, rolloverId, ...plan.counts, sectionsCarried: carried },
  });

  return {
    ...plan, dryRun: false, rolloverId,
    toYear: { ...plan.toYear, id: toYearId },
    sections: { ...plan.sections, carried },
  };
}

/**
 * Undo a rollover: put every pupil back to the grade and status they held
 * before. Sections created in the new year are left alone — a teacher may
 * already have enrolled pupils into them, and silently deleting that would be
 * worse than leaving a few empty sections behind.
 */
export async function revertRollover(
  tx: Db, rolloverId: string, actor: { userId: string; role: string },
): Promise<{ ok: boolean; restored: number; detail: string }> {
  const [r] = await tx.select().from(yearRollovers)
    .where(eq(yearRollovers.id, rolloverId)).limit(1);
  if (!r) return { ok: false, restored: 0, detail: "No such rollover." };
  if (r.revertedAt) return { ok: false, restored: 0, detail: "That rollover has already been reverted." };

  const states = (r.studentStates ?? []) as { userId: string; fromGrade: number; action: PupilAction }[];
  let restored = 0;
  for (const s of states) {
    await tx.update(students).set({ gradeLevel: s.fromGrade, status: "active" })
      .where(eq(students.userId, s.userId));
    if (s.action !== "promote" && s.action !== "retain") {
      // Leavers created by this rollover get their access back.
      await tx.update(users).set({
        status: "active", deactivatedAt: null, deactivatedBy: null, deactivationReason: null,
      }).where(eq(users.id, s.userId));
      await tx.update(userRoles).set({ revokedAt: null })
        .where(and(eq(userRoles.userId, s.userId), eq(userRoles.revokedAt, r.performedAt)));
    }
    restored++;
  }

  await tx.update(yearRollovers)
    .set({ revertedAt: new Date(), revertedBy: actor.userId })
    .where(eq(yearRollovers.id, rolloverId));

  await insertAudit(tx, {
    actorUserId: actor.userId, action: "academic_year.rollover_reverted",
    entityType: "academic_year", entityId: r.toYearId,
    before: r.summary as object, after: { restored, rolloverId },
  });

  return {
    ok: true, restored,
    detail: `${restored} pupil(s) returned to their previous year group. ` +
      "Sections created by the rollover were left in place in case they are already in use.",
  };
}
