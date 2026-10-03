/**
 * Go-live readiness.
 *
 * The pilot runbook ended with a prose checklist — "confirm SMTP works",
 * "confirm backups are fresh", "confirm the DPO email is set". A checklist in
 * a markdown file is one nobody runs, and every item on it is something that
 * looks fine right up until the morning it matters.
 *
 * These tests pin the part that matters: the checks have to be honest. A
 * readiness screen that says "ready" while email goes nowhere is worse than
 * no screen at all, because somebody will believe it.
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
const { goLiveReadiness } = require("../dist/ops/go-live.service.js");
const { users, schoolSettings, retentionRuns } = require("../dist/db/schema.js");
const { eq } = require("drizzle-orm");
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
const byId = (r, id) => r.checks.find((c) => c.id === id);

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

test("a freshly provisioned portal is NOT ready, and says why", async () => {
  // The default answer has to be "no". A readiness check that passes out of
  // the box is a rubber stamp.
  const r = await goLiveReadiness(db);
  assert.equal(r.ready, false);
  assert.ok(r.summary.fail > 0);
  assert.ok(r.checks.length >= 15, "the whole runbook checklist is covered");
  for (const c of r.checks) {
    assert.ok(c.id && c.group && c.label, "every check is identifiable");
    assert.ok(["pass", "warn", "fail"].includes(c.status));
    assert.ok(c.detail.length > 10, `${c.id} explains itself`);
  }
});

test("a missing DPO address blocks go-live", async () => {
  // The privacy and retention pages tell people to write to the DPO. With no
  // address those pages describe rights nobody can exercise.
  const before = byId(await goLiveReadiness(db), "dpo_email");
  assert.equal(before.status, "fail");
  assert.match(before.detail, /cannot be exercised/);

  await withActor(db, SERVICE, (tx) => tx.update(schoolSettings)
    .set({ dpoEmail: "dpo@greenfield.ng" }).where(eq(schoolSettings.id, 1)));

  const after = byId(await goLiveReadiness(db), "dpo_email");
  assert.equal(after.status, "pass");
  assert.match(after.detail, /dpo@greenfield\.ng/);
});

test("the default school name blocks go-live", async () => {
  const before = byId(await goLiveReadiness(db), "school_name");
  assert.equal(before.status, "fail");

  await withActor(db, SERVICE, (tx) => tx.update(schoolSettings)
    .set({ name: "Greenfield Academy" }).where(eq(schoolSettings.id, 1)));

  assert.equal(byId(await goLiveReadiness(db), "school_name").status, "pass");
});

test("unconfigured email is a blocker, not a warning", async () => {
  // Without SMTP nobody can be invited and nobody can reset a password. The
  // portal is unusable, so this cannot be something you scroll past.
  const c = byId(await goLiveReadiness(db), "smtp");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /never delivered/);
});

test("backups that have never run block go-live", async () => {
  const fresh = byId(await goLiveReadiness(db), "backup_fresh");
  assert.equal(fresh.status, "fail");
  assert.match(fresh.detail, /irreplaceable/);

  const offsite = byId(await goLiveReadiness(db), "backup_offsite");
  assert.equal(offsite.status, "fail");

  const drill = byId(await goLiveReadiness(db), "restore_drill");
  assert.match(drill.detail, /untested backup is an assumption/);
});

test("the demo seed is a blocker", async () => {
  // Demo accounts share a password that is printed in the README.
  const off = byId(await goLiveReadiness(db), "demo_seed");
  assert.equal(off.status, "pass");

  process.env.SEED_DEMO = "true";
  try {
    const on = byId(await goLiveReadiness(db), "demo_seed");
    assert.equal(on.status, "fail");
    assert.match(on.detail, /Passw0rd!/);
  } finally { delete process.env.SEED_DEMO; }
});

test("staff two-factor coverage is measured, not assumed", async () => {
  const c = byId(await goLiveReadiness(db), "mfa_coverage");
  // Exactly one staff member (the test admin) has enrolled so far.
  assert.match(c.detail, /of \d+ staff enrolled/);
  assert.ok(["fail", "warn"].includes(c.status), "partial coverage is not a pass");
});

test("a stalled retention purge is reported", async () => {
  const before = byId(await goLiveReadiness(db), "retention");
  assert.equal(before.status, "warn");
  assert.match(before.detail, /not being enforced/);

  await withActor(db, SERVICE, (tx) => tx.insert(retentionRuns).values({
    id: randomUUID(), startedAt: new Date(), finishedAt: new Date(),
    dryRun: false, trigger: "test", ok: true, counts: {},
  }));

  assert.equal(byId(await goLiveReadiness(db), "retention").status, "pass");
});

test("calendar and roster gaps are reported at the right severity", async () => {
  const r = await goLiveReadiness(db);
  // The seed sets up a usable calendar, so these pass.
  assert.equal(byId(r, "current_year").status, "pass");
  assert.equal(byId(r, "terms").status, "pass");
  assert.equal(byId(r, "roster").status, "pass");
  // A pupil with no guardian is a real problem but not a reason to stop.
  assert.notEqual(byId(r, "guardians").status, "fail");
  assert.notEqual(byId(r, "empty_sections").status, "fail");
});

test("readiness is served to administrators over the API", async () => {
  const res = await request(server).get("/api/v1/reports/go-live").set(auth("admin"));
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.ready, "boolean");
  assert.ok(res.body.summary.fail >= 0);
  assert.ok(Array.isArray(res.body.checks));
  assert.ok(res.body.checkedAt);
});

test("readiness is admin-only", async () => {
  await staffLogin("t1", "t1@school.example");
  const res = await request(server).get("/api/v1/reports/go-live").set(auth("t1"));
  assert.equal(res.status, 403);
});

test("every failing check tells you where to fix it", async () => {
  const r = await goLiveReadiness(db);
  for (const c of r.checks.filter((x) => x.status !== "pass")) {
    assert.ok(c.fix, `${c.id} should say where to go`);
  }
});
