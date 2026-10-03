/**
 * Data retention and erasure.
 *
 * /legal/retention published a retention schedule and the privacy policy
 * promised erasure on request, but nothing in the product deleted anything
 * and there was no erasure path at all. These tests pin down the two things
 * that make the published policy honest: the purge removes what it says it
 * removes, and erasure severs identity without destroying the records the
 * school is legally required to keep.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.COOKIE_SECURE = "false";
process.env.WORKER_INPROC = "false";

const require = createRequire(import.meta.url);
const { createDb } = require("../dist/db/client.js");
const { runMigrations } = require("../dist/db/migrate.js");
const { seed } = require("../dist/seed.js");
const { createApp } = require("../dist/app.factory.js");
const { totpCode } = require("../dist/crypto/totp.js");
const { withActor, SERVICE } = require("../dist/db/actor.js");
const { issueEnrollToken } = require("../dist/auth/enroll-token.js");
const { hashPassword } = require("../dist/crypto/password.js");
const {
  runRetention, retentionWindows, previewErasure,
} = require("../dist/retention/retention.service.js");
const {
  users, userRoles, sessions, notifications, passwordResetTokens, userInvites,
  mfaEnrollTokens, idempotencyKeys, importJobs, retentionRuns,
  identities, mfaFactors, grades, feeInvoices, auditLog, students,
} = require("../dist/db/schema.js");
const { eq, sql, and, desc } = require("drizzle-orm");
const { randomUUID, createHash } = require("node:crypto");
const request = require("supertest");

let app, server, db;
const jars = {};
const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY);

function cookiesOf(res) {
  const out = {};
  for (const c of res.headers["set-cookie"] ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}
const auth = (n) => ({ Cookie: `sid=${jars[n].sid}; csrf=${jars[n].csrf}`, "x-csrf": jars[n].csrf });
async function uidOf(email) {
  const [u] = await withActor(db, SERVICE, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  return u.id;
}
async function staffLogin(name, email) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password: "Passw0rd!" });
  jars[name] = cookiesOf(res);
  const token = await issueEnrollToken(db, await uidOf(email), null);
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll").set(auth(name)).send({ token });
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}
const countOf = async (table, where) => {
  const [r] = await withActor(db, SERVICE, (tx) => {
    const q = tx.select({ n: sql`count(*)::int` }).from(table);
    return where ? q.where(where) : q;
  });
  return Number(r.n);
};

/** A user with a full spread of personal data hanging off them. */
async function makeSubject(email, roleCode = "teacher") {
  const id = randomUUID();
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(users).values({
      id, email, displayName: "Subject Person", status: "active",
      passwordHash: await hashPassword("Passw0rd!"),
    });
    await tx.insert(userRoles).values({ id: randomUUID(), userId: id, roleCode });
    await tx.insert(identities).values({ userId: id, provider: "test", subject: id });
    await tx.insert(sessions).values({
      id: randomUUID(), userId: id, tokenHash: createHash("sha256").update(id).digest("hex"),
      activeRole: roleCode, expiresAt: new Date(Date.now() + DAY),
    });
    await tx.insert(mfaFactors).values({
      id: randomUUID(), userId: id, kind: "totp", label: "phone", secretEnc: "x",
    });
    await tx.insert(notifications).values({
      id: randomUUID(), recipientUserId: id, channel: "email", kind: "test", status: "queued",
    });
  });
  return id;
}

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");
});
after(async () => { await app.close(); });

/* ── The purge ──────────────────────────────────────────────────────────── */

test("a dry run reports what it would delete and deletes nothing", async () => {
  const id = randomUUID();
  await withActor(db, SERVICE, (tx) => tx.insert(notifications).values({
    id, channel: "email", kind: "old", status: "sent",
    recipientEmail: "x@example.com", sentAt: ago(200), createdAt: ago(200),
  }));

  const res = await runRetention(db, { dryRun: true, trigger: "test" });
  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.ok(res.counts.notifications >= 1, "it found the old notification");
  assert.equal(res.id, null, "a preview does not create a run record");

  assert.equal(await countOf(notifications, eq(notifications.id, id)), 1,
    "a preview must not delete anything");
});

test("delivered notifications older than the window are purged, queued ones never are", async () => {
  const old = randomUUID(), fresh = randomUUID(), queued = randomUUID();
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(notifications).values([
      { id: old, channel: "email", kind: "k", status: "sent", recipientEmail: "a@x.com",
        sentAt: ago(120), createdAt: ago(120) },
      { id: fresh, channel: "email", kind: "k", status: "sent", recipientEmail: "b@x.com",
        sentAt: ago(10), createdAt: ago(10) },
      // Ancient but still queued: this is live work, losing it silently drops email.
      { id: queued, channel: "email", kind: "k", status: "queued", recipientEmail: "c@x.com",
        createdAt: ago(400) },
    ]);
  });

  await runRetention(db, { trigger: "test" });

  assert.equal(await countOf(notifications, eq(notifications.id, old)), 0);
  assert.equal(await countOf(notifications, eq(notifications.id, fresh)), 1);
  assert.equal(await countOf(notifications, eq(notifications.id, queued)), 1,
    "an undelivered notification is never purged, however old");
});

test("expired and revoked sessions go; live ones stay", async () => {
  const uid = await uidOf("t1@school.example");
  const expired = randomUUID(), revoked = randomUUID(), live = randomUUID();
  await withActor(db, SERVICE, (tx) => tx.insert(sessions).values([
    { id: expired, userId: uid, tokenHash: expired, activeRole: "teacher", expiresAt: ago(60) },
    { id: revoked, userId: uid, tokenHash: revoked, activeRole: "teacher",
      expiresAt: new Date(Date.now() + DAY), revokedAt: ago(60) },
    { id: live, userId: uid, tokenHash: live, activeRole: "teacher",
      expiresAt: new Date(Date.now() + DAY) },
  ]));

  await runRetention(db, { trigger: "test" });

  assert.equal(await countOf(sessions, eq(sessions.id, expired)), 0);
  assert.equal(await countOf(sessions, eq(sessions.id, revoked)), 0);
  assert.equal(await countOf(sessions, eq(sessions.id, live)), 1,
    "retention must never log an active user out");
});

test("spent credentials are purged; live ones survive", async () => {
  const uid = await uidOf("t2@school.example");
  const usedReset = randomUUID(), liveReset = randomUUID();
  const oldInvite = randomUUID(), liveInvite = randomUUID();
  const usedEnroll = randomUUID();
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(passwordResetTokens).values([
      { id: usedReset, userId: uid, tokenHash: usedReset, expiresAt: ago(60), usedAt: ago(60) },
      { id: liveReset, userId: uid, tokenHash: liveReset, expiresAt: new Date(Date.now() + 3600_000) },
    ]);
    await tx.insert(userInvites).values([
      { id: oldInvite, email: "a@x.com", displayName: "A", roleCodes: "[]",
        tokenHash: oldInvite, expiresAt: ago(60) },
      { id: liveInvite, email: "b@x.com", displayName: "B", roleCodes: "[]",
        tokenHash: liveInvite, expiresAt: new Date(Date.now() + 7 * DAY) },
    ]);
    await tx.insert(mfaEnrollTokens).values({
      id: usedEnroll, userId: uid, tokenHash: usedEnroll, expiresAt: ago(90), usedAt: ago(90),
    });
    await tx.insert(idempotencyKeys).values({
      key: "old-key", userId: uid, path: "/x", method: "POST", createdAt: ago(30),
    });
  });

  const res = await runRetention(db, { trigger: "test" });

  assert.equal(await countOf(passwordResetTokens, eq(passwordResetTokens.id, usedReset)), 0);
  assert.equal(await countOf(passwordResetTokens, eq(passwordResetTokens.id, liveReset)), 1,
    "a reset token someone is about to click is not retention exhaust");
  assert.equal(await countOf(userInvites, eq(userInvites.id, oldInvite)), 0);
  assert.equal(await countOf(userInvites, eq(userInvites.id, liveInvite)), 1);
  assert.equal(await countOf(mfaEnrollTokens, eq(mfaEnrollTokens.id, usedEnroll)), 0);
  assert.ok(res.counts.idempotencyKeys >= 1);
});

test("finished import jobs are purged — they hold whole uploaded rosters", async () => {
  const oldJob = randomUUID(), runningJob = randomUUID();
  const uid = await uidOf("admin@school.example");
  await withActor(db, SERVICE, (tx) => tx.insert(importJobs).values([
    { id: oldJob, kind: "students", state: "completed", requestedBy: uid, actorRole: "school_admin",
      createdAt: ago(90), finishedAt: ago(90),
      secrets: [{ email: "pupil@x.com", password: "Temp123!" }] },
    { id: runningJob, kind: "students", state: "running", requestedBy: uid,
      actorRole: "school_admin", createdAt: ago(90) },
  ]));

  await runRetention(db, { trigger: "test" });

  assert.equal(await countOf(importJobs, eq(importJobs.id, oldJob)), 0,
    "an old import job carries pupil names and generated passwords");
  assert.equal(await countOf(importJobs, eq(importJobs.id, runningJob)), 1,
    "a job still running is not purged out from under the worker");
});

test("statutory records are never touched by the purge", async () => {
  // The whole risk of a purge job is that it reaches somewhere it should not.
  const before = {
    grades: await countOf(grades),
    invoices: await countOf(feeInvoices),
    audit: await countOf(auditLog),
    students: await countOf(students),
  };
  await runRetention(db, { trigger: "test" });
  assert.equal(await countOf(grades), before.grades);
  assert.equal(await countOf(feeInvoices), before.invoices);
  assert.equal(await countOf(students), before.students);
  assert.ok(await countOf(auditLog) >= before.audit, "the audit log only ever grows");
});

test("leaver anonymisation is off unless a window is configured", async () => {
  const id = await makeSubject(`leaver-${randomUUID().slice(0, 6)}@school.example`);
  await withActor(db, SERVICE, (tx) => tx.update(users)
    .set({ status: "left", deactivatedAt: ago(400) }).where(eq(users.id, id)));

  const off = await runRetention(db, { trigger: "test" });
  assert.equal(off.counts.leaversAnonymised, 0);
  assert.match(off.notes.join(" "), /Leaver anonymisation is switched off/);
  const [still] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(users).where(eq(users.id, id)).limit(1));
  assert.equal(still.anonymizedAt, null, "a former pupil's transcript identity is not binned by default");

  // With a window configured it does happen.
  const on = await runRetention(db, { trigger: "test", windows: { leaverAnonymiseDays: 90 } });
  assert.ok(on.counts.leaversAnonymised >= 1);
  const [now] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(users).where(eq(users.id, id)).limit(1));
  assert.ok(now.anonymizedAt);
  assert.match(now.email, /@erased\.invalid$/);
});

test("every committed run is recorded and audited", async () => {
  const before = await countOf(retentionRuns);
  const res = await runRetention(db, { trigger: "test" });
  assert.ok(res.id);
  assert.equal(await countOf(retentionRuns), before + 1);

  const [row] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(retentionRuns).where(eq(retentionRuns.id, res.id)).limit(1));
  assert.equal(row.ok, true);
  assert.ok(row.finishedAt);

  const [entry] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, "retention.purge"))
      .orderBy(desc(auditLog.occurredAt)).limit(1));
  assert.ok(entry, "a regulator will ask for evidence the purge ran");
});

test("the purge is idempotent — a second run finds nothing left", async () => {
  await runRetention(db, { trigger: "test" });
  const second = await runRetention(db, { trigger: "test" });
  assert.equal(second.counts.notifications, 0);
  assert.equal(second.counts.sessions, 0);
  assert.equal(second.counts.idempotencyKeys, 0);
});

/* ── The admin surface ──────────────────────────────────────────────────── */

test("the retention screen shows the windows and the run history", async () => {
  const res = await request(server).get("/api/v1/admin/retention").set(auth("admin"));
  assert.equal(res.status, 200);
  assert.equal(res.body.windows.notificationsDays, 90);
  assert.equal(res.body.windows.sessionsDays, 30);
  assert.ok(res.body.runs.length >= 1);
  assert.ok(res.body.lastRun, "the most recent committed run is surfaced");
});

test("a manual purge previews unless dry_run is explicitly false", async () => {
  const before = await countOf(retentionRuns);
  const res = await request(server).post("/api/v1/admin/retention/run")
    .set(auth("admin")).send({});
  assert.equal(res.status, 201);
  assert.equal(res.body.dryRun, true, "omitting dry_run must not delete anything");
  assert.equal(await countOf(retentionRuns), before, "a preview leaves no run record");
});

test("retention is admin-only", async () => {
  await staffLogin("t1", "t1@school.example");
  assert.equal((await request(server).get("/api/v1/admin/retention").set(auth("t1"))).status, 403);
  assert.equal((await request(server).post("/api/v1/admin/retention/run")
    .set(auth("t1")).send({ dry_run: false })).status, 403);
});

/* ── Erasure ────────────────────────────────────────────────────────────── */

test("the erasure preview separates what goes from what the school must keep", async () => {
  const email = `erase-me-${randomUUID().slice(0, 6)}@school.example`;
  const id = await makeSubject(email);

  const res = await request(server).get(`/api/v1/users/${id}/erasure-preview`).set(auth("admin"));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, email);

  const erased = Object.fromEntries(res.body.erases.map((e) => [e.what, e.count]));
  assert.equal(erased["Sign-in identities"], 1);
  assert.equal(erased["Two-factor secrets"], 1);
  assert.ok(erased["Name, email address and login credentials"] >= 1);
  assert.match(res.body.warnings.join(" "), /still active/);
  assert.deepEqual(res.body.blockers, []);
});

test("erasure needs the exact email typed back", async () => {
  const email = `confirm-${randomUUID().slice(0, 6)}@school.example`;
  const id = await makeSubject(email);

  const wrong = await request(server).post(`/api/v1/users/${id}/erasure`)
    .set(auth("admin")).send({ confirm_email: "something-else@example.com" });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, "confirmation_mismatch");

  const [untouched] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(users).where(eq(users.id, id)).limit(1));
  assert.equal(untouched.email, email, "a failed confirmation changes nothing");
});

test("erasure removes identity and leaves statutory records standing", async () => {
  const email = `subject-${randomUUID().slice(0, 6)}@school.example`;
  const id = await makeSubject(email);
  const gradesBefore = await countOf(grades);

  const res = await request(server).post(`/api/v1/users/${id}/erasure`)
    .set(auth("admin")).send({ confirm_email: email, reason: "Parent request, 2026-10-03" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.tombstone, /@erased\.invalid$/);

  const [u] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(users).where(eq(users.id, id)).limit(1));
  assert.notEqual(u.email, email);
  assert.equal(u.displayName, "Erased account");
  assert.equal(u.passwordHash, null, "they cannot sign in again");
  assert.equal(u.status, "left");
  assert.ok(u.anonymizedAt);
  assert.equal(u.processingRestricted, true);
  assert.match(u.erasureNote, /Parent request/);

  // Everything identifying is gone.
  assert.equal(await countOf(identities, eq(identities.userId, id)), 0);
  assert.equal(await countOf(mfaFactors, eq(mfaFactors.userId, id)), 0);
  assert.equal(await countOf(notifications, eq(notifications.recipientUserId, id)), 0);

  // Sessions revoked, roles revoked — access ends immediately.
  const [live] = await withActor(db, SERVICE, (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(sessions)
      .where(and(eq(sessions.userId, id), sql`revoked_at is null`)));
  assert.equal(Number(live.n), 0);

  // But the row itself survives as a pseudonymous key, and nothing statutory moved.
  assert.ok(u.id);
  assert.equal(await countOf(grades), gradesBefore);
});

test("an erasure is audited, including the identity that was removed", async () => {
  // The audit log is append-only and under its own 7-year window; an
  // unattributable erasure would defeat the point of having a log at all.
  const [entry] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, "user.erased"))
      .orderBy(desc(auditLog.occurredAt)).limit(1));
  assert.ok(entry);
  assert.match(entry.beforeJson.email, /subject-/);
  assert.match(entry.afterJson.tombstone, /@erased\.invalid$/);
});

test("erasing the same account twice is refused", async () => {
  const email = `twice-${randomUUID().slice(0, 6)}@school.example`;
  const id = await makeSubject(email);
  const first = await request(server).post(`/api/v1/users/${id}/erasure`)
    .set(auth("admin")).send({ confirm_email: email });
  assert.equal(first.status, 201);

  const second = await request(server).post(`/api/v1/users/${id}/erasure`)
    .set(auth("admin")).send({ confirm_email: email });
  assert.equal(second.status, 422);
  assert.equal(second.body.code, "erasure_blocked");
  assert.match(second.body.detail, /already been erased/);
});

test("the last super administrator cannot be erased", async () => {
  const rootId = await uidOf("root@school.example");
  const preview = await withActor(db, SERVICE, (tx) => previewErasure(tx, rootId));
  assert.match(preview.blockers.join(" "), /last active super administrator/);
});

test("an administrator cannot erase someone above their own tier", async () => {
  const rootEmail = "root@school.example";
  const rootId = await uidOf(rootEmail);
  // Give root a peer so the "last super admin" blocker is not what stops us.
  const peer = randomUUID();
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(users).values({ id: peer, email: `peer-${peer.slice(0, 6)}@school.example`,
      displayName: "Peer Root", status: "active" });
    await tx.insert(userRoles).values({ id: randomUUID(), userId: peer, roleCode: "super_admin" });
  });

  const res = await request(server).post(`/api/v1/users/${rootId}/erasure`)
    .set(auth("admin")).send({ confirm_email: rootEmail });
  assert.equal(res.status, 403, JSON.stringify(res.body));
});

test("erasures are listed for the regulator", async () => {
  const res = await request(server).get("/api/v1/admin/erasures").set(auth("admin"));
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length >= 2);
  for (const r of res.body.data) {
    assert.ok(r.anonymizedAt);
    assert.equal(r.restricted, true);
  }
});

test("an erased account can no longer sign in", async () => {
  const email = `login-${randomUUID().slice(0, 6)}@school.example`;
  const id = await makeSubject(email);
  const ok = await request(server).post("/api/v1/auth/login").send({ email, password: "Passw0rd!" });
  assert.equal(ok.status, 201, "sanity: the account worked before erasure");

  await request(server).post(`/api/v1/users/${id}/erasure`)
    .set(auth("admin")).send({ confirm_email: email });

  const after = await request(server).post("/api/v1/auth/login").send({ email, password: "Passw0rd!" });
  assert.notEqual(after.status, 201);
});

test("the configured windows are overridable per deployment", async () => {
  const w = retentionWindows({ RETENTION_SESSIONS_DAYS: "7", RETENTION_NOTIFICATIONS_DAYS: "nonsense" });
  assert.equal(w.sessionsDays, 7);
  assert.equal(w.notificationsDays, 90, "a bad value falls back rather than deleting everything");
});
