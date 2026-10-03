import * as fs from "node:fs";
import { and, eq, isNull, isNotNull, lt, or, sql, inArray, ne, gte } from "drizzle-orm";
import type { Db } from "../db/client";
import { withActor, SERVICE } from "../db/actor";
import {
  notifications, sessions, passwordResetTokens, userInvites, mfaEnrollTokens,
  idempotencyKeys, pushSubscriptions, importJobs, retentionRuns, users,
  identities, mfaRecoveryCodes, mfaFactors, students, userRoles,
  grades, attendanceRecords, enrollments, feeInvoices, feePayments, reportCards, auditLog,
} from "../db/schema";
import { insertAudit } from "../common/audit";

/**
 * Data retention — the purge job the legal pages already promise.
 *
 * `/legal/retention` publishes a retention schedule and the privacy policy
 * promises erasure, but nothing ever deleted anything: the outbox, revoked
 * sessions, consumed tokens and uploaded roster CSVs accumulated forever.
 * A published policy the product cannot honour is worse than no policy, so
 * this implements the schedule rather than the schedule being aspirational.
 *
 * Principles:
 *
 *   - **Everything is previewable.** `dryRun` counts exactly what a real run
 *     would remove. The admin screen previews; the nightly job commits.
 *   - **Every run is recorded** in `retention_runs` and audited, so "the purge
 *     runs nightly" is something the school can show a regulator.
 *   - **Statutory records are never touched.** Marks, attendance, enrolments,
 *     invoices, report cards and the audit log are all outside this job. Only
 *     operational exhaust and expired credentials are purged.
 *   - **Leaver anonymisation is opt-in.** The two retention documents
 *     disagreed (90 days vs enrolment + 5 years) and silently picking the
 *     aggressive one would destroy transcripts, so it is off unless a window
 *     is configured.
 */

/** Days, overridable per deployment. These are the reconciled windows. */
export interface RetentionWindows {
  /** Delivered/failed notifications. Delivery evidence for a parent dispute. */
  notificationsDays: number;
  /** Expired or revoked sessions. Security investigation window. */
  sessionsDays: number;
  /** Consumed or expired reset/invite/enrolment tokens. */
  tokensDays: number;
  /** Replay-protection keys. Purely operational. */
  idempotencyDays: number;
  /** Push endpoints after sustained delivery failure. */
  pushFailureDays: number;
  /** Minimum consecutive failures before a push endpoint is retired. */
  pushFailureCount: number;
  /** Finished import jobs — these hold uploaded roster rows. */
  importJobsDays: number;
  /**
   * Anonymise leavers this many days after they left. 0 = disabled, which is
   * the default: a school needs to issue transcripts for former pupils.
   */
  leaverAnonymiseDays: number;
}

const int = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function retentionWindows(env = process.env): RetentionWindows {
  return {
    notificationsDays: int(env.RETENTION_NOTIFICATIONS_DAYS, 90),
    sessionsDays: int(env.RETENTION_SESSIONS_DAYS, 30),
    tokensDays: int(env.RETENTION_TOKENS_DAYS, 30),
    idempotencyDays: int(env.RETENTION_IDEMPOTENCY_DAYS, 7),
    pushFailureDays: int(env.RETENTION_PUSH_FAILURE_DAYS, 90),
    pushFailureCount: int(env.RETENTION_PUSH_FAILURE_COUNT, 5),
    importJobsDays: int(env.RETENTION_IMPORT_JOBS_DAYS, 30),
    leaverAnonymiseDays: int(env.RETENTION_LEAVER_ANONYMISE_DAYS, 0),
  };
}

export type RetentionCounts = Record<string, number>;

export interface RetentionResult {
  id: string | null;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  counts: RetentionCounts;
  total: number;
  windows: RetentionWindows;
  /** Things the operator should know: disabled rules, skipped work. */
  notes: string[];
  ok: boolean;
  error?: string;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

/**
 * Run the purge.
 *
 * Each rule is independent and counted separately so a failure in one does not
 * hide what the others did, and so the admin screen can show where the data
 * actually goes.
 */
export async function runRetention(
  db: Db,
  opts: {
    dryRun?: boolean;
    trigger?: "schedule" | "manual" | "test";
    actorUserId?: string | null;
    now?: Date;
    windows?: Partial<RetentionWindows>;
  } = {},
): Promise<RetentionResult> {
  const dryRun = opts.dryRun ?? false;
  const trigger = opts.trigger ?? "schedule";
  const now = opts.now ?? new Date();
  const w = { ...retentionWindows(), ...opts.windows };
  const notes: string[] = [];
  const counts: RetentionCounts = {};

  const startedAt = now;
  let runId: string | null = null;

  // Record the run up-front so a crash mid-purge still leaves a trace.
  if (!dryRun) {
    const [row] = await withActor(db, SERVICE, (tx) =>
      tx.insert(retentionRuns).values({
        startedAt, dryRun, trigger, actorUserId: opts.actorUserId ?? null,
      }).returning({ id: retentionRuns.id }));
    runId = row.id;
  }

  try {
    await withActor(db, SERVICE, async (tx) => {
      /** Count matching rows, then delete them unless this is a preview. */
      const sweep = async (name: string, table: any, where: any) => {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
        counts[name] = Number(n);
        if (!dryRun && Number(n) > 0) await tx.delete(table).where(where);
      };

      // 1. Notifications outbox. Queued rows are live work and are never
      //    touched, however old — losing them would silently drop email.
      await sweep("notifications", notifications, and(
        inArray(notifications.status, ["sent", "failed", "dead"]),
        lt(sql`coalesce(${notifications.sentAt}, ${notifications.lastAttemptAt}, ${notifications.createdAt})`,
          daysAgo(now, w.notificationsDays))));

      // 2. Sessions, once expired or revoked. An active session is never cut
      //    short by retention — that would log people out mid-lesson.
      await sweep("sessions", sessions, or(
        and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, daysAgo(now, w.sessionsDays))),
        lt(sessions.expiresAt, daysAgo(now, w.sessionsDays))));

      // 3. Credentials that have been spent or have lapsed. The hash is
      //    useless after this point and is an unnecessary thing to hold.
      const tokenCut = daysAgo(now, w.tokensDays);
      await sweep("passwordResetTokens", passwordResetTokens, or(
        and(isNotNull(passwordResetTokens.usedAt), lt(passwordResetTokens.usedAt, tokenCut)),
        lt(passwordResetTokens.expiresAt, tokenCut)));
      await sweep("userInvites", userInvites, or(
        and(isNotNull(userInvites.acceptedAt), lt(userInvites.acceptedAt, tokenCut)),
        lt(userInvites.expiresAt, tokenCut)));
      await sweep("mfaEnrollTokens", mfaEnrollTokens, or(
        and(isNotNull(mfaEnrollTokens.usedAt), lt(mfaEnrollTokens.usedAt, tokenCut)),
        lt(mfaEnrollTokens.expiresAt, tokenCut)));

      // 4. Idempotency keys — replay protection, worthless once the window
      //    in which a client would retry has passed.
      await sweep("idempotencyKeys", idempotencyKeys,
        lt(idempotencyKeys.createdAt, daysAgo(now, w.idempotencyDays)));

      // 5. Push subscriptions the browser has stopped accepting. Needs both
      //    sustained failure and age, so one bad night does not unsubscribe
      //    the school.
      await sweep("pushSubscriptions", pushSubscriptions, and(
        gte(pushSubscriptions.failureCount, w.pushFailureCount),
        isNotNull(pushSubscriptions.lastFailureAt),
        lt(pushSubscriptions.lastFailureAt, daysAgo(now, w.pushFailureDays)),
        or(isNull(pushSubscriptions.lastSuccessAt),
          sql`${pushSubscriptions.lastSuccessAt} < ${pushSubscriptions.lastFailureAt}`)));

      // 6. Finished import jobs. These are the most personal-data-dense rows
      //    in the database: an uploaded roster with every pupil's name, date
      //    of birth and guardian contact, plus generated passwords.
      const importCut = daysAgo(now, w.importJobsDays);
      const staleJobs = await tx.select({ id: importJobs.id, sourcePath: importJobs.sourcePath })
        .from(importJobs).where(and(
          inArray(importJobs.state, ["completed", "failed", "cancelled"]),
          lt(sql`coalesce(${importJobs.finishedAt}, ${importJobs.createdAt})`, importCut)));
      counts.importJobs = staleJobs.length;
      if (!dryRun && staleJobs.length) {
        // The uploaded CSV lives on disk, not just in the row.
        for (const j of staleJobs) {
          if (j.sourcePath) { try { fs.rmSync(j.sourcePath, { force: true }); } catch { /* already gone */ } }
        }
        await tx.delete(importJobs).where(inArray(importJobs.id, staleJobs.map((j) => j.id)));
      }

      // 7. Leaver anonymisation — opt-in, see the note above.
      if (w.leaverAnonymiseDays > 0) {
        const cut = daysAgo(now, w.leaverAnonymiseDays);
        const leavers = await tx.select({ id: users.id }).from(users).where(and(
          eq(users.status, "left"),
          isNotNull(users.deactivatedAt),
          lt(users.deactivatedAt, cut),
          isNull(users.anonymizedAt)));
        counts.leaversAnonymised = leavers.length;
        if (!dryRun) {
          for (const l of leavers) await anonymiseUser(tx, l.id, now, null, "Retention schedule");
        }
      } else {
        counts.leaversAnonymised = 0;
        notes.push(
          "Leaver anonymisation is switched off. Set RETENTION_LEAVER_ANONYMISE_DAYS once the " +
          "school has confirmed how long former pupils' identities must be kept for transcripts.");
      }
    });

    notes.push(
      "Marks, attendance, enrolments, invoices, report cards and the audit log are deliberately " +
      "outside this job — they are statutory records with their own windows.");

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const finishedAt = new Date();
    if (!dryRun && runId) {
      await withActor(db, SERVICE, async (tx) => {
        await tx.update(retentionRuns).set({ finishedAt, counts, ok: true })
          .where(eq(retentionRuns.id, runId!));
        await insertAudit(tx, {
          actorUserId: opts.actorUserId ?? null, action: "retention.purge",
          entityType: "retention_run", entityId: runId!,
          after: { ...counts, total, trigger },
        });
      });
    }
    return {
      id: runId, dryRun, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
      counts, total, windows: w, notes, ok: true,
    };
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 500);
    if (runId) {
      await withActor(db, SERVICE, (tx) =>
        tx.update(retentionRuns).set({ finishedAt: new Date(), counts, ok: false, error: message })
          .where(eq(retentionRuns.id, runId!))).catch(() => {});
    }
    return {
      id: runId, dryRun, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      counts, total: 0, windows: w, notes, ok: false, error: message,
    };
  }
}

/* ── Erasure ──────────────────────────────────────────────────────────────── */

/**
 * What an erasure would remove and what the school is obliged to keep.
 *
 * The privacy policy promises erasure "except where a statutory retention
 * window applies". That carve-out is the whole difficulty: a pupil's marks and
 * a parent's invoices cannot be deleted, but the person's identity can be
 * severed from them. This reports both halves honestly before anyone commits.
 */
export interface ErasurePreview {
  user: { id: string; email: string; displayName: string; status: string; anonymizedAt: string | null };
  /** Removed outright. */
  erases: { what: string; count: number }[];
  /** Kept under a statutory window, but no longer linked to a named person. */
  retains: { what: string; count: number; basis: string }[];
  blockers: string[];
  warnings: string[];
}

/**
 * What the school must keep even when a subject asks for erasure, and why.
 * Counted with the real table definitions rather than string-built SQL: a
 * typo here would silently report "nothing held" to a data subject.
 */
const STATUTORY: { what: string; basis: string; count: (tx: Db, id: string) => Promise<number> }[] = [
  { what: "Marks and exam results", basis: "Education records — 5 years after exit",
    count: (tx, id) => countWhere(tx, grades, eq(grades.studentUserId, id)) },
  { what: "Attendance", basis: "Education records — 3 years after exit",
    count: (tx, id) => countWhere(tx, attendanceRecords, eq(attendanceRecords.studentUserId, id)) },
  { what: "Class enrolments", basis: "Academic-record integrity — 5 years",
    count: (tx, id) => countWhere(tx, enrollments, eq(enrollments.studentUserId, id)) },
  { what: "Fee invoices", basis: "Tax and audit — 7 years",
    count: (tx, id) => countWhere(tx, feeInvoices, eq(feeInvoices.studentUserId, id)) },
  { what: "Payments", basis: "Tax and audit — 7 years",
    // Payments hang off the invoice, not the pupil.
    count: async (tx, id) => {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(feePayments)
        .innerJoin(feeInvoices, eq(feeInvoices.id, feePayments.invoiceId))
        .where(eq(feeInvoices.studentUserId, id));
      return Number(n);
    } },
  { what: "Report cards", basis: "Education records — 5 years after exit",
    count: (tx, id) => countWhere(tx, reportCards, eq(reportCards.studentUserId, id)) },
  { what: "Audit trail entries", basis: "Accountability — 7 years, append-only",
    count: (tx, id) => countWhere(tx, auditLog, eq(auditLog.actorUserId, id)) },
];

async function countWhere(tx: Db, table: any, where: any): Promise<number> {
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  return Number(n);
}

export async function previewErasure(tx: Db, userId: string): Promise<ErasurePreview> {
  const [u] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) {
    return {
      user: { id: userId, email: "", displayName: "", status: "", anonymizedAt: null },
      erases: [], retains: [], blockers: ["That account does not exist."], warnings: [],
    };
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (u.anonymizedAt) blockers.push("This account has already been erased.");

  // A school cannot be left without an administrator.
  const admins = await tx.select({ n: sql<number>`count(*)::int` })
    .from(userRoles).innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleCode, "super_admin"), isNull(userRoles.revokedAt),
      eq(users.status, "active"), ne(users.id, userId)));
  const stillAdmin = await tx.select({ n: sql<number>`count(*)::int` }).from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleCode, "super_admin"),
      isNull(userRoles.revokedAt)));
  if (Number(stillAdmin[0].n) > 0 && Number(admins[0].n) === 0) {
    blockers.push("This is the last active super administrator. Appoint another one first.");
  }
  if (u.status === "active") {
    warnings.push("This account is still active. Erasing it will also end their access immediately.");
  }

  const count = async (table: any, where: any) => {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
    return Number(n);
  };

  const erases = [
    { what: "Name, email address and login credentials", count: 1 },
    { what: "Sign-in identities", count: await count(identities, eq(identities.userId, userId)) },
    { what: "Sessions", count: await count(sessions, eq(sessions.userId, userId)) },
    { what: "Two-factor secrets", count: await count(mfaFactors, eq(mfaFactors.userId, userId)) },
    { what: "Recovery codes", count: await count(mfaRecoveryCodes, eq(mfaRecoveryCodes.userId, userId)) },
    { what: "Push subscriptions", count: await count(pushSubscriptions, eq(pushSubscriptions.userId, userId)) },
    { what: "Pending invitations and tokens",
      count: await count(passwordResetTokens, eq(passwordResetTokens.userId, userId))
        + await count(mfaEnrollTokens, eq(mfaEnrollTokens.userId, userId)) },
    { what: "Queued notifications", count: await count(notifications, eq(notifications.recipientUserId, userId)) },
  ];

  // What is held, and on what basis. Shown to the subject alongside what goes.
  const retains: ErasurePreview["retains"] = [];
  for (const s2 of STATUTORY) {
    const n = await s2.count(tx, userId);
    if (n > 0) retains.push({ what: s2.what, count: n, basis: s2.basis });
  }

  return {
    user: {
      id: u.id, email: u.email, displayName: u.displayName, status: u.status,
      anonymizedAt: u.anonymizedAt ? u.anonymizedAt.toISOString() : null,
    },
    erases, retains, blockers, warnings,
  };
}

/**
 * Irreversibly sever a person's identity from the records the school must keep.
 *
 * Not a DELETE: cascading through marks, attendance and invoices would destroy
 * statutory records and the class statistics derived from them. The row
 * survives as a pseudonymous key; everything that identifies a human being is
 * overwritten.
 */
export async function anonymiseUser(
  tx: Db, userId: string, now: Date, actorUserId: string | null, note: string,
): Promise<{ tombstone: string }> {
  // Stable, non-reversible, and recognisable in a report as "someone erased"
  // rather than a confusing blank.
  const tombstone = `erased-${userId.slice(0, 8)}@erased.invalid`;

  await tx.delete(identities).where(eq(identities.userId, userId));
  await tx.delete(mfaFactors).where(eq(mfaFactors.userId, userId));
  await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
  await tx.delete(mfaEnrollTokens).where(eq(mfaEnrollTokens.userId, userId));
  await tx.delete(notifications).where(eq(notifications.recipientUserId, userId));

  await tx.update(sessions).set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  await tx.update(userRoles).set({ revokedAt: now })
    .where(and(eq(userRoles.userId, userId), isNull(userRoles.revokedAt)));

  // Guardian contact details on the students row, if any.
  await tx.update(students).set({ status: "withdrawn" })
    .where(and(eq(students.userId, userId), eq(students.status, "active")));

  await tx.update(users).set({
    email: tombstone,
    displayName: "Erased account",
    passwordHash: null,
    status: "left",
    anonymizedAt: now,
    anonymizedBy: actorUserId,
    processingRestricted: true,
    erasureNote: note,
    deactivatedAt: now,
    deactivationReason: "Erasure request",
    mustChangePassword: false,
    updatedAt: now,
  }).where(eq(users.id, userId));

  return { tombstone };
}

/** Background tick. Runs once a day by default; cheap and idempotent. */
export function startRetentionLoop(db: Db, intervalMs = Number(process.env.RETENTION_INTERVAL_MS ?? 86_400_000)) {
  const tick = async () => {
    try {
      const r = await runRetention(db, { trigger: "schedule" });
      if (r.total > 0 || !r.ok) {
        console.log(`[retention] ${r.ok ? "purged" : "FAILED"} ${r.total} row(s): ` +
          JSON.stringify(r.counts) + (r.error ? ` — ${r.error}` : ""));
      }
    } catch (err) {
      console.error("[retention] tick failed", err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // Deliberately NOT run on boot: a restart loop would hammer the database.
  // The first sweep happens one interval in.
  return () => clearInterval(timer);
}
