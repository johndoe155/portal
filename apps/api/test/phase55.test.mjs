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
const { users } = require("../dist/db/schema.js");
const { eq } = require("drizzle-orm");
const request = require("supertest");

let app, server, db, ids;
const jars = {};
const PW = "Passw0rd!Policy1"; // admin-created users must meet the 12-char policy

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
async function loginAs(name, email, password = "Passw0rd!") {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  jars[name] = { ...cookiesOf(res) };
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
  await staffLogin("t1", "t1@school.example");
});
after(async () => { await app.close(); });

/* ── phase 6.1: school settings ── */
test("school settings: public GET, settings:write PUT, identity flows to emails", async () => {
  const anon = await request(server).get("/api/v1/school");
  assert.equal(anon.status, 200, "login page must render the school identity pre-auth");
  assert.ok(anon.body.name, "default name present");

  const upd = await request(server).put("/api/v1/school").set(auth("admin"))
    .send({ name: "Bright Future Academy", timezone: "Africa/Lagos", currency: "NGN",
      contact_email: "office@bfa.example", dpo_email: "dpo@bfa.example",
      mail_sender: "portal@bfa.example", primary_color: "#065f46" });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));

  const after = await request(server).get("/api/v1/school");
  assert.equal(after.body.name, "Bright Future Academy");
  assert.equal(after.body.dpo_email, "dpo@bfa.example");
  assert.equal(after.body.currency, "NGN");

  // teachers hold no settings:write
  const denied = await request(server).put("/api/v1/school").set(auth("t1"))
    .send({ name: "Hijacked School" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "missing_capability");
  // and the anonymous PUT is refused too (CSRF/permission gates run first)
  const anonPut = await request(server).put("/api/v1/school").send({ name: "Nope" });
  assert.ok(anonPut.status === 401 || anonPut.status === 403, `got ${anonPut.status}`);
});

/* ── phase 6.2: academic years + terms ── */
let yearId, termId;
test("academic years and terms can be created without the demo seed", async () => {
  const yearName = `TestYear ${Date.now()}`;
  const year = await request(server).post("/api/v1/academic-years").set(auth("admin"))
    .send({ name: yearName, start_date: "2026-09-01", end_date: "2027-07-31", make_current: true });
  assert.equal(year.status, 201, JSON.stringify(year.body));
  yearId = year.body.id;
  assert.equal(year.body.isCurrent, true);

  const dupeYear = await request(server).post("/api/v1/academic-years").set(auth("admin"))
    .send({ name: yearName, start_date: "2026-09-01", end_date: "2027-07-31" });
  assert.equal(dupeYear.status, 409);
  assert.equal(dupeYear.body.code, "year_exists");

  const badRange = await request(server).post("/api/v1/academic-years").set(auth("admin"))
    .send({ name: "Broken", start_date: "2027-01-01", end_date: "2026-01-01" });
  assert.equal(badRange.status, 422);

  const term = await request(server).post("/api/v1/terms").set(auth("admin"))
    .send({ academic_year_id: yearId, term_no: 1, name: "Harmattan Term" });
  assert.equal(term.status, 201, JSON.stringify(term.body));
  termId = term.body.id;

  const dupeTerm = await request(server).post("/api/v1/terms").set(auth("admin"))
    .send({ academic_year_id: yearId, term_no: 1, name: "Harmattan Again" });
  assert.equal(dupeTerm.status, 409);
  assert.equal(dupeTerm.body.code, "term_exists");

  // one current year at a time
  const year2 = await request(server).post("/api/v1/academic-years").set(auth("admin"))
    .send({ name: `TestYearB ${Date.now()}`, start_date: "2027-09-01", end_date: "2028-07-31", make_current: true });
  assert.equal(year2.status, 201);
  const list = await request(server).get("/api/v1/academic-years").set(auth("admin"));
  const currents = list.body.data.filter((y) => y.isCurrent);
  assert.equal(currents.length, 1);
  assert.equal(currents[0].id, year2.body.id);
  // switching back is explicit
  const back = await request(server).post(`/api/v1/academic-years/${yearId}/set-current`).set(auth("admin"));
  assert.equal(back.status, 201);
});

/* ── phase 6.2: student records ── */
let stuA, stuB;
test("creating a student user also creates the students record", async () => {
  const email = `amina.${Date.now()}@school.example`;
  const made = await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email, display_name: "Amina Student", password: PW, roles: ["student"],
      admission_no: "bfa-0001", grade_level: 10 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  stuA = made.body.id;

  const list = await request(server).get("/api/v1/students?q=amina").set(auth("admin"));
  const row = list.body.data.find((r) => r.userId === stuA);
  assert.ok(row, "students row exists");
  assert.equal(row.admissionNo, "BFA-0001", "admission number normalized");
  assert.equal(row.gradeLevel, 10);

  // grade_level is mandatory for students
  const noGrade = await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email: `nograde.${Date.now()}@school.example`, display_name: "No Grade",
      password: PW, roles: ["student"] });
  assert.equal(noGrade.status, 422);
  assert.equal(noGrade.body.code, "grade_level_required");

  // admission numbers are unique
  const dupeAdm = await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email: `dupe.${Date.now()}@school.example`, display_name: "Dupe Adm",
      password: PW, roles: ["student"], admission_no: "BFA-0001", grade_level: 9 });
  assert.equal(dupeAdm.status, 409);
  assert.equal(dupeAdm.body.code, "admission_no_taken");

  // auto admission number when omitted
  const email2 = `bello.${Date.now()}@school.example`;
  const made2 = await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email: email2, display_name: "Bello Student", password: PW, roles: ["student"], grade_level: 10 });
  assert.equal(made2.status, 201);
  stuB = made2.body.id;
  const list2 = await request(server).get("/api/v1/students?q=bello").set(auth("admin"));
  const row2 = list2.body.data.find((r) => r.userId === stuB);
  assert.match(row2.admissionNo, /^STU-\d{4}$/, "auto admission number");

  // PATCH updates the record
  const patch = await request(server).patch(`/api/v1/students/${stuB}`).set(auth("admin"))
    .send({ grade_level: 11, status: "active" });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.gradeLevel, 11);
});

/* ── phase 6.2: guardian links with verification ── */
let mamaJar = "mama";
test("guardian links: email-proven verification, admin confirm, revoke", async () => {
  const mamaEmail = `mama.${Date.now()}@school.example`;
  const mama = await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email: mamaEmail, display_name: "Mama Amina", password: PW, roles: ["parent"] });
  assert.equal(mama.status, 201);

  // no account → clear error (invite first)
  const noAcct = await request(server).post(`/api/v1/students/${stuA}/guardians`).set(auth("admin"))
    .send({ guardian_email: `ghost.${Date.now()}@school.example`, relationship: "mother" });
  assert.equal(noAcct.status, 422);
  assert.equal(noAcct.body.code, "guardian_not_found");

  const link = await request(server).post(`/api/v1/students/${stuA}/guardians`).set(auth("admin"))
    .send({ guardian_email: mamaEmail, relationship: "mother" });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  assert.ok(link.body.verifyToken && link.body.verifyUrl, "dev sink exposes the verify link");

  const dupe = await request(server).post(`/api/v1/students/${stuA}/guardians`).set(auth("admin"))
    .send({ guardian_email: mamaEmail, relationship: "mother" });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, "link_exists");

  // unverified: child not visible yet
  await loginAs(mamaJar, mamaEmail, PW);
  let kids = await request(server).get("/api/v1/parent/children").set(auth(mamaJar));
  assert.equal(kids.status, 200);
  const kidRow = kids.body.data.find((k) => k.studentUserId === stuA);
  assert.ok(kidRow, "listed once linked");
  assert.equal(kidRow.verified, null, "not verified yet");
  const feesBlocked = await request(server).get(`/api/v1/parent/children/${stuA}/fees`).set(auth(mamaJar));
  assert.ok([403, 404].includes(feesBlocked.status),
    `RLS blocks unverified access (403/404), got ${feesBlocked.status}`);

  // wrong account cannot consume the token
  const papaEmail = `papa.${Date.now()}@school.example`;
  await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email: papaEmail, display_name: "Papa Amina", password: PW, roles: ["parent"] });
  await loginAs("papa", papaEmail, PW);
  const wrong = await request(server).post("/api/v1/family/guardian-verify").set(auth("papa"))
    .send({ token: link.body.verifyToken });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "verify_wrong_account");

  // right account verifies
  const okv = await request(server).post("/api/v1/family/guardian-verify").set(auth(mamaJar))
    .send({ token: link.body.verifyToken });
  assert.equal(okv.status, 201, JSON.stringify(okv.body));
  const replay = await request(server).post("/api/v1/family/guardian-verify").set(auth(mamaJar))
    .send({ token: link.body.verifyToken });
  assert.equal(replay.status, 401, "token single-use");

  kids = await request(server).get("/api/v1/parent/children").set(auth(mamaJar));
  assert.ok(kids.body.data.find((k) => k.studentUserId === stuA).verified, "verified flag set");

  // admin confirm path (office verification) + revoke
  const link2 = await request(server).post(`/api/v1/students/${stuA}/guardians`).set(auth("admin"))
    .send({ guardian_email: papaEmail, relationship: "father" });
  assert.equal(link2.status, 201);
  const confirm = await request(server).post(`/api/v1/guardian-links/${link2.body.id}/confirm`).set(auth("admin"));
  assert.equal(confirm.status, 201);
  const revoke = await request(server).post(`/api/v1/guardian-links/${link2.body.id}/revoke`).set(auth("admin"));
  assert.equal(revoke.status, 201);
  const papaKids = await request(server).get("/api/v1/parent/children").set(auth("papa"));
  assert.equal(papaKids.body.data.find((k) => k.studentUserId === stuA), undefined, "revoked link gone");
});

/* ── phase 6.2: teacher → section assignment ── */
let sectionId;
test("teacher assignment gates their sections; unassign removes access", async () => {
  const sec = await request(server).post("/api/v1/sections").set(auth("admin"))
    .send({ course_code: "BIO", course_title: "Biology", name: "BIO-10 A", term_id: termId });
  assert.equal(sec.status, 201, JSON.stringify(sec.body));
  sectionId = sec.body.id;

  const before = await request(server).get("/api/v1/sections").set(auth("t1"));
  assert.ok(!before.body.data.some((s) => s.id === sectionId), "not t1's section yet");

  const t1 = await withActor(db, SERVICE, async (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, "t1@school.example")).limit(1));
  const assign = await request(server).post(`/api/v1/sections/${sectionId}/staff`).set(auth("admin"))
    .send({ user_id: t1[0].id, role: "teacher" });
  assert.equal(assign.status, 201, JSON.stringify(assign.body));

  const dupe = await request(server).post(`/api/v1/sections/${sectionId}/staff`).set(auth("admin"))
    .send({ user_id: t1[0].id, role: "teacher" });
  assert.equal(dupe.status, 409);

  const after = await request(server).get("/api/v1/sections").set(auth("t1"));
  assert.ok(after.body.data.some((s) => s.id === sectionId), "t1 now sees the section");

  const un = await request(server).delete(`/api/v1/sections/${sectionId}/staff/${t1[0].id}`).set(auth("admin"));
  assert.equal(un.status, 200);
  const afterUn = await request(server).get("/api/v1/sections").set(auth("t1"));
  assert.ok(!afterUn.body.data.some((s) => s.id === sectionId), "access removed");
});

/* ── phase 6.3: CSV bulk import ── */
const CSV_STUDENTS = [
  "email,display_name,password,admission_no,grade_level",
  `csv1.${Date.now()}@school.example,CSV One,${PW},CSV-001,10`,
  `csv2.${Date.now()}@school.example,CSV Two,${PW},CSV-002,10`,
  `bad-row@school.example,CSV Bad,short,CSV-003,99`,
].join("\n");

test("CSV import: dry-run validates without writing, commit dedupes on admission number", async () => {
  const dry = await request(server).post("/api/v1/import/students").set(auth("admin"))
    .send({ csv: CSV_STUDENTS, dry_run: true });
  assert.equal(dry.status, 201, JSON.stringify(dry.body).slice(0, 300));
  assert.equal(dry.body.dry_run, true);
  assert.equal(dry.body.total, 3);
  assert.equal(dry.body.would_create, 2, "valid rows counted");
  assert.equal(dry.body.errors, 1, "bad row reported");
  const badRow = dry.body.rows.find((r) => r.status === "error");
  assert.ok(badRow.errors.join(" ").match(/password|grade_level/), `errors explained: ${badRow.errors}`);

  // nothing was written
  let list = await request(server).get("/api/v1/students?q=CSV").set(auth("admin"));
  assert.equal(list.body.data.length, 0, "dry run wrote nothing");

  const commit = await request(server).post("/api/v1/import/students").set(auth("admin"))
    .send({ csv: CSV_STUDENTS });
  assert.equal(commit.body.created, 2, JSON.stringify(commit.body).slice(0, 300));
  assert.equal(commit.body.errors, 1);

  // re-import → duplicates, no new rows
  const again = await request(server).post("/api/v1/import/students").set(auth("admin"))
    .send({ csv: CSV_STUDENTS });
  assert.equal(again.body.duplicates, 2);
  assert.equal(again.body.created, 0);

  list = await request(server).get("/api/v1/students?q=CSV").set(auth("admin"));
  assert.equal(list.body.data.length, 2, "exactly the two valid students exist");

  // permissions: teachers cannot import
  const denied = await request(server).post("/api/v1/import/students").set(auth("t1"))
    .send({ csv: CSV_STUDENTS });
  assert.equal(denied.status, 403);
});

test("CSV import: sections and enrollments reconcile into class head-counts", async () => {
  const csvSections = [
    "course_code,course_title,name,term_name",
    "MTH,Mathematics,MTH-CSV A,Harmattan Term",
  ].join("\n");
  const sec = await request(server).post("/api/v1/import/sections").set(auth("admin"))
    .send({ csv: csvSections });
  assert.equal(sec.body.created, 1, JSON.stringify(sec.body).slice(0, 300));

  const csvEnroll = [
    "student_admission_no,course_code,section_name,term_name",
    "CSV-001,MTH,MTH-CSV A,Harmattan Term",
    "CSV-002,MTH,MTH-CSV A,Harmattan Term",
    "CSV-001,MTH,MTH-CSV A,Harmattan Term", // dupe within file → skipped on second pass
    "GHOST-9,MTH,MTH-CSV A,Harmattan Term", // unknown student → error
  ].join("\n");
  const enr = await request(server).post("/api/v1/import/enrollments").set(auth("admin"))
    .send({ csv: csvEnroll });
  assert.equal(enr.body.created, 2, JSON.stringify(enr.body).slice(0, 300));
  assert.equal(enr.body.duplicates, 1);
  assert.equal(enr.body.errors, 1);
});

/* ── phase 6.4: grading config + fee templates ── */
test("grading scale is editable and read back sorted", async () => {
  const def = await request(server).get("/api/v1/grading-config").set(auth("admin"));
  assert.equal(def.status, 200);
  assert.ok(Array.isArray(def.body.scale) && def.body.scale.length >= 5, "sensible default scale");

  const put = await request(server).put("/api/v1/grading-config").set(auth("admin"))
    .send({ scale: [
      { letter: "F", min_pct: 0, point: 0 },
      { letter: "A", min_pct: 75, point: 4 },
      { letter: "B", min_pct: 60, point: 3 },
    ], weights: { exam: 70, coursework: 30 } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.scale.map((s) => s.letter), ["A", "B", "F"], "sorted by min_pct desc");

  const back = await request(server).get("/api/v1/grading-config").set(auth("admin"));
  assert.equal(back.body.weights.exam, 70);
});

test("fee templates generate term invoices for the grade scope, deduped", async () => {
  const tpl = await request(server).post("/api/v1/fees/templates").set(auth("admin"))
    .send({ name: "Tuition — Harmattan Term", amount_kobo: 25000000, grade_level: 10, due_days: 21 });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.body));

  const gen = await request(server).post(`/api/v1/fees/templates/${tpl.body.id}/generate`).set(auth("admin"))
    .send({ term_id: termId });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.ok(gen.body.created >= 3, `every active grade-10 student invoiced (${gen.body.created})`);
  assert.equal(gen.body.skipped, 0);

  const again = await request(server).post(`/api/v1/fees/templates/${tpl.body.id}/generate`).set(auth("admin"))
    .send({ term_id: termId });
  assert.equal(again.body.created, 0);
  assert.equal(again.body.skipped, gen.body.created, "idempotent per (student, term, label)");

  // CSV One sees the invoice on their own ledger
  const csv1 = (await request(server).get("/api/v1/students?q=CSV-001").set(auth("admin")))
    .body.data[0];
  const ledger = await request(server).get("/api/v1/fees/invoices").set(auth("admin"));
  const mine = ledger.body.data.filter((i) => i.studentUserId === csv1.userId);
  assert.ok(mine.some((i) => i.label === "Tuition — Harmattan Term" && i.amountKobo === 25000000));
});

/* ── phase 6.6: reconciliation report ── */
test("reconciliation report: head-counts, parents without children, students without guardians", async () => {
  const rep = await request(server).get("/api/v1/reports/reconciliation").set(auth("admin"));
  assert.equal(rep.status, 200, JSON.stringify(rep.body).slice(0, 200));
  const csvSection = rep.body.sections.find((s) => s.name === "MTH-CSV A");
  assert.ok(csvSection, "section listed");
  assert.equal(csvSection.head_count, 2, "two CSV students enrolled");

  // papa's link was revoked → papa has no child
  const papaRow = rep.body.parents_without_children.find((u) => u.email.startsWith("papa."));
  assert.ok(papaRow, "revoked-guardian parent flagged");

  // Bello has no guardian link
  const bello = rep.body.students_without_guardians.find((s) => s.userId === stuB);
  assert.ok(bello, "student without guardian flagged");

  // teachers cannot read the report
  const denied = await request(server).get("/api/v1/reports/reconciliation").set(auth("t1"));
  assert.equal(denied.status, 403);
});
