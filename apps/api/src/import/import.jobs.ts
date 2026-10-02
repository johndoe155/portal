import * as fs from "node:fs";
import { eq, and, inArray, asc, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { withActor, SERVICE } from "../db/actor";
import { importJobs } from "../db/schema";
import { insertAudit } from "../common/audit";
import { mailConfigured } from "../notify/mailer";
import {
  parseImportCsv, planPasswords, processRows, ImportShapeError,
  type ImportKind, type RowResult,
} from "./import.engine";

/**
 * Asynchronous roster import.
 *
 * A real school's enrolments file is ~6,000 rows; students and guardians cost
 * ~100 ms each in scrypt. That is minutes of work — far past an HTTP request's
 * patience and past any sensible transaction lifetime. So:
 *
 *   • the upload is parked on disk and a job row created (HTTP returns 202);
 *   • the worker processes it in batches, committing each one;
 *   • progress is readable at any moment;
 *   • a crash resumes from `processed_rows` — already-committed rows are
 *     skipped, and every kind dedupes on its natural key, so nothing doubles.
 *
 * The per-batch commit is a deliberate trade against whole-file atomicity. The
 * alternative — one transaction for 6,000 rows — holds locks for minutes and
 * loses everything on a single bad row. Re-running a corrected file is safe,
 * which is the property that actually matters to a registrar.
 */

const BATCH_SIZE = () => Math.max(1, Number(process.env.IMPORT_BATCH_SIZE ?? 200));

/** Keep a bounded number of problems on the row; the rest are counted only. */
const MAX_STORED_PROBLEMS = 5000;

export interface JobView {
  id: string;
  kind: string;
  dryRun: boolean;
  state: string;
  filename: string | null;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  duplicateCount: number;
  errorCount: number;
  problems: RowResult[];
  secretCount: number;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  percent: number;
}

export function toJobView(row: any): JobView {
  const total = row.totalRows || 0;
  return {
    id: row.id,
    kind: row.kind,
    dryRun: row.dryRun,
    state: row.state,
    filename: row.filename ?? null,
    totalRows: total,
    processedRows: row.processedRows ?? 0,
    createdCount: row.createdCount ?? 0,
    duplicateCount: row.duplicateCount ?? 0,
    errorCount: row.errorCount ?? 0,
    problems: (row.problems ?? []) as RowResult[],
    secretCount: ((row.secrets ?? []) as unknown[]).length,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    percent: total ? Math.round(((row.processedRows ?? 0) / total) * 100) : 0,
  };
}

/** Claim one pending job. Returns null when there is nothing to do. */
async function claimJob(db: Db, workerId: string) {
  return withActor(db, SERVICE, async (tx) => {
    const rows = await tx.select().from(importJobs)
      .where(inArray(importJobs.state, ["pending"]))
      .orderBy(asc(importJobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const job = rows[0];
    if (!job) return null;
    await tx.update(importJobs).set({
      state: "running", lockedBy: workerId, lockedAt: new Date(),
      startedAt: job.startedAt ?? new Date(),
    }).where(eq(importJobs.id, job.id));
    return job;
  });
}

/**
 * Run a single job to completion. Exported so tests (and the synchronous
 * fallback) can drive it deterministically instead of waiting on a timer.
 */
export async function runJob(db: Db, jobId: string, workerId = "inline"): Promise<JobView> {
  const job = await withActor(db, SERVICE, async (tx) => {
    const [j] = await tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    return j;
  });
  if (!job) throw new Error(`import job ${jobId} not found`);

  const fail = async (message: string) => {
    await withActor(db, SERVICE, (tx) => tx.update(importJobs).set({
      state: "failed", errorMessage: message.slice(0, 1000),
      finishedAt: new Date(), lockedBy: null, lockedAt: null,
    }).where(eq(importJobs.id, jobId)));
  };

  let text: string;
  try {
    text = fs.readFileSync(job.sourcePath!, "utf8");
  } catch (err: any) {
    await fail(`upload could not be read: ${err?.message ?? err}`);
    return refresh(db, jobId);
  }

  let parsed;
  try {
    parsed = parseImportCsv(job.kind as ImportKind, text);
  } catch (err: any) {
    await fail(err instanceof ImportShapeError ? err.message : String(err?.message ?? err));
    cleanupSource(job.sourcePath);
    return refresh(db, jobId);
  }

  const { records } = parsed;
  const total = records.length;
  await withActor(db, SERVICE, (tx) => tx.update(importJobs)
    .set({ totalRows: total, state: "running", lockedBy: workerId, lockedAt: new Date() })
    .where(eq(importJobs.id, jobId)));

  const ctx = {
    kind: job.kind,
    dryRun: job.dryRun,
    actorUserId: job.requestedBy,
    actorRole: job.actorRole,
    smtpConfigured: mailConfigured(),
  };

  // Resume point: rows already committed by a previous (crashed) attempt.
  let offset = job.processedRows ?? 0;
  let created = job.createdCount ?? 0;
  let duplicates = job.duplicateCount ?? 0;
  let errorCount = job.errorCount ?? 0;
  const problems: RowResult[] = ((job.problems ?? []) as RowResult[]).slice();
  const secrets: { row: number; url: string }[] = ((job.secrets ?? []) as any[]).slice();

  try {
    while (offset < total) {
      const slice = records.slice(offset, offset + BATCH_SIZE());

      // Hash OUTSIDE the transaction — scrypt is ~100 ms/row by design.
      const plans = await planPasswords(job.kind, slice, job.dryRun);

      const outcome = await withActor(db, SERVICE, async (tx) => {
        const o = await processRows(tx, slice, plans, ctx);
        // A dry run must write nothing: roll the batch back via a sentinel.
        if (job.dryRun) throw Object.assign(new Error("__dry_run__"), { outcome: o });
        return o;
      }).catch((e: any) => {
        if (e?.message === "__dry_run__") return e.outcome;
        throw e;
      });

      created += outcome.created;
      duplicates += outcome.duplicates;
      errorCount += outcome.errors;
      for (const r of outcome.results) {
        if (r.set_password_url) secrets.push({ row: r.row, url: r.set_password_url });
        if (r.status !== "ok" && problems.length < MAX_STORED_PROBLEMS) {
          problems.push({ row: r.row, status: r.status, errors: r.errors });
        }
      }
      offset += slice.length;

      // Checkpoint after every batch — this is what makes progress visible
      // and makes a crash resumable.
      await withActor(db, SERVICE, (tx) => tx.update(importJobs).set({
        processedRows: offset, createdCount: created, duplicateCount: duplicates,
        errorCount, problems: problems as any, secrets: secrets as any,
        lockedAt: new Date(),
      }).where(eq(importJobs.id, jobId)));
    }

    await withActor(db, SERVICE, async (tx) => {
      await tx.update(importJobs).set({
        state: "completed", finishedAt: new Date(), lockedBy: null, lockedAt: null,
      }).where(eq(importJobs.id, jobId));
      await insertAudit(tx, {
        actorUserId: job.requestedBy,
        action: job.dryRun ? "import.dry_run" : "import.completed",
        entityType: "import_job", entityId: jobId,
        after: { kind: job.kind, rows: total, created, duplicates, errors: errorCount },
      });
    });
  } catch (err: any) {
    await fail(String(err?.message ?? err));
  } finally {
    cleanupSource(job.sourcePath);
  }

  return refresh(db, jobId);
}

function cleanupSource(path: string | null | undefined) {
  // The parked upload holds personal data (names, emails). Delete it as soon
  // as the job is done rather than leaving a roster on disk indefinitely.
  if (!path) return;
  try { fs.unlinkSync(path); } catch { /* already gone */ }
}

async function refresh(db: Db, jobId: string): Promise<JobView> {
  return withActor(db, SERVICE, async (tx) => {
    const [row] = await tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    return toJobView(row);
  });
}

/** Re-queue jobs whose worker died mid-run, so they resume rather than hang. */
export async function reclaimStaleJobs(db: Db, olderThanMs = 10 * 60_000) {
  return withActor(db, SERVICE, async (tx) => {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await tx.select({ id: importJobs.id }).from(importJobs)
      .where(and(eq(importJobs.state, "running"),
        sql`${importJobs.lockedAt} < ${cutoff.toISOString()}`));
    for (const s of stale) {
      await tx.update(importJobs).set({ state: "pending", lockedBy: null, lockedAt: null })
        .where(eq(importJobs.id, s.id));
    }
    return { reclaimed: stale.length };
  });
}

/**
 * Delete parked uploads that no live job refers to.
 *
 * Belt and braces: completed and cancelled jobs remove their own file, but a
 * process killed between "multer wrote the file" and "job row committed"
 * leaves an orphan. These files are rosters — names, emails, admission
 * numbers — so they must not accumulate in a temp directory.
 */
export async function sweepOrphanUploads(db: Db, olderThanMs = 24 * 3_600_000) {
  const dir = process.env.IMPORT_TMP_DIR ?? "./data/imports";
  if (!fs.existsSync(dir)) return { removed: 0 };
  const live = new Set(
    (await withActor(db, SERVICE, (tx) =>
      tx.select({ p: importJobs.sourcePath }).from(importJobs)
        .where(inArray(importJobs.state, ["pending", "running"]))))
      .map((r) => r.p).filter(Boolean) as string[],
  );
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("upload-")) continue;
    const full = require("node:path").resolve(dir, name);
    if (live.has(full)) continue;
    try {
      if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
    } catch { /* raced with another sweeper */ }
  }
  if (removed) console.log(`[import] swept ${removed} orphaned upload(s)`);
  return { removed };
}

/** Worker loop: drain pending import jobs one at a time. */
export function startImportWorker(db: Db, opts: { intervalMs?: number; workerId?: string } = {}) {
  const intervalMs = opts.intervalMs ?? Number(process.env.IMPORT_POLL_MS ?? 3000);
  const workerId = opts.workerId ?? `${process.pid}@${process.env.HOSTNAME ?? "local"}`;
  let running = false;
  let ticks = 0;

  const tick = async () => {
    if (running) return;          // never overlap: imports are heavy
    running = true;
    try {
      if (++ticks % 20 === 0) { await reclaimStaleJobs(db); await sweepOrphanUploads(db); }
      const job = await claimJob(db, workerId);
      if (job) {
        console.log(`[import] running job ${job.id} (${job.kind}${job.dryRun ? ", dry run" : ""})`);
        const view = await runJob(db, job.id, workerId);
        console.log(`[import] job ${job.id} ${view.state}: ${view.createdCount} created, ` +
          `${view.duplicateCount} duplicate, ${view.errorCount} error(s)`);
      }
    } catch (err) {
      console.error("[import] tick failed", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
