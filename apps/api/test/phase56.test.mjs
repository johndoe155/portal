/**
 * Phase 6 — review-6 regression suite (2026-10-02).
 * Covers the sponsor's five findings:
 *  1. grading scale/weights actually drive report cards; term_id required
 *  2. parents can be bulk-imported (accounts auto-created)
 *  3. CSV needs no plaintext passwords (set-password links); supplied
 *     passwords are temporary (password_change_required until changed);
 *     hashing happens outside the transaction (structural — see import.controller)
 *  4. invitee-supplied grade/admission numbers are ignored
 *  5. import results list EVERY problem row (no 500 cap)
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";

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
const { users } = require("../dist/db/schema.js");
const { eq, sql } = require("drizzle-orm");
const request = require("supertest");

let app, server, db, ids;
const jars = {};
const PW = "Passw0rd!Policy1";

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
async function loginAs(name, email, password) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  jars[name] = { ...cookiesOf(res) };
  return res;
}
async function staffLogin(name, email, password = "Passw0rd!") {
  await loginAs(name, email, password);
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

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  ids = await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");
  await staffLogin("root", "root@school.example");
  await staffLogin("t1", "t1@school.example");
  await loginAs("s1", "s1@school.example", "Passw0rd!");
});
after(async () => { await app?.close(); });

/* ══ review-6 #3: CSV without plaintext passwords ════════════════════════ */
let setPasswordUrl;
test("students CSV: password column optional — set-password link issued, no plaintext", async () => {
  const csv = [
    "email,display_name,password,admission_no,grade_level",
    `nopw.${Date.now()}@school.example,No Password Kid,,NPW-001,10`,
  ].join("\n");
  const dry = await request(server).post("/api/v1/import/students").set(auth("admin"))
    .send({ csv, dry_run: true });
  assert.equal(dry.status, 201, JSON.stringify(dry.body));
  assert.equal(dry.body.would_create, 1, "row without password is valid");

  const commit = await request(server).post("/api/v1/import/students").set(auth("admin"))
    .send({ csv });
  assert.equal(commit.status, 201, JSON.stringify(commit.body));
  assert.equal(commit.body.created, 1);
  const row = commit.body.rows.find((r) => r.set_password_url);
  assert.ok(row, "set-password link returned to the admin (dev sink)");
  setPasswordUrl = row.set_password_url;

  // the person chooses their OWN password through the emailed link
  const token = setPasswordUrl.split("token=").pop();
  const reset = await request(server).post("/api/v1/auth/password/reset")
    .send({ token, password: "MyOwn!Passw0rd9" });
  assert.ok([200, 201].includes(reset.status), JSON.stringify(reset.body));
  const email = csv.split("\n")[1].split(",")[0];
  const login = await loginAs("nopw", email, "MyOwn!Passw0rd9");
  assert.equal(login.body.mustChangePassword !== true, true, "self-chosen password needs no forced change");
  const me = await request(server).get("/api/v1/auth/session").set(auth("nopw"));
  assert.equal(me.status, 200, "full API access immediately");
});

test("students CSV: supplied password is TEMPORARY — locked to /auth until changed", async () => {
  const email = `temppw.${Date.now()}@school.example`;
  const csv = [
    "email,display_name,password,admission_no,grade_level",
    `${email},Temp Password Kid,${PW},TPW-001,10`,
  ].join("\n");
  const commit = await request(server).post("/api/v1/import/students").set(auth("admin")).send({ csv });
  assert.equal(commit.status, 201, JSON.stringify(commit.body));

  const login = await loginAs("temppw", email, PW);
  assert.equal(login.body.mustChangePassword, true, "login flags the temporary password");
  const blocked = await request(server).get("/api/v1/auth/session").set(auth("temppw"));
  assert.equal(blocked.status, 200, "auth surface stays open");
  const denied = await request(server).get("/api/v1/student/grades").set(auth("temppw"));
  assert.equal(denied.status, 403, "everything else is gated");
  assert.equal(denied.body.code, "password_change_required");

  const change = await request(server).post("/api/v1/auth/password/change").set(auth("temppw"))
    .send({ current_password: PW, new_password: "Changed!Passw0rd9" });
  assert.ok([200, 201].includes(change.status), JSON.stringify(change.body));
  const okNow = await request(server).get("/api/v1/student/grades").set(auth("temppw"));
  assert.equal(okNow.status, 200, "unlocked after the change");
  await loginAs("temppw2", email, "Changed!Passw0rd9");
  assert.equal(jars["temppw2"].sid !== undefined, true);
});

/* ══ review-6 #2: bulk parent import ═════════════════════════════════════ */
test("guardians CSV auto-creates parent accounts (bulk onboarding) and links", async () => {
  // a student to link to
  const stuEmail = `bulkstu.${Date.now()}@school.example`;
  await request(server).post("/api/v1/import/students").set(auth("admin")).send({
    csv: `email,display_name,password,admission_no,grade_level\n${stuEmail},Bulk Student,,BULK-001,10`,
  });
  const guardianEmail = `bulkmum.${Date.now()}@school.example`;
  const csv = [
    "student_admission_no,guardian_email,relationship,guardian_name",
    `BULK-001,${guardianEmail},mother,Bulk Mum`,
  ].join("\n");
  const dry = await request(server).post("/api/v1/import/guardians").set(auth("admin"))
    .send({ csv, dry_run: true });
  assert.equal(dry.status, 201, JSON.stringify(dry.body));
  assert.equal(dry.body.would_create, 1, "row is valid even though the account does not exist yet");

  const commit = await request(server).post("/api/v1/import/guardians").set(auth("admin")).send({ csv });
  assert.equal(commit.status, 201, JSON.stringify(commit.body));
  assert.equal(commit.body.created, 1);
  const link = commit.body.rows.find((r) => r.set_password_url);
  assert.ok(link, "new parent got a set-password link");

  // account exists with the parent role and a pending link
  const stu = (await request(server).get("/api/v1/students?q=BULK-001").set(auth("admin"))).body.data[0];
  const links = await request(server).get(`/api/v1/students/${stu.userId}/guardians`).set(auth("admin"));
  assert.equal(links.body.data.length, 1);
  assert.equal(links.body.data[0].relationship, "mother");
  assert.equal(links.body.data[0].verifiedAt, null, "pending until verified");
  assert.equal(links.body.data[0].displayName, "Bulk Mum", "guardian_name used");

  // she sets her password, logs in, and office-confirm makes the child visible
  const token = link.set_password_url.split("token=").pop();
  await request(server).post("/api/v1/auth/password/reset").send({ token, password: "Mum!Passw0rd99" });
  await loginAs("bulkmum", guardianEmail, "Mum!Passw0rd99");
  const kids0 = await request(server).get("/api/v1/parent/children").set(auth("bulkmum"));
  assert.equal(kids0.body.data.length, 1);
  assert.equal(kids0.body.data[0].verified, null, "child listed as pending");
  await request(server).post(`/api/v1/guardian-links/${links.body.data[0].id}/confirm`).set(auth("admin"));
  const kids1 = await request(server).get("/api/v1/parent/children").set(auth("bulkmum"));
  assert.ok(kids1.body.data[0].verified, "verified after office confirm");
});

/* ══ review-6 #4: invitee never picks grade/admission ════════════════════ */
test("invited student cannot supply grade or admission number", async () => {
  const email = `nosetup.${Date.now()}@school.example`;
  const inv = await request(server).post("/api/v1/invites").set(auth("admin"))
    .send({ email, display_name: "No Setup Grade", roles: ["student"] }); // admin forgot the grade
  assert.equal(inv.status, 201);
  const accept = await request(server).post("/api/v1/auth/invite/accept")
    .send({ token: inv.body.inviteToken, password: PW, grade_level: 12, admission_no: "FAKE-999" });
  assert.equal(accept.status, 422, "invitee-supplied grade is ignored, not accepted");
  assert.equal(accept.body.code, "grade_level_required");
});

test("invited student with invite-grade gets AUTO admission even if body supplies one", async () => {
  const email = `autonum.${Date.now()}@school.example`;
  const inv = await request(server).post("/api/v1/invites").set(auth("admin"))
    .send({ email, display_name: "Auto Num", roles: ["student"], grade_level: 11 });
  assert.equal(inv.status, 201);
  const accept = await request(server).post("/api/v1/auth/invite/accept")
    .send({ token: inv.body.inviteToken, password: PW, admission_no: "FAKE-1234" });
  assert.equal(accept.status, 201, JSON.stringify(accept.body));
  const rows = (await request(server).get("/api/v1/students?q=Auto%20Num").set(auth("admin"))).body.data;
  assert.equal(rows.length, 1);
  assert.match(rows[0].admissionNo, /^STU-\d+$/, "auto-numbered — the made-up number was ignored");
  assert.equal(rows[0].gradeLevel, 11);
});

/* ══ review-6 #1: report cards use the grading scale + weights ═══════════ */
let term56, section56;
test("report card: weighted percentages, letters and overall from grading config", async () => {
  const stamp = Date.now();
  const year = await request(server).post("/api/v1/academic-years").set(auth("admin"))
    .send({ name: `RC Year ${stamp}`, start_date: "2026-09-01", end_date: "2027-07-31", make_current: false });
  assert.equal(year.status, 201);
  const term = await request(server).post("/api/v1/terms").set(auth("admin"))
    .send({ academic_year_id: year.body.id, term_no: 1, name: `RC Term ${stamp}` });
  assert.equal(term.status, 201);
  term56 = term.body.id;

  // grading scale + weights
  const gc = await request(server).put("/api/v1/grading-config").set(auth("admin")).send({
    scale: [
      { letter: "A", min_pct: 75, point: 5 },
      { letter: "B", min_pct: 60, point: 4 },
      { letter: "F", min_pct: 0, point: 0 },
    ],
    weights: { exam: 70, coursework: 30 },
  });
  assert.equal(gc.status, 200);

  // section + teacher + enrolment for s1
  const course = await request(server).post("/api/v1/import/sections").set(auth("admin")).send({
    csv: `course_code,course_title,name,term_name\nRC-${stamp},Report Card Course,RC Section A,RC Term ${stamp}`,
  });
  assert.equal(course.status, 201, JSON.stringify(course.body));
  const sections = (await request(server).get("/api/v1/sections").set(auth("admin"))).body.data;
  section56 = sections.find((s) => s.name === "RC Section A").id;
  await request(server).post(`/api/v1/sections/${section56}/staff`).set(auth("admin"))
    .send({ user_id: ids.t1, role: "teacher" });
  const enr = await request(server).post("/api/v1/import/enrollments").set(auth("admin")).send({
    csv: `student_admission_no,course_code,section_name,term_name\nS1-0001,RC-${stamp},RC Section A,RC Term ${stamp}`,
  });
  // seed student's admission no may differ — fall back to direct enrolment check
  if (enr.body.errors > 0) {
    const s1row = (await request(server).get("/api/v1/students?q=Sola").set(auth("admin"))).body.data[0];
    await request(server).post("/api/v1/import/enrollments").set(auth("admin")).send({
      csv: `student_admission_no,course_code,section_name,term_name\n${s1row.admissionNo},RC-${stamp},RC Section A,RC Term ${stamp}`,
    });
  }

  // grades: exam 80% + coursework (assignment) 60% → 0.7·80 + 0.3·60 = 74 → B
  const bulk = await request(server).post(`/api/v1/sections/${section56}/grades/bulk`).set(auth("t1"))
    .set("idempotency-key", crypto.randomUUID())
    .send({ items: [
      { student_user_id: ids.s1, source_type: "exam", label: "Final", points: "80", max_points: "100" },
      { student_user_id: ids.s1, source_type: "assignment", label: "Homework", points: "60", max_points: "100" },
    ] });
  assert.equal(bulk.status, 201, JSON.stringify(bulk.body));
  await request(server).post(`/api/v1/sections/${section56}/grades/release`).set(auth("t1"));

  const gen = await request(server).post("/api/v1/report-cards/generate").set(auth("root"))
    .send({ term_id: term56 });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.ok(gen.body.generated >= 1);

  const card = await request(server).get(`/api/v1/students/${ids.s1}/report-card?term_id=${term56}`).set(auth("s1"));
  assert.equal(card.status, 200);
  const snap = card.body.data[0].snapshot;
  const sec = snap.sections.find((s) => s.section === "RC Section A");
  assert.ok(sec, "section in snapshot");
  assert.equal(sec.exam_pct, 80);
  assert.equal(sec.coursework_pct, 60);
  assert.equal(sec.weighted_pct, 74, "0.7·80 + 0.3·60 = 74");
  assert.equal(sec.letter, "B", "74 lands in the B band (60–74)");
  assert.equal(sec.point, 4);
  assert.ok(snap.overall, "overall present");
  assert.equal(snap.overall.letter, "B");
  assert.deepEqual(snap.grading.weights, { exam: 70, coursework: 30 }, "weights baked into the snapshot");
});

test("report card: missing term is refused, not silently guessed", async () => {
  const gen = await request(server).post("/api/v1/report-cards/generate").set(auth("root")).send({});
  assert.equal(gen.status, 403);
  assert.equal(gen.body.code, "validation");
});

/* ══ review-6 #5: every problem row is listed ════════════════════════════ */
test("import lists ALL error rows — no 500 cap", async () => {
  const rows = ["email,display_name,password,admission_no,grade_level"];
  for (let i = 0; i < 600; i++) rows.push(`bad-email-${i},Row ${i},,X-${i},10`);
  const dry = await request(server).post("/api/v1/import/students").set(auth("admin"))
    .send({ csv: rows.join("\n"), dry_run: true });
  assert.equal(dry.status, 201);
  assert.equal(dry.body.errors, 600);
  assert.equal(dry.body.rows.length, 600, "every failing row is listed");
  assert.ok(dry.body.rows.every((r) => r.status === "error" && r.errors?.length));
});
