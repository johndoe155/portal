/**
 * Bulk MFA onboarding.
 *
 * Tokens could only be issued one user at a time, so rolling MFA out to sixty
 * teachers meant sixty trips through the UI — which in practice means it does
 * not happen, or enforcement gets switched off. These tests cover the coverage
 * view, bulk issue, the tier check holding under bulk, and the one-time
 * printable sheet.
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
const { users, userRoles, mfaEnrollTokens, auditLog, notifications } = require("../dist/db/schema.js");
const { eq, and, isNull, desc, sql } = require("drizzle-orm");
const { randomUUID } = require("node:crypto");
const request = require("supertest");

let app, server, db;
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
const auth = (n) => ({ Cookie: `sid=${jars[n].sid}; csrf=${jars[n].csrf}`, "x-csrf": jars[n].csrf });
async function login(email, password = "Passw0rd!", name) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password });
  if (name) jars[name] = { ...cookiesOf(res) };
  return res;
}
async function uidOf(email) {
  const [u] = await withActor(db, SERVICE, async (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  return u.id;
}
async function staffLogin(name, email) {
  await login(email, "Passw0rd!", name);
  const token = await issueEnrollToken(db, await uidOf(email), null);
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll").set(auth(name)).send({ token });
  assert.equal(enroll.status, 201, JSON.stringify(enroll.body));
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}

/** A cohort of teachers, as a school would have. */
async function makeTeachers(n) {
  const made = [];
  await withActor(db, SERVICE, async (tx) => {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      const email = `bulk-teacher-${i}-${id.slice(0, 6)}@school.example`;
      await tx.insert(users).values({ id, email, displayName: `Bulk Teacher ${i}`, status: "active" });
      await tx.insert(userRoles).values({ id: randomUUID(), userId: id, roleCode: "teacher" });
      made.push({ id, email });
    }
  });
  return made;
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

test("coverage answers 'who still has not set up two-factor'", async () => {
  const res = await request(server).get("/api/v1/mfa/coverage").set(auth("admin"));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.total > 0, "the school has staff");
  assert.equal(res.body.enrolled + res.body.outstanding, res.body.total);
  assert.equal(typeof res.body.percent, "number");

  // The admin enrolled in before(), so they must show as covered.
  const me = res.body.data.find((r) => r.email === "admin@school.example");
  assert.ok(me, "the admin appears in the staff list");
  assert.equal(me.enrolled, true);

  // Outstanding staff sort first — that is the actionable list.
  if (res.body.outstanding > 0) {
    assert.equal(res.body.data[0].enrolled, false, "people still to do it come first");
  }
});

test("coverage counts only staff, not pupils and parents", async () => {
  const res = await request(server).get("/api/v1/mfa/coverage").set(auth("admin"));
  const roles = new Set(res.body.data.flatMap((r) => r.roles));
  assert.ok(!roles.has("student"), "pupils are not required to use MFA");
  assert.ok(!roles.has("parent"), "parents are not required to use MFA");
});

test("one request covers a whole cohort of teachers", async () => {
  const cohort = await makeTeachers(60);
  const before = await request(server).get("/api/v1/mfa/coverage").set(auth("admin"));
  assert.ok(before.body.outstanding >= 60, "the new teachers are outstanding");

  const res = await request(server).post("/api/v1/mfa/enroll-tokens/bulk")
    .set(auth("admin")).send({ scope: "outstanding" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.issued >= 60, `expected >= 60 issued, got ${res.body.issued}`);

  // Every one of them now holds a live, unused token.
  const live = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(mfaEnrollTokens)
      .where(and(isNull(mfaEnrollTokens.usedAt), sql`${mfaEnrollTokens.expiresAt} > now()`)));
  assert.ok(Number(live[0].n) >= 60);

  const after = await request(server).get("/api/v1/mfa/coverage").set(auth("admin"));
  assert.ok(after.body.pendingTokens >= 60, "coverage shows tokens are out with people");
  assert.equal(after.body.enrolled, before.body.enrolled,
    "issuing a token is not the same as being enrolled — coverage must not lie");
});

test("a token issued in bulk actually works end to end", async () => {
  // The whole feature is worthless if the bulk-issued tokens do not enrol.
  const [t] = await makeTeachers(1);
  const res = await request(server).post("/api/v1/mfa/enroll-tokens/bulk")
    .set(auth("admin")).send({ user_ids: [t.id], deliver: "print" });
  assert.equal(res.status, 201);
  const row = res.body.data.find((r) => r.userId === t.id);
  assert.ok(row?.token, "the print workflow returns the token once");

  await withActor(db, SERVICE, async (tx) => {
    const { hashPassword } = require("../dist/crypto/password.js");
    await tx.update(users).set({ passwordHash: await hashPassword("Passw0rd!") })
      .where(eq(users.id, t.id));
  });
  await login(t.email, "Passw0rd!", "newbie");
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll")
    .set(auth("newbie")).send({ token: row.token });
  assert.equal(enroll.status, 201, JSON.stringify(enroll.body));
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth("newbie")).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201);

  const cov = await request(server).get("/api/v1/mfa/coverage").set(auth("admin"));
  assert.equal(cov.body.data.find((r) => r.id === t.id).enrolled, true,
    "and coverage now shows them as done");
});

test("tokens are shown once, with a warning saying so", async () => {
  const [t] = await makeTeachers(1);
  const res = await request(server).post("/api/v1/mfa/enroll-tokens/bulk")
    .set(auth("admin")).send({ user_ids: [t.id], deliver: "print" });
  assert.match(res.body.note, /shown once|cannot be shown again/);

  // Stored hashed: the raw token is nowhere in the database.
  const raw = res.body.data[0].token;
  const rows = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(mfaEnrollTokens).where(eq(mfaEnrollTokens.userId, t.id)));
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.tokenHash !== raw), "tokens must be stored hashed, never in clear");
});

test("the printable sheet is a CSV with one row per person", async () => {
  const cohort = await makeTeachers(5);
  const res = await request(server).post("/api/v1/mfa/enroll-tokens/bulk.csv")
    .set(auth("admin")).send({ user_ids: cohort.map((c) => c.id) });
  assert.equal(res.status, 201, res.text?.slice(0, 200));
  assert.match(res.headers["content-type"], /text\/csv/);
  assert.match(res.headers["content-disposition"], /attachment; filename="mfa-enrolment-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = res.text.trim().split("\r\n");
  assert.equal(lines[0], "name,email,enrolment_token,expires_at");
  assert.equal(lines.length, 6, "header plus five teachers");
  for (const l of lines.slice(1)) {
    const [, email, token] = l.split(",");
    assert.ok(email.includes("@"));
    assert.ok(token && token.length > 20, "each row carries a usable token");
  }
});

test("bulk issue cannot be used to mint a token for someone above your tier", async () => {
  // Otherwise a registrar could widen the scope and quietly obtain an
  // enrolment token for a super admin.
  const root = await uidOf("root@school.example");
  const registrarId = randomUUID();
  await withActor(db, SERVICE, async (tx) => {
    const { hashPassword } = require("../dist/crypto/password.js");
    await tx.insert(users).values({
      id: registrarId, email: "reg-bulk@school.example", displayName: "Rita Registrar",
      passwordHash: await hashPassword("Passw0rd!"), status: "active",
    });
    await tx.insert(userRoles).values({ id: randomUUID(), userId: registrarId, roleCode: "registrar" });
  });
  await staffLogin("reg", "reg-bulk@school.example");

  const res = await request(server).post("/api/v1/mfa/enroll-tokens/bulk")
    .set(auth("reg")).send({ user_ids: [root] });
  assert.equal(res.status, 201);
  assert.equal(res.body.issued, 0, "no token issued for the super admin");
  assert.match(res.body.skipped[0].reason, /above your role tier/);
});

test("offboarded staff get no token and vanish from coverage", async () => {
  // Offboarding revokes their roles, so a leaver is no longer staff: they
  // drop out of the coverage denominator entirely rather than sitting there
  // forever as someone who "still needs to enrol".
  const [t] = await makeTeachers(1);
  const before = await request(server).get("/api/v1/mfa/coverage").set(auth("admin"));
  assert.ok(before.body.data.some((r) => r.id === t.id));

  await request(server).post(`/api/v1/users/${t.id}/deactivate`).set(auth("admin")).send({});

  const after = await request(server).get("/api/v1/mfa/coverage").set(auth("admin"));
  assert.ok(!after.body.data.some((r) => r.id === t.id), "a leaver is not outstanding staff");
  assert.equal(after.body.total, before.body.total - 1);

  const res = await request(server).post("/api/v1/mfa/enroll-tokens/bulk")
    .set(auth("admin")).send({ user_ids: [t.id] });
  assert.equal(res.body.issued, 0, "and no enrolment token is minted for them");
});

test("a not-yet-activated staff account is skipped with the reason given", async () => {
  // Invited-but-not-accepted staff keep their roles, so they do reach the
  // issue loop — and must be reported rather than silently handed a token.
  const id = randomUUID();
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(users).values({
      id, email: `invited-${id.slice(0, 6)}@school.example`,
      displayName: "Invited Teacher", status: "invited",
    });
    await tx.insert(userRoles).values({ id: randomUUID(), userId: id, roleCode: "teacher" });
  });
  const res = await request(server).post("/api/v1/mfa/enroll-tokens/bulk")
    .set(auth("admin")).send({ user_ids: [id] });
  assert.equal(res.body.issued, 0);
  assert.match(res.body.skipped[0].reason, /account is invited/);
});

test("an empty request is refused with instructions rather than doing nothing", async () => {
  const res = await request(server).post("/api/v1/mfa/enroll-tokens/bulk").set(auth("admin")).send({});
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "nothing_selected");
  assert.match(res.body.detail, /user_ids|outstanding/);
});

test("an absurdly large batch is refused", async () => {
  const res = await request(server).post("/api/v1/mfa/enroll-tokens/bulk")
    .set(auth("admin")).send({ user_ids: Array.from({ length: 501 }, () => randomUUID()) });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "too_many");
});

test("bulk issue is audited with counts and delivery method", async () => {
  const [t] = await makeTeachers(1);
  await request(server).post("/api/v1/mfa/enroll-tokens/bulk")
    .set(auth("admin")).send({ user_ids: [t.id], deliver: "print" });
  const [entry] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, "mfa.enroll_tokens_bulk_issued"))
      .orderBy(desc(auditLog.occurredAt)).limit(1));
  assert.ok(entry);
  assert.equal(entry.afterJson.issued, 1);
  assert.equal(entry.afterJson.delivery, "print");
});

test("a teacher cannot issue MFA tokens to anyone", async () => {
  await staffLogin("t1", "t1@school.example");
  assert.equal((await request(server).get("/api/v1/mfa/coverage").set(auth("t1"))).status, 403);
  assert.equal((await request(server).post("/api/v1/mfa/enroll-tokens/bulk")
    .set(auth("t1")).send({ scope: "outstanding" })).status, 403);
});
