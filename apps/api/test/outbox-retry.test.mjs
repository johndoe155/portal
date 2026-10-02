/**
 * Outbox retry behaviour, against a real database.
 *
 * The bug these exist to prevent: "a failed email is marked `failed`
 * permanently. One SMTP hiccup loses someone's reset link."
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.COOKIE_SECURE = "false";
process.env.WORKER_INPROC = "false";
process.env.PUBLIC_WEB_ORIGIN = "http://127.0.0.1:3000";

const require = createRequire(import.meta.url);
const { createDb } = require("../dist/db/client.js");
const { runMigrations } = require("../dist/db/migrate.js");
const { withActor, SERVICE } = require("../dist/db/actor.js");
const { notifications, users, schoolSettings } = require("../dist/db/schema.js");
const {
  processQueue, enqueue, requeueNotification, outboxStats, reclaimStaleLocks,
} = require("../dist/notify/notify.service.js");
const { eq, sql } = require("drizzle-orm");

let db, userId;

/** A mailer that fails the first `failTimes` sends, then succeeds. */
function flakyMailer(failTimes, error = Object.assign(new Error("421 service not available"), { responseCode: 421 })) {
  const sent = [];
  let calls = 0;
  return {
    sent,
    get calls() { return calls; },
    sendMail: async (opts) => {
      calls++;
      if (calls <= failTimes) throw error;
      sent.push(opts);
      return { messageId: `m${calls}` };
    },
  };
}

/** Pull a row straight from the table (bypassing the queue helpers). */
async function row(id) {
  return withActor(db, SERVICE, async (tx) => {
    const [r] = await tx.select().from(notifications).where(eq(notifications.id, id)).limit(1);
    return r;
  });
}

/** Make a queued row due now, so a retry can be observed without waiting. */
async function makeDue(id) {
  await withActor(db, SERVICE, (tx) =>
    tx.update(notifications).set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(notifications.id, id)));
}

async function enqueueOne(kind = "password_reset", payload = { link: "http://127.0.0.1:3000/reset?token=x" }) {
  const [r] = await withActor(db, SERVICE, async (tx) => {
    await enqueue(tx, { recipientUserId: userId, channel: "email", kind, payload });
    return tx.select({ id: notifications.id }).from(notifications)
      .orderBy(sql`created_at DESC`).limit(1);
  });
  return r.id;
}

before(async () => {
  const created = await createDb();
  db = created.db;
  await runMigrations(created.runner);
  await withActor(db, SERVICE, async (tx) => {
    const [u] = await tx.insert(users).values({
      email: "parent@school.test", displayName: "Ada Parent", passwordHash: "x",
    }).returning({ id: users.id });
    userId = u.id;
    // Migration 0007 already inserts the single settings row, and the table
    // has no INSERT policy under RLS — name it by UPDATE.
    await tx.update(schoolSettings).set({ name: "Test School" })
      .where(eq(schoolSettings.id, 1));
  });
});

test("a transient SMTP failure re-queues instead of failing forever", async () => {
  const id = await enqueueOne();
  const mailer = flakyMailer(1);

  const r1 = await processQueue(db, { mailer });
  assert.equal(r1.retrying, 1, "first failure schedules a retry");
  assert.equal(r1.failed, 0, "and does NOT mark it failed");

  const after1 = await row(id);
  assert.equal(after1.status, "queued", "row stays queued");
  assert.equal(after1.attempts, 1);
  assert.match(after1.lastError, /421/);
  assert.ok(new Date(after1.nextAttemptAt) > new Date(), "backoff pushes the next attempt into the future");
  assert.equal(after1.lockedAt, null, "claim lock released");

  // Not due yet — a second tick must leave it alone.
  const r2 = await processQueue(db, { mailer });
  assert.equal(r2.processed, 0, "backoff is respected; row not retried early");

  await makeDue(id);
  const r3 = await processQueue(db, { mailer });
  assert.equal(r3.sent, 1, "the retry delivers the reset link");
  assert.equal((await row(id)).status, "sent");
  assert.equal(mailer.sent.length, 1);
  assert.match(mailer.sent[0].subject, /Reset your Test School password/);
});

test("retries are exhausted into 'dead', not lost silently", async () => {
  const id = await enqueueOne();
  const mailer = flakyMailer(Infinity);

  let guard = 0;
  while (guard++ < 10) {
    await makeDue(id);
    await processQueue(db, { mailer });
    const r = await row(id);
    if (r.status !== "queued") break;
  }

  const final = await row(id);
  assert.equal(final.status, "dead", "ends up dead-lettered, visible to an admin");
  assert.equal(final.attempts, 6, "after exactly MAIL_MAX_ATTEMPTS attempts");
  assert.ok(final.lastError, "with the last SMTP error retained for diagnosis");
});

test("permanent failures are not retried at all", async () => {
  const id = await enqueueOne();
  const hardBounce = Object.assign(new Error("550 5.1.1 no such user"), { responseCode: 550 });
  const mailer = flakyMailer(Infinity, hardBounce);

  const r = await processQueue(db, { mailer });
  assert.equal(r.failed, 1, "classified as permanent");
  assert.equal(r.retrying, 0, "no pointless retry against a dead mailbox");

  const after = await row(id);
  assert.equal(after.status, "failed");
  assert.equal(after.failedPermanently, true);
  assert.equal(after.attempts, 1, "exactly one attempt was made");
});

test("an admin can requeue a dead letter and it delivers", async () => {
  const id = await enqueueOne();
  await processQueue(db, { mailer: flakyMailer(Infinity, Object.assign(new Error("550 nope"), { responseCode: 550 })) });
  assert.equal((await row(id)).status, "failed");

  await withActor(db, SERVICE, (tx) => requeueNotification(tx, id));
  const requeued = await row(id);
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.attempts, 0);
  assert.equal(requeued.failedPermanently, false);

  const good = flakyMailer(0);
  const r = await processQueue(db, { mailer: good });
  assert.equal(r.sent, 1, "requeued message delivers on the next tick");
  assert.equal((await row(id)).status, "sent");
});

test("SMTP I/O does not happen inside a database transaction", async () => {
  // Regression guard: the original worker held one transaction open across
  // every network send in the batch. If that returns, this query (issued from
  // inside sendMail, on a separate connection) would deadlock or block.
  const id = await enqueueOne();
  let observedDuringSend = null;
  const mailer = {
    sendMail: async () => {
      observedDuringSend = await withActor(db, SERVICE, async (tx) => {
        const [r] = await tx.select({ status: notifications.status, lockedBy: notifications.lockedBy })
          .from(notifications).where(eq(notifications.id, id)).limit(1);
        return r;
      });
      return {};
    },
  };
  await processQueue(db, { mailer, workerId: "test-worker" });
  assert.ok(observedDuringSend, "a concurrent read completed while mail was being sent");
  assert.equal(observedDuringSend.status, "queued", "row still queued mid-flight");
  assert.equal(observedDuringSend.lockedBy, "test-worker", "and visibly claimed by this worker");
});

test("stale claim locks from a crashed worker are reclaimed", async () => {
  const id = await enqueueOne();
  await withActor(db, SERVICE, (tx) =>
    tx.update(notifications)
      .set({ lockedAt: new Date(Date.now() - 60 * 60_000), lockedBy: "dead-worker" })
      .where(eq(notifications.id, id)));

  await reclaimStaleLocks(db, 10 * 60_000);
  const after = await row(id);
  assert.equal(after.lockedBy, null, "stale lock cleared");
  assert.equal(after.status, "queued", "and the row is deliverable again");
});

test("outbox stats expose queue depth and dead letters for monitoring", async () => {
  const stats = await outboxStats(db);
  for (const k of ["queued", "sent", "failed", "dead", "oldestQueuedAgeSeconds", "mailConfigured"]) {
    assert.ok(k in stats, `stats expose ${k}`);
  }
  assert.ok(stats.sent >= 2, `sent counted: ${stats.sent}`);
  assert.ok(stats.dead >= 1, `dead counted: ${stats.dead}`);
  assert.equal(stats.mailConfigured, false, "no SMTP_URL in tests");
});

test("delivered mail carries both MIME parts and real headers", async () => {
  await enqueueOne("user_invite", { display_name: "New Teacher", acceptUrl: "http://127.0.0.1:3000/invite?token=t" });
  const mailer = flakyMailer(0);
  await processQueue(db, { mailer });
  const msg = mailer.sent.at(-1);
  assert.ok(msg.text && msg.html, "both parts present");
  assert.ok(msg.html.includes("<!DOCTYPE html>"));
  assert.ok(msg.text.includes("http://127.0.0.1:3000/invite?token=t"), "invite link survives encryption round-trip");
  assert.equal(msg.headers["Auto-Submitted"], "auto-generated");
  assert.ok(!/\{\s*"/.test(msg.text), "no JSON dump");
});
