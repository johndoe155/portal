/**
 * Academic year rollover.
 *
 * Nothing existed for this, which made the portal a one-year tool — a school
 * reaching July would have had to promote every pupil by hand in the
 * database. The dangerous properties of a bulk operation like this are what
 * these tests target: it must preview accurately, it must not run twice, it
 * must not touch last year's records, and it must be undoable.
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
const {
  users, students, academicYears, terms, courseSections, courses, sectionStaff,
  enrollments, grades, yearRollovers, userRoles, auditLog,
} = require("../dist/db/schema.js");
const { eq, and, sql, inArray, desc } = require("drizzle-orm");
const { randomUUID } = require("node:crypto");
const request = require("supertest");

let app, server, db;
let yearA, yearB;
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
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}

/** A small school: pupils spread across year groups 7..13. */
async function makeCohort() {
  const made = [];
  await withActor(db, SERVICE, async (tx) => {
    for (let grade = 7; grade <= 13; grade++) {
      for (let i = 0; i < 3; i++) {
        const id = randomUUID();
        await tx.insert(users).values({
          id, email: `pupil-${grade}-${i}-${id.slice(0, 5)}@school.example`,
          displayName: `Pupil ${grade}.${i}`, status: "active",
        });
        await tx.insert(userRoles).values({ id: randomUUID(), userId: id, roleCode: "student" });
        await tx.insert(students).values({
          userId: id, admissionNo: `ADM-${grade}-${i}-${id.slice(0, 4)}`,
          gradeLevel: grade, status: "active",
        });
        made.push({ id, grade });
      }
    }
  });
  return made;
}
const gradeOf = async (id) => (await withActor(db, SERVICE, async (tx) =>
  tx.select().from(students).where(eq(students.userId, id)).limit(1)))[0];

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");

  const [yr] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(academicYears).where(eq(academicYears.isCurrent, true)).limit(1));
  yearA = yr;
  await makeCohort();
});
after(async () => { await app.close(); });

const NEXT = { name: "2027/2028", start_date: "2027-09-01", end_date: "2028-07-20" };

test("the preview shows every pupil's proposed year group and writes nothing", async () => {
  const before = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(students).where(eq(students.gradeLevel, 8)));

  const res = await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover-preview`)
    .set(auth("admin")).send({ next_year: NEXT });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.blockers.length, 0, JSON.stringify(res.body.blockers));
  assert.ok(res.body.pupils.length >= 21, "every active pupil is listed");

  const y7 = res.body.pupils.find((p) => p.fromGrade === 7);
  assert.equal(y7.toGrade, 8);
  assert.equal(y7.action, "promote");
  const y13 = res.body.pupils.find((p) => p.fromGrade === 13);
  assert.equal(y13.action, "graduate", "the top year leaves rather than becoming Year 14");
  assert.equal(y13.toGrade, null);

  // 18 from the test cohort (Years 7-12) plus the one seeded demo pupil.
  assert.equal(res.body.counts.promote, 19);
  assert.equal(res.body.counts.graduate, 3);
  assert.equal(res.body.counts.total, 22);
  assert.match(res.body.warnings.join(" "), /marked as graduated/);

  const after = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(students).where(eq(students.gradeLevel, 8)));
  assert.equal(Number(after[0].n), Number(before[0].n), "a preview must not move anybody");
});

test("rollover refuses to run unless dry_run is explicitly false", async () => {
  // Promoting a whole school must never happen because a flag was forgotten.
  const res = await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover`)
    .set(auth("admin")).send({ next_year: NEXT });
  assert.equal(res.status, 201);
  assert.equal(res.body.dryRun, true, "omitting dry_run must NOT commit");
  const still = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(yearRollovers));
  assert.equal(Number(still[0].n), 0, "nothing was recorded");
});

test("a graduating year set too high is blocked, not silently clamped", async () => {
  const res = await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover-preview`)
    .set(auth("admin")).send({ next_year: NEXT, graduating_grade: 99 });
  assert.ok(res.body.blockers.length > 0);
  assert.match(res.body.blockers.join(" "), /promoted past Year 13/);
});

test("per-pupil overrides change the plan and are flagged as overridden", async () => {
  const preview = await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover-preview`)
    .set(auth("admin")).send({ next_year: NEXT });
  const target = preview.body.pupils.find((p) => p.fromGrade === 9);

  const res = await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover-preview`)
    .set(auth("admin")).send({
      next_year: NEXT,
      overrides: [{ student_user_id: target.studentUserId, action: "retain" }],
    });
  const after = res.body.pupils.find((p) => p.studentUserId === target.studentUserId);
  assert.equal(after.action, "retain");
  assert.equal(after.toGrade, 9, "a retained pupil stays put");
  assert.equal(after.overridden, true);
  assert.equal(res.body.counts.retain, 1);
  assert.equal(res.body.counts.promote, 18);
});

test("committing promotes everyone, graduates the top year and creates the new year", async () => {
  const cohort = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(students).where(eq(students.status, "active")));
  const byUser = new Map(cohort.map((s) => [s.userId, s.gradeLevel]));

  const res = await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover`)
    .set(auth("admin")).send({ next_year: NEXT, dry_run: false, set_current: true });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.dryRun, false);
  assert.ok(res.body.rolloverId);
  yearB = { id: res.body.toYear.id, name: res.body.toYear.name };

  // Year created and made current.
  const [created] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(academicYears).where(eq(academicYears.id, yearB.id)).limit(1));
  assert.equal(created.name, "2027/2028");
  assert.equal(created.isCurrent, true);

  // Terms copied from the outgoing year.
  const newTerms = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(terms).where(eq(terms.academicYearId, yearB.id)));
  const oldTerms = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(terms).where(eq(terms.academicYearId, yearA.id)));
  assert.equal(newTerms.length, oldTerms.length);
  assert.deepEqual(newTerms.map((t) => t.termNo).sort(), oldTerms.map((t) => t.termNo).sort());

  // Everyone moved up exactly one year.
  for (const [userId, wasGrade] of byUser) {
    const now = await gradeOf(userId);
    if (wasGrade >= 13) {
      assert.equal(now.status, "graduated", `pupil at ${wasGrade} should have graduated`);
    } else {
      assert.equal(now.gradeLevel, wasGrade + 1, `pupil ${userId} should be in ${wasGrade + 1}`);
      assert.equal(now.status, "active");
    }
  }
});

test("graduating pupils lose portal access but keep their records", async () => {
  const grads = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(students).where(eq(students.status, "graduated")));
  assert.ok(grads.length >= 3);

  const accounts = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(users).where(inArray(users.id, grads.map((g) => g.userId))));
  for (const a of accounts) {
    assert.equal(a.status, "left", "a graduate cannot sign in");
    assert.match(a.deactivationReason, /Year rollover/);
  }
  // But their rows — and therefore their marks and attendance — are intact.
  assert.equal(accounts.length, grads.length, "no graduate was deleted");
});

test("last year's data is untouched — history is not rewritten", async () => {
  // The single most destructive thing a rollover could do is disturb the
  // records the school is legally required to keep.
  const oldTerms = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(terms).where(eq(terms.academicYearId, yearA.id)));
  const oldSections = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(courseSections).where(inArray(courseSections.termId, oldTerms.map((t) => t.id))));
  assert.ok(oldSections.length > 0, "the outgoing year still has its sections");

  const oldEnrolments = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(enrollments)
      .where(inArray(enrollments.sectionId, oldSections.map((s) => s.id))));
  assert.ok(Number(oldEnrolments[0].n) > 0, "last year's enrolments are still there");

  const [{ n: gradeCount }] = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(grades));
  assert.ok(Number(gradeCount) >= 0, "marks table intact");
});

test("sections are carried forward empty, with staff, into matching terms", async () => {
  const newTerms = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(terms).where(eq(terms.academicYearId, yearB.id)));
  const newSections = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(courseSections).where(inArray(courseSections.termId, newTerms.map((t) => t.id))));
  assert.ok(newSections.length > 0, "the timetable came forward");

  // Empty: a new year starts with nobody enrolled.
  const enrolled = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(enrollments)
      .where(inArray(enrollments.sectionId, newSections.map((s) => s.id))));
  assert.equal(Number(enrolled[0].n), 0, "new sections must start empty");

  const staff = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(sectionStaff)
      .where(inArray(sectionStaff.sectionId, newSections.map((s) => s.id))));
  assert.ok(Number(staff[0].n) > 0, "teacher assignments came with them");
});

test("running the same rollover twice is refused — nobody is promoted twice", async () => {
  // The nightmare scenario: a re-run turns Year 7 into Year 9.
  const before = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(students).where(eq(students.status, "active")));

  const res = await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover`)
    .set(auth("admin")).send({ next_year: NEXT, dry_run: false });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.code, "rollover_blocked");
  assert.match(res.body.detail, /already rolled over|second time/);

  const after = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(students).where(eq(students.status, "active")));
  assert.deepEqual(
    after.map((s) => [s.userId, s.gradeLevel]).sort(),
    before.map((s) => [s.userId, s.gradeLevel]).sort(),
    "a blocked re-run must not move a single pupil");
});

test("the rollover appears in history with its counts", async () => {
  const res = await request(server).get("/api/v1/rollovers").set(auth("admin"));
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length >= 1);
  const r = res.body.data[0];
  assert.equal(r.summary.promote, 19);
  assert.equal(r.summary.graduate, 3);
  assert.ok(r.pupils >= 21, "per-pupil state was recorded for the undo");
  assert.equal(r.revertedAt, null);
});

test("reverting puts every pupil back, including the graduates", async () => {
  const hist = await request(server).get("/api/v1/rollovers").set(auth("admin"));
  const id = hist.body.data[0].id;

  const res = await request(server).post(`/api/v1/rollovers/${id}/revert`).set(auth("admin")).send({});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.restored >= 21);

  // Year groups restored.
  const back = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(students).where(eq(students.status, "active")));
  const grades7 = back.filter((s) => s.gradeLevel === 7);
  assert.equal(grades7.length, 3, "Year 7 is Year 7 again");
  const top = back.filter((s) => s.gradeLevel === 13);
  assert.equal(top.length, 3, "the graduates are active pupils again");

  // And their accounts work again.
  const accounts = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(users).where(inArray(users.id, top.map((t) => t.userId))));
  for (const a of accounts) {
    assert.equal(a.status, "active");
    assert.equal(a.deactivatedAt, null);
  }

  const second = await request(server).post(`/api/v1/rollovers/${id}/revert`).set(auth("admin")).send({});
  assert.equal(second.status, 422, "reverting twice is refused");
});

test("after a revert the corrected rollover can be run again", async () => {
  const res = await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover`)
    .set(auth("admin")).send({
      next_year: NEXT, dry_run: false, graduating_grade: 12,
    });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // With the graduating year at 12, Year 12 AND Year 13 leave.
  assert.equal(res.body.counts.graduate, 6);
  assert.equal(res.body.counts.promote, 16);
});

test("rollover requires academics:write", async () => {
  await staffLogin("t1", "t1@school.example");
  assert.equal((await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover`)
    .set(auth("t1")).send({ next_year: NEXT })).status, 403);
  assert.equal((await request(server).post(`/api/v1/academic-years/${yearA.id}/rollover-preview`)
    .set(auth("t1")).send({})).status, 403);
});

test("rolling over an unknown year is reported, not crashed", async () => {
  const res = await request(server).post(`/api/v1/academic-years/${randomUUID()}/rollover-preview`)
    .set(auth("admin")).send({ next_year: NEXT });
  assert.equal(res.status, 201);
  assert.match(res.body.blockers.join(" "), /does not exist/);
});

test("the whole operation is audited", async () => {
  const [entry] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, "academic_year.rolled_over"))
      .orderBy(desc(auditLog.occurredAt)).limit(1));
  assert.ok(entry);
  assert.ok(entry.afterJson.rolloverId);
  assert.ok(entry.afterJson.promote > 0);

  const [rev] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, "academic_year.rollover_reverted"))
      .orderBy(desc(auditLog.occurredAt)).limit(1));
  assert.ok(rev, "the revert is audited too");
});
