import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { createDb } = require("../dist/db/client.js");
const { runMigrations } = require("../dist/db/migrate.js");
const { seed } = require("../dist/seed.js");
const { createApp } = require("../dist/app.factory.js");
const { totpCode } = require("../dist/crypto/totp.js");
const { withActor, SERVICE } = require("../dist/db/actor.js");
const { issueEnrollToken } = require("../dist/auth/enroll-token.js");
const { auditLog, users } = require("../dist/db/schema.js");
const { eq } = require("drizzle-orm");
const request = require("supertest");

process.env.COOKIE_SECURE = "false";

let app, server, db, ids;
const jars = {};

function cookiesOf(res) {
  const set = res.headers["set-cookie"] ?? [];
  const out = {};
  for (const c of set) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}
function jar(name) {
  const j = jars[name];
  return `sid=${j.sid}; csrf=${j.csrf}`;
}
function auth(name) { return { Cookie: jar(name), "x-csrf": jars[name].csrf }; }

async function loginAs(name, email) {
  const res = await request(server).post("/api/v1/auth/login")
    .send({ email, password: "Passw0rd!" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  jars[name] = { ...cookiesOf(res) };
  return res;
}
async function completeMfa(name, email) {
  // controlled enrollment: token issued out-of-band by an admin — tests use the
  // same direct primitive as scripts/mfa-token.mjs (SERVICE insert)
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
async function staffLogin(name, email) { await loginAs(name, email); await completeMfa(name, email); }

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  ids = await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
});
after(async () => { await app?.close(); });

test("staff login requires MFA step-up before scoped reads", async () => {
  const res = await loginAs("t1", "t1@school.example");
  assert.equal(res.body.mfaRequired, true);
  const blocked = await request(server).get("/api/v1/sections").set(auth("t1"));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "mfa_required");
  await completeMfa("t1", "t1@school.example");
  const ok = await request(server).get("/api/v1/sections").set(auth("t1"));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.length, 1, "teacher sees only own section");
  assert.equal(ok.body.data[0].name, "MTH-101 A");
});

test("mutations without CSRF token are rejected", async () => {
  const res = await request(server)
    .post(`/api/v1/sections/${ids.sec1}/attendance`)
    .set("Cookie", jar("t1"))
    .send({ date: "2026-10-01", records: [] });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "csrf_missing");
});

test("teacher can write own register; other teacher is denied (gate 1 + gate 2)", async () => {
  await staffLogin("t2", "t2@school.example");
  const body = { date: "2026-10-01", records: [{ student_user_id: ids.s1, status: "absent", note: "no call" }] };
  const ok = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`)
    .set(auth("t1")).set("Idempotency-Key", "key-attendance-0001").send(body);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.written, 1);

  // idempotent replay
  const replay = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`)
    .set(auth("t1")).set("Idempotency-Key", "key-attendance-0001").send(body);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, ok.body);

  const denied = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`)
    .set(auth("t2")).set("Idempotency-Key", "key-attendance-0002").send(body);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "outside_section_scope");
});

test("finalized register is locked; student sees own attendance", async () => {
  const fin = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance/finalize`)
    .set(auth("t1")).send({ date: "2026-10-01" });
  assert.equal(fin.status, 201);
  const locked = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`)
    .set(auth("t1")).set("Idempotency-Key", "key-attendance-0003")
    .send({ date: "2026-10-01", records: [{ student_user_id: ids.s1, status: "present" }] });
  assert.equal(locked.status, 409);

  await loginAs("stu", "s1@school.example");
  const mine = await request(server).get("/api/v1/student/attendance").set(auth("stu"));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.length, 1);
  assert.equal(mine.body.data[0].status, "absent");
});

test("grades are invisible until released; then visible to student and parent", async () => {
  const g = { items: [{ student_user_id: ids.s1, label: "CA Test 1", points: "18.00", max_points: "20.00", weight_pct: "15.00" }] };
  const w = await request(server).post(`/api/v1/sections/${ids.sec1}/grades/bulk`)
    .set(auth("t1")).set("Idempotency-Key", "key-grades-0001").send(g);
  assert.equal(w.status, 201, JSON.stringify(w.body));

  const before = await request(server).get("/api/v1/student/grades").set(auth("stu"));
  assert.equal(before.body.data.length, 0, "unreleased grades hidden");

  const rel = await request(server).post(`/api/v1/sections/${ids.sec1}/grades/release`).set(auth("t1"));
  assert.equal(rel.status, 201);
  assert.equal(rel.body.released, 1);

  const after = await request(server).get("/api/v1/student/grades").set(auth("stu"));
  assert.equal(after.body.data.length, 1);
  assert.equal(after.body.data[0].points, "18.00");

  await loginAs("par", "p1@school.example");
  const kids = await request(server).get("/api/v1/parent/children").set(auth("par"));
  assert.equal(kids.body.data.length, 1);
  const pg = await request(server).get(`/api/v1/parent/children/${ids.s1}/grades`).set(auth("par"));
  assert.equal(pg.body.data.length, 1);

  // revision trail exists
  const w2 = await request(server).post(`/api/v1/sections/${ids.sec1}/grades/bulk`)
    .set(auth("t1")).set("Idempotency-Key", "key-grades-0002")
    .send({ items: [{ student_user_id: ids.s1, label: "CA Test 1", points: "17.00", max_points: "20.00" }] });
  assert.equal(w2.status, 201);
  assert.equal(w2.body.revisions, 1);
});

test("parent is read-only: every mutating verb 403s before policy evaluation", async () => {
  const res = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`)
    .set(auth("par")).set("Idempotency-Key", "key-parent-0001")
    .send({ date: "2026-10-02", records: [{ student_user_id: ids.s1, status: "present" }] });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "parent_read_only");
});

test("directory: admin reads users after MFA; teacher lacks capability", async () => {
  await staffLogin("adm", "admin@school.example");
  const ok = await request(server).get("/api/v1/users").set(auth("adm"));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.meta.total, 6); // 5 base seeds + root super_admin (5.3)
  const denied = await request(server).get("/api/v1/users").set(auth("t1"));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "missing_capability");
});

test("RLS backstop: teacher2 gradebook read of section1 yields nothing", async () => {
  const res = await request(server).get(`/api/v1/sections/${ids.sec1}/gradebook`).set(auth("t2"));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 0);
});

test("audit log captured grade writes with actor", async () => {
  const rows = await withActor(db, SERVICE, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, "gradebook.bulk_upsert")));
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].actorUserId, ids.t1);
});
