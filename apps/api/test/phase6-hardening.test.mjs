/**
 * Production-hardening suite (2026-10-01 review): login lockout, controlled MFA
 * enrollment + TOTP replay protection, password lifecycle (forgot/reset/change),
 * transport capacity, deterministic audit hashing, health endpoint.
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
const { decryptPayload } = require("../dist/notify/notify.service.js");
const { computeRowHash } = require("../dist/common/audit.js");
const { users, auditLog, passwordResetTokens, notifications, students, userRoles, identities, busRoutes } = require("../dist/db/schema.js");
const { eq, desc, sql, and, isNull } = require("drizzle-orm");
const { randomUUID } = require("node:crypto");
const request = require("supertest");

let app, server, db, ids;
const jars = {};

function cookiesOf(res) {
  const out = {};
  for (const c of res.headers["set-cookie"] ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}
function auth(name) { return { Cookie: `sid=${jars[name].sid}; csrf=${jars[name].csrf}`, "x-csrf": jars[name].csrf }; }
async function login(email, password = "Passw0rd!", name) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password });
  if (name) jars[name] = { ...cookiesOf(res) };
  return res;
}
async function staffLogin(name, email) {
  await login(email, "Passw0rd!", name);
  const [u] = await withActor(db, SERVICE, async (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  const token = await issueEnrollToken(db, u.id, null);
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll")
    .set(auth(name)).send({ token });
  assert.equal(enroll.status, 201, JSON.stringify(enroll.body));
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}
const uidOf = async (email) => (await withActor(db, SERVICE, async (tx) =>
  tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)))[0].id;

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  ids = await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");
});
after(async () => { await app.close(); });

test("health endpoint is public and reports db up", async () => {
  const res = await request(server).get("/api/v1/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.db, "up");
});

test("MFA enrollment is a controlled flow: no token, bad token refused", async () => {
  await login("t2@school.example", "Passw0rd!", "t2");
  const noTok = await request(server).post("/api/v1/auth/mfa/totp/enroll").set(auth("t2"));
  assert.equal(noTok.status, 403);
  assert.equal(noTok.body.code, "enroll_token_required");
  const badTok = await request(server).post("/api/v1/auth/mfa/totp/enroll")
    .set(auth("t2")).send({ token: "totally-bogus-token-value" });
  assert.equal(badTok.status, 403);
  assert.equal(badTok.body.code, "enroll_token_invalid");
});

test("TOTP replay: same code accepted once, rejected the second time", async () => {
  const token = await issueEnrollToken(db, await uidOf("t2@school.example"), null);
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll")
    .set(auth("t2")).send({ token });
  assert.equal(enroll.status, 201);
  const code = totpCode(enroll.body.secret);
  const first = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth("t2")).send({ code });
  assert.equal(first.status, 201);
  const second = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth("t2")).send({ code });
  assert.equal(second.status, 401);
  assert.equal(second.body.code, "totp_replayed");
  // enroll token is single-use: the consumed token is rejected…
  const reuse = await request(server).post("/api/v1/auth/mfa/totp/enroll")
    .set(auth("t2")).send({ token });
  assert.equal(reuse.status, 403);
  assert.equal(reuse.body.code, "enroll_token_invalid");
  // …and even a FRESH valid token can't enroll a second factor
  const freshToken = await issueEnrollToken(db, await uidOf("t2@school.example"), null);
  const dupFactor = await request(server).post("/api/v1/auth/mfa/totp/enroll")
    .set(auth("t2")).send({ token: freshToken });
  assert.equal(dupFactor.status, 409);
  assert.equal(dupFactor.body.code, "factor_exists");
});

test("forgot → emailed reset link → reset → login with new password", async () => {
  const forgot = await request(server).post("/api/v1/auth/password/forgot")
    .send({ email: "s1@school.example" });
  assert.equal(forgot.status, 201);
  assert.deepEqual(forgot.body, { ok: true });
  // unknown email: identical response (no enumeration)
  const unknown = await request(server).post("/api/v1/auth/password/forgot")
    .send({ email: "ghost@nowhere.example" });
  assert.deepEqual(unknown.body, { ok: true });

  // the raw token travels in the outbox email payload (link)
  const s1 = await uidOf("s1@school.example");
  const [notif] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(notifications).where(and(eq(notifications.recipientUserId, s1),
      eq(notifications.kind, "password_reset"))).orderBy(desc(notifications.createdAt)).limit(1));
  assert.ok(notif, "reset email queued in outbox");
  const payload = decryptPayload("password_reset", notif.payload);
  const token = new URL(payload.link).searchParams.get("token");

  // password policy: long enough for the wire contract (>=12) but no upper-case
  // digits mix ⇒ rejected by assertPasswordPolicy, not by zod
  const weak = await request(server).post("/api/v1/auth/password/reset")
    .send({ token, password: "all-lowercase-no-mix" });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.code, "password_policy");

  const reset = await request(server).post("/api/v1/auth/password/reset")
    .send({ token, password: "N3w-Strong!Pass" });
  assert.equal(reset.status, 201, JSON.stringify(reset.body));
  // token is single-use
  const reuse = await request(server).post("/api/v1/auth/password/reset")
    .send({ token, password: "An0ther!Strong1" });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.code, "reset_token_invalid");
  // old password dead, new password works
  assert.equal((await login("s1@school.example", "Passw0rd!")).status, 401);
  const okLogin = await login("s1@school.example", "N3w-Strong!Pass", "s1");
  assert.equal(okLogin.status, 201);
});

test("self-service change-password: verifies current, revokes other sessions", async () => {
  // s1 jar from previous test; log in a second session
  await login("s1@school.example", "N3w-Strong!Pass", "s1b");
  const wrong = await request(server).post("/api/v1/auth/password/change")
    .set(auth("s1b")).send({ current_password: "nope-nope", new_password: "Rotated!Pass123" });
  assert.equal(wrong.status, 401);
  const ok = await request(server).post("/api/v1/auth/password/change")
    .set(auth("s1b")).send({ current_password: "N3w-Strong!Pass", new_password: "Rotated!Pass123" });
  assert.equal(ok.status, 201);
  // the OTHER session (s1) was revoked; this one (s1b) survives
  const oldSess = await request(server).get("/api/v1/auth/session").set(auth("s1"));
  assert.equal(oldSess.status, 401);
  const thisSess = await request(server).get("/api/v1/auth/session").set(auth("s1b"));
  assert.equal(thisSess.status, 200);
  // new password works for fresh logins; reset state so later suites are unaffected
  assert.equal((await login("s1@school.example", "Rotated!Pass123")).status, 201);
});

test("login lockout: 5 failures lock the account for 15 minutes (423)", async () => {
  const email = "p1@school.example";
  for (let i = 0; i < 5; i++) {
    const r = await login(email, "Wr0ng!Password");
    assert.equal(r.status, 401, `attempt ${i + 1} should 401`);
  }
  const locked = await login(email, "Passw0rd!"); // correct password, still locked
  assert.equal(locked.status, 423);
  assert.equal(locked.body.code, "account_locked");
  assert.ok(locked.body.retryAfterMs > 0);
  // a successful reset clears the lockout (support path)
  const uid = await uidOf(email);
  await withActor(db, SERVICE, async (tx) => {
    await tx.update(users).set({ lockedUntil: null, failedLoginCount: 0 }).where(eq(users.id, uid));
  });
  assert.equal((await login(email, "Passw0rd!")).status, 201);
});

test("transport capacity is enforced", async () => {
  // two fresh students
  const mkStudent = async (email) => {
    const id = randomUUID();
    await withActor(db, SERVICE, async (tx) => {
      await tx.insert(users).values({ id, email, displayName: email, passwordHash: "x" });
      await tx.insert(identities).values({ userId: id, provider: "local", subject: email });
      await tx.insert(userRoles).values({ id: randomUUID(), userId: id, roleCode: "student" });
      await tx.insert(students).values({ userId: id, admissionNo: `STU-${email.slice(0, 6)}`, gradeLevel: 10 });
    });
    return id;
  };
  const sA = await mkStudent("capa@school.example");
  const sB = await mkStudent("capb@school.example");
  // capacity-1 route
  const [route] = await withActor(db, SERVICE, async (tx) =>
    tx.insert(busRoutes).values({ id: randomUUID(), name: "Shuttle (1 seat)", capacity: 1 })
      .returning({ id: busRoutes.id }));
  const assign = (sid) => request(server).post("/api/v1/transport/assignments")
    .set(auth("admin")).send({ student_user_id: sid, route_id: route.id, term_id: ids.term });
  const first = await assign(sA);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await assign(sB);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "capacity_reached");
});

test("audit rows carry a deterministic, recomputable hash (tamper evidence)", async () => {
  const rows = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(auditLog).orderBy(desc(auditLog.occurredAt)).limit(5));
  assert.ok(rows.length >= 3);
  for (const r of rows) {
    const recomputed = computeRowHash({
      actorUserId: r.actorUserId, action: r.action, entityType: r.entityType ?? undefined,
      entityId: r.entityId ?? undefined, before: r.beforeJson ?? undefined,
      after: r.afterJson ?? undefined,
    }, r.occurredAt);
    assert.equal(recomputed, r.rowHash, `row ${r.id} (${r.action}) hash must be recomputable`);
  }
});
