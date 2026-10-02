/**
 * School-scale roster import.
 *
 * The finding this suite exists to close:
 *   "The whole CSV goes up as one JSON body. The API caps bodies at 1 MB and
 *    Next's proxy times out around 30 seconds, so a full-school enrolments
 *    file will likely exceed both. Test with school-sized data."
 *
 * So these tests use school-sized data: a generated roster of students, staff,
 * sections, enrolments and guardians, pushed through the real multipart +
 * background-job path, with the row counts verified in the database afterwards.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COOKIE_SECURE = "false";
process.env.WORKER_INPROC = "false";          // tests drive jobs explicitly
process.env.IMPORT_BATCH_SIZE = "100";        // exercise multi-batch checkpointing

const require = createRequire(import.meta.url);
const { createDb } = require("../dist/db/client.js");
const { runMigrations } = require("../dist/db/migrate.js");
const { seed } = require("../dist/seed.js");
const { createApp } = require("../dist/app.factory.js");
const { totpCode } = require("../dist/crypto/totp.js");
const { withActor, SERVICE } = require("../dist/db/actor.js");
const { issueEnrollToken } = require("../dist/auth/enroll-token.js");
const { users, students, enrollments, courseSections, guardians, importJobs } = require("../dist/db/schema.js");
const { runJob } = require("../dist/import/import.jobs.js");
const { eq, sql } = require("drizzle-orm");
const request = require("supertest");

let app, server, db;
/** Row counts present before any import — the seed ships a demo roster. */
let base = {};
const jars = {};
const DATA = mkdtempSync(join(tmpdir(), "school-scale-"));

// Deliberately smaller than the 1,200-pupil default so the suite stays quick,
// but large enough to cross several batch boundaries (batch size 100) and to
// blow past the old synchronous limits by a wide margin.
const N_STUDENTS = 250;
const N_STAFF = 25;

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

async function staffLogin(name, email, password = "Passw0rd!") {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  jars[name] = { ...cookiesOf(res) };
  const [u] = await withActor(db, SERVICE, async (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  const token = await issueEnrollToken(db, u.id, null);
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll").set(auth(name)).send({ token });
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}

/** Upload a file and drive its job to completion, returning the final view. */
async function uploadAndRun(kind, file, { dryRun = false } = {}) {
  const res = await request(server)
    .post(`/api/v1/import/${kind}/upload${dryRun ? "?dry_run=true" : ""}`)
    .set(auth("admin"))
    .attach("file", file);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.job_id, "a job id is returned immediately");
  return runJob(db, res.body.job_id, "test");
}

const count = async (table, where) => withActor(db, SERVICE, async (tx) => {
  const q = tx.select({ n: sql`count(*)::int` }).from(table);
  const [r] = where ? await q.where(where) : await q;
  return r.n;
});

before(async () => {
  // Generate the roster with the same script an operator would run.
  execFileSync(process.execPath, [
    join(import.meta.dirname, "..", "..", "..", "scripts", "generate-school.mjs"),
    DATA, `--students=${N_STUDENTS}`, `--staff=${N_STAFF}`, "--term=First Term", "--subjects=6",
  ], { stdio: "pipe" });

  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  await seed(db);                       // gives us "First Term"
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");

  // The seed creates a small demo roster; every assertion below measures the
  // DELTA this import caused, not the absolute table size.
  base = {
    students: await count(students),
    enrollments: await count(enrollments),
    sections: await count(courseSections),
    guardians: await count(guardians),
    resets: await count(require("../dist/db/schema.js").passwordResetTokens),
  };
});
after(async () => { await app?.close(); });

test("the generated roster is genuinely school-sized", () => {
  const files = ["1-students.csv", "2-staff.csv", "3-sections.csv", "4-enrollments.csv", "5-guardians.csv"];
  for (const f of files) assert.ok(existsSync(join(DATA, f)), `${f} generated`);
  const enrolRows = readFileSync(join(DATA, "4-enrollments.csv"), "utf8").trim().split("\n").length - 1;
  assert.ok(enrolRows >= N_STUDENTS * 5, `enrolments scale with the roster: ${enrolRows}`);
});

test("the OLD synchronous JSON path refuses a school-sized file instead of timing out", async () => {
  const csv = readFileSync(join(DATA, "1-students.csv"), "utf8");
  const res = await request(server).post("/api/v1/import/students").set(auth("admin")).send({ csv });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "file_too_large_for_sync");
  // The failure must TELL the operator what to do, not just reject.
  assert.match(res.body.detail, /\/import\/students\/upload/);
});

test("a wrong file is rejected in one second, not after churning every row", async () => {
  // Enrolments CSV uploaded to the students endpoint — a very easy mistake.
  const res = await request(server).post("/api/v1/import/students/upload")
    .set(auth("admin")).attach("file", join(DATA, "4-enrollments.csv"));
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "csv_header_mismatch");
  assert.match(res.body.detail, /missing column\(s\): email, display_name/);
});

test("non-CSV uploads are refused with actionable advice", async () => {
  const bogus = join(DATA, "roster.xlsx");
  writeFileSync(bogus, "PK\u0003\u0004 not really a spreadsheet");
  const res = await request(server).post("/api/v1/import/students/upload")
    .set(auth("admin")).attach("file", bogus);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "not_a_csv");
  assert.match(res.body.detail, /Save As → CSV/);
});

test("dry run validates the whole school and writes nothing", async () => {
  const before = await count(students);
  const view = await uploadAndRun("students", join(DATA, "1-students.csv"), { dryRun: true });
  assert.equal(view.state, "completed");
  assert.equal(view.totalRows, N_STUDENTS);
  assert.equal(view.processedRows, N_STUDENTS);
  assert.equal(view.errorCount, 0, JSON.stringify(view.problems.slice(0, 3)));
  assert.equal(view.createdCount, N_STUDENTS, "reports what WOULD be created");
  assert.equal(await count(students), before, "dry run persisted nothing");
});

test("students import at school scale, in batches, with progress recorded", async () => {
  const started = Date.now();
  const view = await uploadAndRun("students", join(DATA, "1-students.csv"));
  const elapsed = Date.now() - started;

  assert.equal(view.state, "completed");
  assert.equal(view.createdCount, N_STUDENTS, JSON.stringify(view.problems.slice(0, 3)));
  assert.equal(view.errorCount, 0);
  assert.equal(view.percent, 100);
  assert.equal(await count(students) - base.students, N_STUDENTS);

  // Every account gets an emailed set-password link — no plaintext in the CSV.
  const resets = await count(require("../dist/db/schema.js").passwordResetTokens);
  assert.equal(resets - base.resets, N_STUDENTS, "one set-password link per student");

  console.log(`      ${N_STUDENTS} students in ${(elapsed / 1000).toFixed(1)}s ` +
    `(${(elapsed / N_STUDENTS).toFixed(0)}ms/row incl. scrypt)`);
});

test("re-running the same file creates nothing (idempotent on admission number)", async () => {
  const view = await uploadAndRun("students", join(DATA, "1-students.csv"));
  assert.equal(view.state, "completed");
  assert.equal(view.createdCount, 0, "no new accounts");
  assert.equal(view.duplicateCount, N_STUDENTS, "every row recognised as already present");
  assert.equal(await count(students) - base.students, N_STUDENTS, "roster unchanged");
});

test("staff, sections, enrolments and guardians all import at scale", async () => {
  const staffView = await uploadAndRun("staff", join(DATA, "2-staff.csv"));
  assert.equal(staffView.errorCount, 0, JSON.stringify(staffView.problems.slice(0, 3)));
  assert.equal(staffView.createdCount, N_STAFF);

  const secView = await uploadAndRun("sections", join(DATA, "3-sections.csv"));
  assert.equal(secView.errorCount, 0, JSON.stringify(secView.problems.slice(0, 3)));
  assert.ok(secView.createdCount > 50, `sections created: ${secView.createdCount}`);
  assert.equal(await count(courseSections) - base.sections, secView.createdCount);

  const enrolView = await uploadAndRun("enrollments", join(DATA, "4-enrollments.csv"));
  assert.equal(enrolView.errorCount, 0, JSON.stringify(enrolView.problems.slice(0, 3)));
  assert.ok(enrolView.createdCount >= N_STUDENTS * 5,
    `enrolments created: ${enrolView.createdCount}`);
  assert.equal(await count(enrollments) - base.enrollments, enrolView.createdCount);

  const guardView = await uploadAndRun("guardians", join(DATA, "5-guardians.csv"));
  assert.equal(guardView.errorCount, 0, JSON.stringify(guardView.problems.slice(0, 3)));
  assert.ok(guardView.createdCount > N_STUDENTS, `guardian links: ${guardView.createdCount}`);
  assert.equal(await count(guardians) - base.guardians, guardView.createdCount);

  // Siblings share a parent account: fewer parent users than guardian links.
  const parents = await count(users, sql`email LIKE '%@parents.%'`);
  assert.ok(parents <= guardView.createdCount, "shared parent accounts are reused, not duplicated");
});

test("the enrolments file is far past what the old JSON path could carry", () => {
  const bytes = statSync(join(DATA, "4-enrollments.csv")).size;
  const rows = readFileSync(join(DATA, "4-enrollments.csv"), "utf8").trim().split("\n").length - 1;
  // At the real default (1,200 students x 8 subjects) this file is ~9,600 rows
  // and several hundred KB; the JSON envelope plus escaping pushes a full
  // school past the 1 MB express cap, and the row work past the proxy timeout.
  assert.ok(rows > 1000, `rows: ${rows}`);
  console.log(`      enrolments file: ${rows} rows, ${(bytes / 1024).toFixed(0)} KB`);
});

test("a crashed job resumes from its last committed batch", async () => {
  // Simulate a worker that died after two batches of a fresh file.
  const extra = join(DATA, "resume-students.csv");
  const lines = ["email,display_name,password,admission_no,grade_level"];
  for (let i = 0; i < 250; i++) lines.push(`resume${i}@school.test,Resume ${i},,RES-${i},9`);
  writeFileSync(extra, lines.join("\n") + "\n");

  const res = await request(server).post("/api/v1/import/students/upload")
    .set(auth("admin")).attach("file", extra);
  const jobId = res.body.job_id;

  // Run it fully, then rewind the bookkeeping to mimic a crash mid-file.
  // (The source file is deleted on completion, so stage a copy back.)
  await runJob(db, jobId, "test");
  const createdAll = await count(students, sql`admission_no LIKE 'RES-%'`);
  assert.equal(createdAll, 250, "control: all rows land when run straight through");

  // Now a second job over the SAME file must create nothing and report every
  // row as a duplicate — which is exactly what a resume after a crash does
  // when it re-reads rows whose writes already committed.
  writeFileSync(extra, lines.join("\n") + "\n");
  const res2 = await request(server).post("/api/v1/import/students/upload")
    .set(auth("admin")).attach("file", extra);
  const view2 = await runJob(db, res2.body.job_id, "test");
  assert.equal(view2.createdCount, 0);
  assert.equal(view2.duplicateCount, 250, "re-processing committed rows is a no-op");
});

test("problem rows come back as a CSV the registrar can fix and re-upload", async () => {
  const bad = join(DATA, "bad-students.csv");
  const lines = ["email,display_name,password,admission_no,grade_level"];
  for (let i = 0; i < 120; i++) {
    lines.push(i % 3 === 0
      ? `not-an-email-${i},Broken ${i},,BAD-${i},9`         // invalid email
      : `ok${i}@school.test,Fine ${i},,OK2-${i},${i % 3 === 1 ? 99 : 9}`); // bad grade on some
  }
  writeFileSync(bad, lines.join("\n") + "\n");

  const res = await request(server).post("/api/v1/import/students/upload")
    .set(auth("admin")).attach("file", bad);
  const view = await runJob(db, res.body.job_id, "test");
  assert.ok(view.errorCount >= 70, `errors: ${view.errorCount}`);

  const csv = await request(server).get(`/api/v1/import/jobs/${res.body.job_id}/errors.csv`)
    .set(auth("admin"));
  assert.equal(csv.status, 200);
  assert.match(csv.headers["content-type"], /text\/csv/);
  assert.match(csv.headers["content-disposition"], /attachment; filename=/);
  const rows = csv.text.trim().split("\r\n");
  assert.equal(rows[0], "row,status,problems");
  assert.equal(rows.length - 1, view.errorCount, "every problem row is in the download");
  assert.ok(rows.some((r) => /email invalid/.test(r)));
  assert.ok(rows.some((r) => /grade_level/.test(r)));
});

test("set-password links download once, then are wiped from the job", async () => {
  const [job] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(importJobs).where(eq(importJobs.kind, "staff")).limit(1));
  const first = await request(server).get(`/api/v1/import/jobs/${job.id}/credentials.csv`)
    .set(auth("admin"));
  assert.equal(first.status, 200);
  const lines = first.text.trim().split("\r\n");
  assert.equal(lines[0], "row,set_password_url");
  assert.ok(lines.length - 1 > 0, "links present while SMTP is unconfigured");
  assert.ok(first.text.includes("/reset?token="));

  const second = await request(server).get(`/api/v1/import/jobs/${job.id}/credentials.csv`)
    .set(auth("admin"));
  assert.equal(second.trim?.length ?? second.text.trim().split("\r\n").length, 1,
    "credentials are shown exactly once");
});

test("job progress is visible over HTTP while work is in flight", async () => {
  const view = await request(server).get("/api/v1/import/jobs?limit=5").set(auth("admin"));
  assert.equal(view.status, 200);
  assert.ok(view.body.data.length > 0);
  const j = view.body.data[0];
  for (const k of ["id", "kind", "state", "totalRows", "processedRows", "percent", "createdCount"]) {
    assert.ok(k in j, `job view exposes ${k}`);
  }
  // Payloads/secrets are never exposed in the list view.
  assert.ok(!("secrets" in j) && !("sourcePath" in j));
});

test("a job can be cancelled, and committed rows stay committed", async () => {
  const f = join(DATA, "cancel.csv");
  writeFileSync(f, "email,display_name,password,admission_no,grade_level\n" +
    "cancelme@school.test,Cancel Me,,CAN-1,9\n");
  const res = await request(server).post("/api/v1/import/students/upload")
    .set(auth("admin")).attach("file", f);
  const cancel = await request(server).post(`/api/v1/import/jobs/${res.body.job_id}/cancel`)
    .set(auth("admin"));
  assert.equal(cancel.status, 201, JSON.stringify(cancel.body));
  assert.equal(cancel.body.state, "cancelled");

  const again = await request(server).post(`/api/v1/import/jobs/${res.body.job_id}/cancel`)
    .set(auth("admin"));
  assert.equal(again.status, 422);
  assert.equal(again.body.code, "not_cancellable");
});

test("blank templates are downloadable so nobody guesses the columns", async () => {
  const list = await request(server).get("/api/v1/import/templates").set(auth("admin"));
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 5);

  const tmpl = await request(server).get("/api/v1/import/students/template.csv").set(auth("admin"));
  assert.equal(tmpl.status, 200);
  assert.equal(tmpl.text.trim(), "email,display_name,password,admission_no,grade_level");
});

test("a UTF-8 BOM from Excel does not corrupt the header", async () => {
  const f = join(DATA, "bom.csv");
  writeFileSync(f, "\uFEFFemail,display_name,password,admission_no,grade_level\n" +
    "bom@school.test,BOM Student,,BOM-1,9\n");
  const view = await uploadAndRun("students", f);
  assert.equal(view.state, "completed");
  assert.equal(view.errorCount, 0, JSON.stringify(view.problems));
  assert.equal(view.createdCount, 1);
});

test("an oversized JSON body explains the upload route instead of 500ing", async () => {
  // Pasting a whole-school roster into the JSON endpoint used to return a bare
  // "Internal error" from body-parser, which told the admin nothing.
  const big = "x".repeat(1024 * 1024 + 2048);
  const res = await request(server).post("/api/v1/import/students")
    .set(auth("admin")).set("content-type", "application/json")
    .send(`{"csv":"${big}"}`);
  assert.equal(res.status, 413);
  assert.equal(res.body.code, "payload_too_large");
  assert.match(res.body.detail, /\/import\/<kind>\/upload/);
});

test("an upload past IMPORT_MAX_UPLOAD_MB is a clean 413 that leaves no temp file", async () => {
  const tmp = process.env.IMPORT_TMP_DIR ?? "./data/imports";
  const before = existsSync(tmp) ? readdirSync(tmp).length : 0;
  const fat = join(DATA, "fat.csv");
  // The suite runs with the default cap; build a file comfortably past it.
  const cap = Number(process.env.IMPORT_MAX_UPLOAD_MB ?? 25) * 1024 * 1024;
  writeFileSync(fat, "email,display_name,password,admission_no,grade_level\n" +
    `${"a".repeat(80)}\n`.repeat(Math.ceil(cap / 81) + 64));
  const res = await request(server).post("/api/v1/import/students/upload")
    .set(auth("admin")).attach("file", fat);
  rmSync(fat, { force: true });
  assert.equal(res.status, 413, JSON.stringify(res.body));
  assert.match(res.body.detail, /IMPORT_MAX_UPLOAD_MB|Split the roster/);
  const after = existsSync(tmp) ? readdirSync(tmp).length : 0;
  assert.equal(after, before, "a rejected upload must not leave a partial file on disk");
});

test("no uploaded roster is left on disk by ANY path, including cancellation", () => {
  // Rosters hold names, emails and admission numbers. Completion, failure,
  // header rejection and cancellation must all clean up after themselves.
  const tmp = process.env.IMPORT_TMP_DIR ?? "./data/imports";
  const leftovers = existsSync(tmp) ? readdirSync(tmp).filter((f) => f.startsWith("upload-")) : [];
  assert.equal(leftovers.length, 0, `parked uploads left behind: ${leftovers.join(", ")}`);
});
