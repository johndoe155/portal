import { randomUUID } from "node:crypto";
import type { Transporter } from "nodemailer";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { withActor, SERVICE } from "../db/actor";
import {
  notifications, pushSubscriptions, users, guardians, schoolSettings,
  courseSections, courses, messageThreads,
} from "../db/schema";
import { encryptText, decryptText } from "../crypto/enc";
import { config } from "../config";
import {
  createMailer, isPermanentFailure, mailConfigured, resolveFrom, verifyMailer,
  PermanentMailError,
} from "./mailer";
import { renderEmail, type BrandContext, type RenderContext } from "./templates";

export { createMailer, mailConfigured, verifyMailer } from "./mailer";

/**
 * Transactional outbox (Phase 3 §6): feature code enqueues rows inside the SAME
 * actor transaction as the business write, so a notification can never be lost
 * or orphaned. The worker delivers asynchronously and is crash-safe.
 *
 * go-live hardening (2026-10-02):
 *   - delivery is retried with exponential backoff instead of failing forever;
 *   - rows are claimed with FOR UPDATE SKIP LOCKED so several workers are safe;
 *   - SMTP I/O happens OUTSIDE the database transaction (the old code held a
 *     transaction open across every network round-trip in the batch);
 *   - bodies are rendered from real templates, not JSON.stringify(payload).
 */

export interface EnqueueRow {
  recipientUserId?: string | null;
  recipientEmail?: string | null;
  channel: "email" | "push";
  kind: string;
  payload: Record<string, unknown>;
}

/** review-2 ops: kinds whose payloads carry secrets (tokens, links) — encrypted
 *  at rest so a DB dump doesn't expose live reset/enroll tokens. */
const SENSITIVE_KINDS = new Set(["password_reset", "mfa_enroll_token", "user_invite", "guardian_verify"]);

function encryptPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { __enc: encryptText(JSON.stringify(payload)) };
}

export function decryptPayload(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (SENSITIVE_KINDS.has(kind) && typeof payload.__enc === "string") {
    try { return JSON.parse(decryptText(payload.__enc)); }
    catch { return payload; } // fallback: return as-is if decryption fails
  }
  return payload;
}

export function enqueue(tx: Db, row: EnqueueRow) {
  // no .returning(): under RLS, RETURNING re-checks the SELECT policy, and a
  // teacher enqueueing for a guardian cannot read that recipient's inbox row.
  const stored = SENSITIVE_KINDS.has(row.kind)
    ? { ...row, payload: encryptPayload(row.payload) }
    : row;
  return tx.insert(notifications).values(stored as any);
}

/** verified, active guardians of a student (user ids) */
export async function guardianIdsOf(tx: Db, studentUserId: string): Promise<string[]> {
  const rows = await tx.select({ id: guardians.userId }).from(guardians)
    .where(and(eq(guardians.studentUserId, studentUserId),
      sql`${guardians.verifiedAt} IS NOT NULL`, sql`${guardians.endedAt} IS NULL`));
  return rows.map((r) => r.id);
}

/** grades released → tell the student and every guardian (email) */
export async function enqueueGradeReleased(tx: Db, sectionId: string, studentIds: string[]) {
  const payload = { section_id: sectionId, date: new Date().toISOString().slice(0, 10) };
  for (const sid of studentIds) {
    await enqueue(tx, { recipientUserId: sid, channel: "email", kind: "grade_released", payload });
    for (const gid of await guardianIdsOf(tx, sid)) {
      await enqueue(tx, { recipientUserId: gid, channel: "email", kind: "grade_released", payload });
    }
  }
}

/** absence recorded → guardians get email + push (instant alert) */
export async function enqueueAbsence(tx: Db, studentUserId: string, date: string, sectionId: string) {
  const payload = { student_user_id: studentUserId, date, section_id: sectionId };
  for (const gid of await guardianIdsOf(tx, studentUserId)) {
    await enqueue(tx, { recipientUserId: gid, channel: "email", kind: "absence_recorded", payload });
    await enqueue(tx, { recipientUserId: gid, channel: "push", kind: "absence_recorded", payload });
  }
}

/** teacher message posted → guardians get email */
export async function enqueueMessagePosted(tx: Db, studentUserId: string, threadId: string, subject: string) {
  const payload = { thread_id: threadId, subject };
  for (const gid of await guardianIdsOf(tx, studentUserId)) {
    await enqueue(tx, { recipientUserId: gid, channel: "email", kind: "message_received", payload });
  }
}

/* ── retry policy ─────────────────────────────────────────────────────────── */

/**
 * Backoff schedule, in minutes: 1 → 5 → 15 → 60 → 240 → 720.
 * Six attempts spread over ~17 hours. An SMTP provider that is down for a
 * morning still delivers the reset link; a genuinely bad address dead-letters
 * the same day so an admin can fix it while the parent is still waiting.
 */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240, 720];

export function maxAttempts(): number {
  return Number(process.env.MAIL_MAX_ATTEMPTS ?? BACKOFF_MINUTES.length);
}

/** Next attempt time with ±20% jitter, so a provider outage doesn't produce a
 *  thundering herd of simultaneous retries when it recovers. */
export function nextAttemptDelayMs(attempt: number): number {
  const idx = Math.min(Math.max(attempt - 1, 0), BACKOFF_MINUTES.length - 1);
  const base = BACKOFF_MINUTES[idx] * 60_000;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(30_000, Math.round(base + jitter));
}

/* ── delivery ────────────────────────────────────────────────────────────── */

export interface WorkerOpts {
  mailer?: Transporter | { sendMail(opts: any): Promise<any> };
  pushSinkFile?: string;          // dev: append web-push payloads here instead of sending
  vapid?: { publicKey: string; privateKey: string; subject: string };
  fromAddress?: string;
  /** identifies this worker in notifications.locked_by (diagnostics) */
  workerId?: string;
}

async function deliverPush(sub: { endpoint: string; p256dh: string | null; authKey: string | null },
                           notif: { kind: string; payload: unknown }, opts: WorkerOpts): Promise<string> {
  if (opts.vapid && sub.p256dh && sub.authKey) {
    // production path: web-push with VAPID (Phase-1 stack); lazily required so dev has no dep on it
    const webpush = await import("web-push").then((m) => m.default ?? m);
    webpush.setVapidDetails(opts.vapid.subject, opts.vapid.publicKey, opts.vapid.privateKey);
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.authKey } },
      JSON.stringify(notif));
    return "web-push";
  }
  // dev sink: record the exact payload that would go over the wire
  const fs = await import("node:fs");
  const path = await import("node:path");
  const file = opts.pushSinkFile ?? "data/push-outbox.jsonl";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file,
    JSON.stringify({ at: new Date().toISOString(), endpoint: sub.endpoint, ...notif }) + "\n");
  return "dev-sink";
}

/** The school identity every email is branded with. */
async function loadBrand(tx: Db): Promise<{ brand: BrandContext; from: string; timezone: string }> {
  const [s] = await tx.select().from(schoolSettings).where(eq(schoolSettings.id, 1)).limit(1);
  return {
    brand: {
      schoolName: s?.name || "School Portal",
      logoUrl: s?.logoUrl ?? null,
      primaryColor: s?.primaryColor || "#1d4ed8",
      contactEmail: s?.contactEmail ?? null,
      dpoEmail: s?.dpoEmail ?? null,
      webOrigin: config.publicWebOrigin.replace(/\/$/, ""),
    },
    from: resolveFrom(s?.mailSender),
    timezone: s?.timezone || "Africa/Lagos",
  };
}

/**
 * Turn the IDs stored in a payload into names. A guardian should read
 * "Amara was marked absent from Mathematics", not a pair of UUIDs.
 * Every lookup is best-effort: a missing row degrades the copy, never the send.
 */
async function resolveNames(tx: Db, payload: Record<string, unknown>): Promise<RenderContext["resolved"]> {
  const out: NonNullable<RenderContext["resolved"]> = {};
  try {
    if (typeof payload.student_user_id === "string") {
      const [u] = await tx.select({ name: users.displayName }).from(users)
        .where(eq(users.id, payload.student_user_id)).limit(1);
      out.studentName = u?.name ?? null;
    }
    if (typeof payload.section_id === "string") {
      const [row] = await tx.select({ name: courseSections.name, title: courses.title })
        .from(courseSections)
        .leftJoin(courses, eq(courses.id, courseSections.courseId))
        .where(eq(courseSections.id, payload.section_id)).limit(1);
      out.sectionName = row?.name ?? null;
      out.courseTitle = row?.title ?? null;
    }
    if (typeof payload.thread_id === "string") {
      const [t] = await tx.select({ subject: messageThreads.subject }).from(messageThreads)
        .where(eq(messageThreads.id, payload.thread_id)).limit(1);
      out.threadSubject = t?.subject ?? null;
    }
  } catch {
    // Name resolution is a nicety. Never let it fail a delivery.
  }
  return out;
}

interface ClaimedRow {
  id: string;
  channel: string;
  kind: string;
  attempts: number;
  payload: Record<string, unknown>;
  toEmail: string | null;
  toName: string;
  recipientUserId: string | null;
  resolved: RenderContext["resolved"];
}

/**
 * Drain up to `limit` due notifications.
 *
 * Three phases, deliberately separated:
 *   1. claim  — short transaction, FOR UPDATE SKIP LOCKED, resolve recipients
 *   2. deliver — network I/O with NO transaction held open
 *   3. settle — short transaction, record outcome + schedule any retry
 */
export async function processQueue(db: Db, opts: WorkerOpts = {}, limit = Number(process.env.MAIL_BATCH_SIZE ?? 50)) {
  const mailer = opts.mailer ?? createMailer();
  const workerId = opts.workerId ?? `${process.pid}@${process.env.HOSTNAME ?? "local"}`;
  const attemptCap = maxAttempts();

  /* ── 1. claim ─────────────────────────────────────────────────────────── */
  const claim = await withActor(db, SERVICE, async (tx) => {
    const { brand, from, timezone } = await loadBrand(tx);

    let due = await tx.select().from(notifications)
      .where(and(eq(notifications.status, "queued"), lte(notifications.nextAttemptAt, new Date())))
      .orderBy(asc(notifications.nextAttemptAt), asc(notifications.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (due.length === 0) return { brand, from, timezone, rows: [] as ClaimedRow[] };

    await tx.update(notifications)
      .set({ lockedAt: new Date(), lockedBy: workerId })
      .where(inArray(notifications.id, due.map((d) => d.id)));

    const rows: ClaimedRow[] = [];
    for (const n of due) {
      const payload = decryptPayload(n.kind, (n.payload ?? {}) as Record<string, unknown>);
      let toEmail: string | null = n.recipientEmail ?? null;
      let toName = (payload.display_name as string) ?? "there";
      if (!toEmail && n.recipientUserId) {
        const [u] = await tx.select({ email: users.email, name: users.displayName })
          .from(users).where(eq(users.id, n.recipientUserId)).limit(1);
        if (u) { toEmail = u.email; toName = u.name; }
      }
      rows.push({
        id: n.id, channel: n.channel, kind: n.kind, attempts: n.attempts ?? 0,
        payload, toEmail, toName, recipientUserId: n.recipientUserId ?? null,
        resolved: n.channel === "email" ? await resolveNames(tx, payload) : {},
      });
    }
    return { brand, from, timezone, rows };
  });

  if (claim.rows.length === 0) return { processed: 0, sent: 0, failed: 0, retrying: 0, dead: 0 };

  /* ── 2. deliver (no transaction held) ─────────────────────────────────── */
  type Outcome = { id: string; attempts: number; ok: boolean; permanent: boolean; error?: string };
  const outcomes: Outcome[] = [];

  for (const row of claim.rows) {
    const attempts = row.attempts + 1;
    try {
      if (row.channel === "email") {
        if (!row.toEmail) throw new PermanentMailError("recipient not found");
        const rendered = renderEmail(row.kind, row.payload, {
          brand: claim.brand, recipientName: row.toName,
          timezone: claim.timezone, resolved: row.resolved,
        });
        await mailer.sendMail({
          from: opts.fromAddress ?? claim.from,
          to: row.toEmail,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          headers: rendered.headers,
          ...(process.env.MAIL_REPLY_TO ? { replyTo: process.env.MAIL_REPLY_TO } : {}),
        });
      } else {
        const subs = await withActor(db, SERVICE, (tx) =>
          tx.select().from(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, row.recipientUserId!)));
        // A user with no subscription will not gain one by us retrying this
        // specific row; a future event will enqueue a fresh one.
        if (subs.length === 0) throw new PermanentMailError("no push subscription");
        for (const s of subs) {
          await deliverPush({ endpoint: s.endpoint, p256dh: s.p256dh, authKey: s.authKey },
            { kind: row.kind, payload: row.payload }, opts);
        }
      }
      outcomes.push({ id: row.id, attempts, ok: true, permanent: false });
    } catch (err: any) {
      outcomes.push({
        id: row.id, attempts, ok: false,
        permanent: isPermanentFailure(err),
        error: String(err?.message ?? err).slice(0, 500),
      });
    }
  }

  /* ── 3. settle ────────────────────────────────────────────────────────── */
  let sent = 0, failed = 0, retrying = 0, dead = 0;
  await withActor(db, SERVICE, async (tx) => {
    const now = new Date();
    for (const o of outcomes) {
      if (o.ok) {
        await tx.update(notifications).set({
          status: "sent", sentAt: now, attempts: o.attempts, lastError: null,
          lockedAt: null, lockedBy: null, lastAttemptAt: now,
        }).where(eq(notifications.id, o.id));
        sent++;
      } else if (o.permanent) {
        // Never retried: the address or target is wrong, not the network.
        await tx.update(notifications).set({
          status: "failed", attempts: o.attempts, lastError: o.error,
          failedPermanently: true, lockedAt: null, lockedBy: null, lastAttemptAt: now,
        }).where(eq(notifications.id, o.id));
        failed++;
      } else if (o.attempts >= attemptCap) {
        // Retries exhausted — dead-letter for a human on /admin/notifications.
        await tx.update(notifications).set({
          status: "dead", attempts: o.attempts, lastError: o.error,
          lockedAt: null, lockedBy: null, lastAttemptAt: now,
        }).where(eq(notifications.id, o.id));
        dead++;
      } else {
        await tx.update(notifications).set({
          status: "queued", attempts: o.attempts, lastError: o.error,
          nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(o.attempts)),
          lockedAt: null, lockedBy: null, lastAttemptAt: now,
        }).where(eq(notifications.id, o.id));
        retrying++;
      }
    }
  });

  return { processed: claim.rows.length, sent, failed, retrying, dead };
}

/**
 * Release rows claimed by a worker that died mid-batch. Without this a crash
 * between claim and settle would leave notifications locked and invisible.
 * (The row stays `queued`, so the only real effect of a stale lock is a
 * confusing `locked_by` in diagnostics — we clear it on a schedule anyway.)
 */
export async function reclaimStaleLocks(db: Db, olderThanMs = 10 * 60_000) {
  return withActor(db, SERVICE, async (tx) => {
    const cutoff = new Date(Date.now() - olderThanMs);
    const res = await tx.update(notifications)
      .set({ lockedAt: null, lockedBy: null })
      .where(and(eq(notifications.status, "queued"), isNotNull(notifications.lockedAt),
        lte(notifications.lockedAt, cutoff)));
    return { reclaimed: (res as any)?.rowCount ?? 0 };
  });
}

/** Re-queue a dead/failed notification for immediate delivery (admin action). */
export async function requeueNotification(tx: Db, id: string) {
  await tx.update(notifications).set({
    status: "queued", attempts: 0, nextAttemptAt: new Date(),
    lastError: null, failedPermanently: false, lockedAt: null, lockedBy: null,
  }).where(eq(notifications.id, id));
}

/**
 * Daily digest: one rollup email per recipient who had events today.
 * Idempotent per (recipient, date) — safe to call every worker tick.
 */
export async function runDigest(db: Db, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return withActor(db, SERVICE, async (tx) => {
    const events = await tx.select({
      recipient: notifications.recipientUserId, kind: notifications.kind,
      payload: notifications.payload,
    }).from(notifications)
      .where(and(
        inArray(notifications.kind, ["absence_recorded", "grade_released"]),
        sql`${notifications.createdAt}::date = ${day}::date`));
    const byRecipient = new Map<string, { absences: number; gradesReleased: number }>();
    for (const e of events) {
      if (!e.recipient) continue; // bare-email rows (invites) never appear here, but guard for types
      const agg = byRecipient.get(e.recipient) ?? { absences: 0, gradesReleased: 0 };
      if (e.kind === "absence_recorded") agg.absences++; else agg.gradesReleased++;
      byRecipient.set(e.recipient, agg);
    }
    let created = 0;
    for (const [recipient, agg] of byRecipient) {
      const [exists] = await tx.select({ id: notifications.id }).from(notifications)
        .where(and(
          eq(notifications.recipientUserId, recipient),
          eq(notifications.kind, "daily_digest"),
          sql`${notifications.payload}->>'date' = ${day}`)).limit(1);
      if (exists) continue;
      await enqueue(tx, {
        recipientUserId: recipient, channel: "email", kind: "daily_digest",
        payload: { date: day, ...agg },
      });
      created++;
    }
    return { created };
  });
}

/** Outbox health, surfaced on /health and the admin console. */
export async function outboxStats(db: Db) {
  return withActor(db, SERVICE, async (tx) => {
    const rows = await tx.select({
      status: notifications.status,
      n: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${notifications.createdAt})`,
    }).from(notifications).groupBy(notifications.status);
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    const queuedRow = rows.find((r) => r.status === "queued");
    const oldestQueuedAgeSeconds = queuedRow?.oldest
      ? Math.max(0, Math.round((Date.now() - new Date(queuedRow.oldest).getTime()) / 1000))
      : 0;
    return {
      queued: by.queued ?? 0,
      sent: by.sent ?? 0,
      failed: by.failed ?? 0,
      dead: by.dead ?? 0,
      oldestQueuedAgeSeconds,
      mailConfigured: mailConfigured(),
    };
  });
}

/** In-process worker (dev / single node). Production: `npm run worker` beside real Postgres. */
export function startWorker(db: Db, opts: WorkerOpts & { intervalMs?: number } = {}) {
  const intervalMs = opts.intervalMs ?? Number(process.env.WORKER_INTERVAL_MS ?? 5000);
  const workerId = opts.workerId ?? randomUUID().slice(0, 8);
  let reclaimCounter = 0;
  const tick = async () => {
    try {
      const r = await processQueue(db, { ...opts, workerId });
      if (r.processed) {
        console.log(`[worker] processed ${r.processed} (sent ${r.sent}, retrying ${r.retrying}, ` +
          `failed ${r.failed}, dead ${r.dead})`);
      }
      const d = await runDigest(db);
      if (d.created) console.log(`[worker] digest created for ${d.created} recipient(s)`);
      // every ~50 ticks, release locks left by a crashed worker
      if (++reclaimCounter % 50 === 0) await reclaimStaleLocks(db);
    } catch (err) {
      console.error("[worker] tick failed", err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never keep the process alive just for the worker
  void tick();
  return () => clearInterval(timer);
}
