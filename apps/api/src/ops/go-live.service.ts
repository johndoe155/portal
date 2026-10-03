import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { withActor, SERVICE } from "../db/actor";
import {
  users, userRoles, students, guardians, academicYears, terms, courseSections,
  schoolSettings, gradingConfig, mfaFactors, retentionRuns, notifications, enrollments,
} from "../db/schema";
import { mailConfigured } from "../notify/mailer";
import { backupFreshness } from "./backup-heartbeat";
import { config } from "../config";

/**
 * Go-live readiness.
 *
 * The pilot runbook ends with a prose checklist — "confirm SMTP works",
 * "confirm backups are fresh", "confirm the DPO email is set". A checklist in
 * a markdown file is a checklist nobody runs, and most of these are things
 * that look fine right up until the morning they matter: email silently going
 * nowhere, backups never actually written, a privacy policy pointing at an
 * address that does not exist.
 *
 * This turns the prose into something the school can look at and see is
 * green. Severity matters: `fail` means do not let a real pupil near this
 * yet; `warn` means it will work but somebody will be unhappy.
 */
export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  id: string;
  group: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Where to go to fix it. */
  fix?: string;
}

export interface Readiness {
  ready: boolean;
  checkedAt: string;
  summary: { pass: number; warn: number; fail: number };
  checks: Check[];
}

const STAFF_ROLES = ["super_admin", "school_admin", "registrar", "teacher",
  "teacher_assistant", "counselor", "auditor", "finance"];

export async function goLiveReadiness(db: Db): Promise<Readiness> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  await withActor(db, SERVICE, async (tx) => {
    const n = async (table: any, where?: any) => {
      const q = tx.select({ c: sql<number>`count(*)::int` }).from(table);
      const [r] = await (where ? q.where(where) : q);
      return Number(r.c);
    };

    /* ── Identity and legal ─────────────────────────────────────────────── */
    const [school] = await tx.select().from(schoolSettings).where(eq(schoolSettings.id, 1)).limit(1);

    add({
      id: "school_name", group: "School identity", label: "School name set",
      status: school?.name && school.name !== "School Portal" ? "pass" : "fail",
      detail: school?.name && school.name !== "School Portal"
        ? `Branded as "${school.name}".`
        : "Every email, report card and page header still says \"School Portal\".",
      fix: "/admin/school",
    });

    // The one legal check that is genuinely blocking: the privacy policy and
    // retention policy both tell data subjects to write to the DPO. If there
    // is no address, those pages describe rights nobody can exercise.
    add({
      id: "dpo_email", group: "School identity", label: "Data Protection Officer contact",
      status: school?.dpoEmail ? "pass" : "fail",
      detail: school?.dpoEmail
        ? `Published on the legal pages as ${school.dpoEmail}.`
        : "The privacy and retention policies tell people to contact the DPO, but no address is " +
          "configured — so the rights those pages promise cannot be exercised.",
      fix: "/admin/school",
    });

    add({
      id: "contact_email", group: "School identity", label: "General contact address",
      status: school?.contactEmail ? "pass" : "warn",
      detail: school?.contactEmail
        ? `Shown on the terms of service as ${school.contactEmail}.`
        : "The terms of service have nowhere for a parent to send a question.",
      fix: "/admin/school",
    });

    /* ── Email ──────────────────────────────────────────────────────────── */
    add({
      id: "smtp", group: "Email", label: "Outbound email configured",
      status: mailConfigured() ? "pass" : "fail",
      detail: mailConfigured()
        ? "SMTP_URL is set; the worker verifies the connection at start-up."
        : "SMTP_URL is not set. Every email — invitations, password resets, absence alerts — " +
          "goes to a local sink and is never delivered. Nobody can be invited to the portal.",
      fix: "Set SMTP_URL (see docs/email-setup.md)",
    });

    const dead = await n(notifications, sql`status in ('failed','dead')`);
    add({
      id: "outbox", group: "Email", label: "Nothing stuck in the outbox",
      status: dead === 0 ? "pass" : dead < 10 ? "warn" : "fail",
      detail: dead === 0 ? "No undeliverable email." :
        `${dead} message(s) could not be delivered. Usually a wrong address or a rejected sender ` +
        "— check SPF/DKIM before the school relies on email.",
      fix: "/admin/notifications",
    });

    /* ── Backups ────────────────────────────────────────────────────────── */
    const backup = backupFreshness();
    add({
      id: "backup_fresh", group: "Backups", label: "A recent backup exists",
      status: !backup.configured ? "fail" : backup.stale ? "fail" : "pass",
      detail: !backup.configured
        ? "No backup has ever been recorded. A school's data is irreplaceable; do not go live."
        : backup.stale
          ? `The last successful backup was ${backup.ageHours}h ago.`
          : `Last backup ${backup.ageHours}h ago.`,
      fix: "docs/backup-restore.md",
    });
    add({
      id: "backup_offsite", group: "Backups", label: "Backups are copied off this host",
      status: backup.offsite ? "pass" : "fail",
      detail: backup.offsite
        ? "Uploaded to the configured bucket."
        : "Backups exist only on this host. The failure that destroys the database destroys them too.",
      fix: "Set the backup bucket credentials (docs/backup-restore.md)",
    });
    const rt = backup.restoreTest;
    add({
      id: "restore_drill", group: "Backups", label: "Restore has been tested",
      status: rt?.result === "passed" && !rt.stale ? "pass"
        : rt?.result === "failed" ? "fail" : "warn",
      detail: rt?.result === "passed"
        ? (rt.stale ? `The last drill passed but was ${rt.ageDays} days ago.` : "The weekly drill passes.")
        : rt?.result === "failed"
          ? `The last restore drill FAILED${rt.detail ? `: ${rt.detail}` : ""}. These backups may be unusable.`
          : "No restore drill has ever run. An untested backup is an assumption, not a backup.",
      fix: "scripts/restore-drill.sh",
    });

    /* ── Security ───────────────────────────────────────────────────────── */
    add({
      id: "app_secret", group: "Security", label: "Production secret set",
      status: config.isProduction ? "pass"
        : process.env.APP_SECRET ? "pass" : "fail",
      detail: process.env.APP_SECRET
        ? "APP_SECRET is configured."
        : "Running on the built-in development secret. Every MFA secret in the database is " +
          "encrypted with a key that is published in this repository.",
      fix: "Set APP_SECRET to 32+ random characters",
    });

    add({
      id: "demo_seed", group: "Security", label: "No demo accounts",
      status: process.env.SEED_DEMO === "true" ? "fail" : "pass",
      detail: process.env.SEED_DEMO === "true"
        ? "SEED_DEMO is on: demo accounts with the published password Passw0rd! exist, and " +
          "/health/dev-enroll-tokens hands out MFA enrolment tokens to anyone who asks."
        : "Demo seeding is off.",
      fix: "Unset SEED_DEMO and re-provision the database",
    });

    // Staff two-factor coverage. Admin accounts are the ones worth attacking.
    const staff = await tx.selectDistinct({ id: users.id }).from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(and(inArray(userRoles.roleCode, STAFF_ROLES),
        isNull(userRoles.revokedAt), eq(users.status, "active")));
    const enrolledIds = await tx.selectDistinct({ id: mfaFactors.userId }).from(mfaFactors);
    const enrolledSet = new Set(enrolledIds.map((r) => r.id));
    const covered = staff.filter((s) => enrolledSet.has(s.id)).length;
    const pct = staff.length ? Math.round((covered / staff.length) * 100) : 100;
    add({
      id: "mfa_coverage", group: "Security", label: "Staff two-factor enrolment",
      status: staff.length === 0 ? "warn" : pct === 100 ? "pass" : pct >= 80 ? "warn" : "fail",
      detail: staff.length === 0
        ? "No staff accounts exist yet."
        : `${covered} of ${staff.length} staff enrolled (${pct}%). Unenrolled staff cannot sign in ` +
          "once enforcement is on, and a staff account without two-factor is the easiest way into " +
          "the whole school's records.",
      fix: "/admin/users → Two-factor rollout",
    });

    const admins = await n(userRoles,
      and(eq(userRoles.roleCode, "super_admin"), isNull(userRoles.revokedAt)));
    add({
      id: "admin_bus_factor", group: "Security", label: "More than one administrator",
      status: admins >= 2 ? "pass" : "warn",
      detail: admins >= 2
        ? `${admins} super administrators.`
        : "Only one super administrator. If they lose their phone, nobody can administer the portal.",
      fix: "/admin/users",
    });

    /* ── Calendar and roster ────────────────────────────────────────────── */
    const [currentYear] = await tx.select().from(academicYears)
      .where(eq(academicYears.isCurrent, true)).limit(1);
    add({
      id: "current_year", group: "Calendar", label: "Current academic year set",
      status: currentYear ? "pass" : "fail",
      detail: currentYear ? `${currentYear.name} is current.`
        : "No year is marked current, so terms, enrolments and report cards have nothing to hang on.",
      fix: "/admin/academics",
    });
    const termCount = currentYear ? await n(terms, eq(terms.academicYearId, currentYear.id)) : 0;
    add({
      id: "terms", group: "Calendar", label: "Terms defined",
      status: termCount > 0 ? "pass" : "fail",
      detail: termCount > 0 ? `${termCount} term(s) in the current year.`
        : "The current year has no terms. Attendance and grading both need one.",
      fix: "/admin/academics",
    });

    const [grading] = await tx.select().from(gradingConfig).limit(1);
    add({
      id: "grading", group: "Calendar", label: "Grading scale configured",
      status: grading ? "pass" : "warn",
      detail: grading ? "A grading scale is set."
        : "No grading scale, so report cards will show raw percentages with no letter grades.",
      fix: "/admin/academics → Grading scale",
    });

    const studentCount = await n(students, eq(students.status, "active"));
    add({
      id: "roster", group: "Roster", label: "Pupils imported",
      status: studentCount > 0 ? "pass" : "fail",
      detail: studentCount > 0 ? `${studentCount} active pupil(s).` : "No pupils on the roll yet.",
      fix: "/admin/import",
    });

    const unenrolled = await n(students, and(eq(students.status, "active"),
      sql`NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_user_id = ${students.userId}
        AND e.status = 'enrolled')`));
    add({
      id: "enrolments", group: "Roster", label: "Every pupil is in a class",
      status: studentCount === 0 ? "warn" : unenrolled === 0 ? "pass" : "warn",
      detail: unenrolled === 0 && studentCount > 0
        ? "Every active pupil has at least one class."
        : `${unenrolled} pupil(s) are not enrolled in any class, so they will not appear on any ` +
          "register or report card.",
      fix: "/admin/reports → Reconciliation",
    });

    const noGuardian = await n(students, and(eq(students.status, "active"),
      sql`NOT EXISTS (SELECT 1 FROM guardians g WHERE g.student_user_id = ${students.userId}
        AND g.verified_at IS NOT NULL AND g.ended_at IS NULL)`));
    add({
      id: "guardians", group: "Roster", label: "Pupils have a verified guardian",
      status: studentCount === 0 ? "warn" : noGuardian === 0 ? "pass" : "warn",
      detail: noGuardian === 0 && studentCount > 0
        ? "Every active pupil has a verified guardian."
        : `${noGuardian} pupil(s) have no verified guardian, so nobody receives their absence ` +
          "alerts or fee reminders.",
      fix: "/admin/students",
    });

    const emptySections = await n(courseSections,
      sql`NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.section_id = ${courseSections.id}
        AND e.status = 'enrolled')`);
    add({
      id: "empty_sections", group: "Roster", label: "No empty classes",
      status: emptySections === 0 ? "pass" : "warn",
      detail: emptySections === 0 ? "Every class has pupils in it."
        : `${emptySections} class(es) have no pupils. Usually a half-finished import.`,
      fix: "/admin/sections",
    });

    /* ── Compliance ─────────────────────────────────────────────────────── */
    const [lastPurge] = await tx.select().from(retentionRuns)
      .where(and(eq(retentionRuns.ok, true), eq(retentionRuns.dryRun, false)))
      .orderBy(sql`started_at desc`).limit(1);
    const purgeAgeH = lastPurge?.finishedAt
      ? (Date.now() - lastPurge.finishedAt.getTime()) / 3_600_000 : null;
    add({
      id: "retention", group: "Compliance", label: "Retention purge is running",
      status: purgeAgeH != null && purgeAgeH < 48 ? "pass" : "warn",
      detail: purgeAgeH != null
        ? `Last purge ${Math.round(purgeAgeH)}h ago.`
        : "The purge has never completed. The retention policy published at /legal/retention is " +
          "not being enforced — most likely the worker process is not running.",
      fix: "/admin/retention",
    });
  });

  const summary = {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
  return {
    // Warnings do not block: a school with three pupils missing a guardian
    // should still be allowed to start. Failures do.
    ready: summary.fail === 0,
    checkedAt: new Date().toISOString(),
    summary,
    checks,
  };
}
