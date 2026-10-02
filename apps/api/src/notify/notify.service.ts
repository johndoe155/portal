import { createTransport, type Transporter } from "nodemailer";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { withActor, SERVICE } from "../db/actor";
import { notifications, pushSubscriptions, users, guardians, schoolSettings } from "../db/schema";
import { encryptText, decryptText } from "../crypto/enc";

/**
 * Transactional outbox (Phase 3 §6): feature code enqueues rows inside the SAME
 * actor transaction as the business write, so a notification can never be lost
 * or orphaned. The worker delivers asynchronously and is crash-safe.
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
const SENSITIVE_KINDS = new Set(["password_reset", "mfa_enroll_token", "user_invite"]);

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

/* ── delivery ────────────────────────────────────────────────────────────── */

export interface WorkerOpts {
  mailer?: Transporter;
  pushSinkFile?: string;          // dev: append web-push payloads here instead of sending
  vapid?: { publicKey: string; privateKey: string; subject: string };
  fromAddress?: string;
}

export function createMailer(): Transporter {
  const url = process.env.SMTP_URL;
  return url ? createTransport(url) : createTransport({ jsonTransport: true }); // dev sink
}

function subjectFor(kind: string, payload: any, school: string): string {
  switch (kind) {
    case "absence_recorded": return `Absence recorded on ${payload?.date ?? "today"}`;
    case "grade_released": return "New grades released";
    case "message_received": return `Message from school: ${payload?.subject ?? ""}`;
    case "daily_digest": return `Your daily portal digest — ${payload?.date ?? ""}`;
    case "password_reset": return `Reset your ${school} password`;
    case "mfa_enroll_token": return "Set up two-factor authentication";
    case "user_invite": return `You've been invited to ${school}`;
    case "guardian_verify": return `Confirm your guardian link — ${school}`;
    default: return `${school} notification`;
  }
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

/** Drain up to `limit` queued notifications. Crash-safe: rows flip to sent/failed only after delivery. */
export async function processQueue(db: Db, opts: WorkerOpts = {}, limit = 50) {
  const mailer = opts.mailer ?? createMailer();
  return withActor(db, SERVICE, async (tx) => {
    // phase 6: emails speak with the school's identity (settings row) —
    // sender override first, then MAIL_FROM, then the dev default
    const [school] = await tx.select({ name: schoolSettings.name, mailSender: schoolSettings.mailSender })
      .from(schoolSettings).where(eq(schoolSettings.id, 1)).limit(1);
    const schoolName = school?.name || "School Portal";
    const from = opts.fromAddress ?? school?.mailSender ?? process.env.MAIL_FROM ?? "portal@school.example";
    const queued = await tx.select().from(notifications)
      .where(eq(notifications.status, "queued")).limit(limit);
    let sent = 0, failed = 0;
    for (const n of queued) {
      try {
        // review-2 ops: decrypt sensitive payloads before delivery
        const payload = decryptPayload(n.kind, n.payload as Record<string, unknown>);
        if (n.channel === "email") {
          // review-2 #6: support bare-email recipients (invites — no user row yet)
          let toEmail: string;
          let toName: string;
          if (n.recipientEmail) {
            toEmail = n.recipientEmail;
            toName = (payload.display_name as string) ?? "there";
          } else {
            const [u] = await tx.select({ email: users.email, name: users.displayName })
              .from(users).where(eq(users.id, n.recipientUserId!)).limit(1);
            if (!u) throw new Error("recipient not found");
            toEmail = u.email;
            toName = u.name;
          }
          await mailer.sendMail({
            from, to: toEmail, subject: subjectFor(n.kind, payload, schoolName),
            text: `${toName},\n\n${JSON.stringify(payload, null, 2)}\n\n— ${schoolName}`,
          });
        } else {
          const subs = await tx.select().from(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, n.recipientUserId!));
          if (subs.length === 0) throw new Error("no push subscription");
          for (const s of subs) {
            await deliverPush(
              { endpoint: s.endpoint, p256dh: s.p256dh, authKey: s.authKey },
              { kind: n.kind, payload }, opts);
          }
        }
        await tx.update(notifications)
          .set({ status: "sent", sentAt: new Date(), attempts: (n.attempts ?? 0) + 1, lastError: null })
          .where(eq(notifications.id, n.id));
        sent++;
      } catch (err: any) {
        await tx.update(notifications)
          .set({ status: "failed", attempts: (n.attempts ?? 0) + 1, lastError: String(err?.message ?? err).slice(0, 500) })
          .where(eq(notifications.id, n.id));
        failed++;
      }
    }
    return { processed: queued.length, sent, failed };
  });
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

/** In-process worker (dev / single node). Production: `npm run worker` beside real Postgres. */
export function startWorker(db: Db, opts: WorkerOpts & { intervalMs?: number } = {}) {
  const intervalMs = opts.intervalMs ?? Number(process.env.WORKER_INTERVAL_MS ?? 5000);
  const tick = async () => {
    try {
      const r = await processQueue(db, opts);
      if (r.processed) console.log(`[worker] processed ${r.processed} (sent ${r.sent}, failed ${r.failed})`);
      const d = await runDigest(db);
      if (d.created) console.log(`[worker] digest created for ${d.created} recipient(s)`);
    } catch (err) {
      console.error("[worker] tick failed", err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never keep the process alive just for the worker
  void tick();
  return () => clearInterval(timer);
}
