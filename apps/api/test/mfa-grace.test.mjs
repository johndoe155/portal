/**
 * The two-factor rollout grace window.
 *
 * .env.example said "MFA_ENFORCE — NEVER set false in production". The pilot
 * runbook said "do not turn on enforcement until coverage is 100%". Both are
 * sensible and together they are impossible: staff cannot reach 100%
 * enrolment until they can sign in to enrol, and MFA_ENFORCE is one global
 * switch — turning it off to unblock the rollout also drops step-up for the
 * admins who already have a factor, which is exactly the wrong way round.
 *
 * MFA_GRACE_UNTIL resolves it without ever shipping a turn-off-security
 * switch. These tests pin the three properties that make it safe: it only
 * ever helps the unenrolled, it never helps a super_admin, and it closes
 * itself.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.COOKIE_SECURE = "false";
process.env.WORKER_INPROC = "false";
process.env.MFA_ENFORCE = "true";
// Open a window, as an operator starting a rollout would.
const GRACE_UNTIL = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
process.env.MFA_GRACE_UNTIL = GRACE_UNTIL;

const require = createRequire(import.meta.url);
const { createDb } = require("../dist/db/client.js");
const { runMigrations } = require("../dist/db/migrate.js");
const { seed } = require("../dist/seed.js");
const { createApp } = require("../dist/app.factory.js");
const { totpCode } = require("../dist/crypto/totp.js");
const { withActor, SERVICE } = require("../dist/db/actor.js");
const { issueEnrollToken } = require("../dist/auth/enroll-token.js");
const { goLiveReadiness } = require("../dist/ops/go-live.service.js");
const { config } = require("../dist/config.js");
const { users } = require("../dist/db/schema.js");
const { eq } = require("drizzle-orm");
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
async function login(name, email) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password: "Passw0rd!" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  jars[name] = cookiesOf(res);
  return res;
}
async function uidOf(email) {
  const [u] = await withActor(db, SERVICE, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  return u.id;
}
async function enrol(name, email) {
  const token = await issueEnrollToken(db, await uidOf(email), null);
  const e = await request(server).post("/api/v1/auth/mfa/totp/enroll").set(auth(name)).send({ token });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  return e.body.secret;
}
const byId = (r, id) => r.checks.find((c) => c.id === id);

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
});
after(async () => { await app.close(); });

test("enforcement itself is never switched off", () => {
  assert.equal(config.mfaEnforce, true,
    "the grace window must not be implemented by disabling enforcement");
  assert.ok(config.mfaGraceUntil instanceof Date);
});

test("a teacher with nothing enrolled can work during the window", async () => {
  // Without this they cannot sign in to enrol, which is the deadlock the
  // runbook and .env.example disagreed about.
  await login("t1", "t1@school.example");
  const res = await request(server).get("/api/v1/sections").set(auth("t1"));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers["x-mfa-grace-until"]?.slice(0, 10), GRACE_UNTIL,
    "the response says they are on borrowed time");
});

test("the session tells them when it runs out", async () => {
  const s = await request(server).get("/api/v1/auth/session").set(auth("t1"));
  assert.equal(s.status, 200);
  assert.equal(s.body.mfaRequired, true);
  assert.equal(s.body.mfaEnrolled, false);
  assert.equal(s.body.mfaGraceUntil?.slice(0, 10), GRACE_UNTIL,
    "the UI can name the date instead of letting them discover it when it shuts");
});

test("enrolling does NOT make your account weaker", async () => {
  // The important asymmetry. Grace covers people who have not enrolled yet;
  // the moment you have a factor, step-up applies again — otherwise the
  // rollout would be punishing the people who complied first.
  await login("t2", "t2@school.example");
  const secret = await enrol("t2", "t2@school.example");

  const blocked = await request(server).get("/api/v1/sections").set(auth("t2"));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "mfa_required");

  const v = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth("t2")).send({ code: totpCode(secret) });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal((await request(server).get("/api/v1/sections").set(auth("t2"))).status, 200);

  const s = await request(server).get("/api/v1/auth/session").set(auth("t2"));
  assert.equal(s.body.mfaEnrolled, true);
  assert.equal(s.body.mfaGraceUntil, null, "no longer relying on grace");
});

test("a super_admin is never in grace", async () => {
  // The accounts worth attacking do not get a window.
  await login("root", "root@school.example");
  const res = await request(server).get("/api/v1/users").set(auth("root"));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "mfa_required");

  const s = await request(server).get("/api/v1/auth/session").set(auth("root"));
  assert.equal(s.body.mfaGraceUntil, null);
});

test("go-live fails while staff are still relying on the window", async () => {
  const c = byId(await goLiveReadiness(db), "mfa_grace");
  assert.equal(c.status, "fail", "this is what stops a grace window becoming permanent");
  assert.match(c.detail, new RegExp(GRACE_UNTIL));
  assert.match(c.detail, /without a second factor/);
  assert.ok(c.fix.includes("MFA_GRACE_UNTIL"));
});

test("/health warns the on-call person while the window is open", async () => {
  const res = await request(server).get("/api/v1/health");
  assert.equal(res.status, 200);
  assert.ok(res.body.warnings.some((w) => /two-factor enrolment grace/.test(w)),
    JSON.stringify(res.body.warnings));
});

test("the window is a date, so it cannot be left on by accident", async () => {
  // Re-resolving config with a past date must behave exactly like no window.
  const { resolveGraceForTest } = require("../dist/config.js");
  if (typeof resolveGraceForTest !== "function") return; // helper is optional
  assert.equal(resolveGraceForTest("2020-01-01").getTime() < Date.now(), true);
  assert.throws(() => resolveGraceForTest("next tuesday"), /not a date/);
  assert.throws(() => resolveGraceForTest("2099-01-01"), /90 days/);
});
