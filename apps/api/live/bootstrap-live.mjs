/**
 * Phase 6 headline proof: bootstrap a REAL school from an EMPTY database.
 * No SEED_DEMO, no demo users — one bootstrap admin, then the whole school
 * (identity, calendar, students, guardians, classes, fees) via the admin API
 * and the CSV importer. Run against the live API on :8080 with:
 *   BOOTSTRAP_ADMIN_EMAIL/PASSWORD set, SEED_DEMO unset.
 * Usage: node apps/api/live/bootstrap-live.mjs
 */
import { execFileSync } from "node:child_process";

const API = process.env.API_BASE ?? "http://127.0.0.1:8080";
const ADMIN_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "bootstrap@school.example";
const ADMIN_PW = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "Passw0rd!Policy1";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? (pass++, console.log("PASS", name)) : (fail++, console.log("FAIL", name, extra)); };

const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function call(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  const ck = cookieHeader(); if (ck) headers.cookie = ck;
  if (opts.body) headers["content-type"] = "application/json";
  if (jar.has("csrf")) headers["x-csrf"] = jar.get("csrf");
  const res = await fetch(API + path, { ...opts, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";"); const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const { totpCode } = await import("../dist/crypto/totp.js");

/* ── 0. the login page is the school's before anyone authenticates ─────── */
const anonSchool = await call("/api/v1/school");
ok("GET /school is public on an empty DB", anonSchool.status === 200 && anonSchool.body.name === "School Portal", JSON.stringify(anonSchool.body).slice(0, 120));

/* ── 1. bootstrap admin: password login, then the ops-CLI enroll token ─── */
const login = await call("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PW }) });
ok("bootstrap admin login (fresh DB, no demo)", login.status === 201 && login.body.mfaRequired === true && jar.has("sid"), JSON.stringify(login.body).slice(0, 120));

const enrollToken = execFileSync("node", ["scripts/mfa-token.mjs", ADMIN_EMAIL],
  { env: { ...process.env, DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/portal" }, encoding: "utf8" }).trim().split("\n").pop();
const enroll = await call("/api/v1/auth/mfa/totp/enroll", { method: "POST", body: JSON.stringify({ token: enrollToken }) });
ok("TOTP enroll via ops-CLI token", enroll.status === 201 && !!enroll.body.secret, JSON.stringify(enroll.body).slice(0, 120));
const verify = await call("/api/v1/auth/mfa/totp/verify", { method: "POST", body: JSON.stringify({ code: totpCode(enroll.body.secret) }) });
ok("TOTP verify", verify.status === 201 && verify.body.mfaVerified === true, JSON.stringify(verify.body).slice(0, 120));

/* ── 2. school identity ────────────────────────────────────────────────── */
const put = await call("/api/v1/school", { method: "PUT", body: JSON.stringify({
  name: "Bright Future Academy", contact_email: "office@brightfuture.example",
  dpo_email: "dpo@brightfuture.example", timezone: "Africa/Lagos", currency: "NGN",
  mail_sender: "portal@brightfuture.example",
}) });
ok("PUT /school", put.status === 200 && put.body.ok === true, JSON.stringify(put.body).slice(0, 120));
const pub = await call("/api/v1/school");
ok("public GET /school reflects settings", pub.body.name === "Bright Future Academy");

/* ── 3. calendar: year + term ──────────────────────────────────────────── */
const year = await call("/api/v1/academic-years", { method: "POST", body: JSON.stringify({
  name: "2026/2027", start_date: "2026-09-07", end_date: "2027-07-30", make_current: true }) });
ok("create academic year", year.status === 201 && year.body.isCurrent === true, JSON.stringify(year.body).slice(0, 120));
const term = await call("/api/v1/terms", { method: "POST", body: JSON.stringify({
  academic_year_id: year.body.id, term_no: 1, name: "First Term" }) });
ok("create term", term.status === 201, JSON.stringify(term.body).slice(0, 120));

/* ── 4. the school arrives as CSV: dry run, then commit ────────────────── */
// review-6 #3: no plaintext passwords in the school's CSV — every student
// gets an emailed set-password link instead
const studentsCsv = [
  "email,display_name,password,admission_no,grade_level",
  "amina@brightfuture.example,Amina Bello,,BFA-0001,10",
  "chidi@brightfuture.example,Chidi Okafor,,BFA-0002,10",
  "fatima@brightfuture.example,Fatima Yusuf,,BFA-0003,11",
  "emeka@brightfuture.example,Emeka Nwosu,,BFA-0004,11",
  "zainab@brightfuture.example,Zainab Aliyu,,BFA-0005,12",
].join("\n");
const dry = await call("/api/v1/import/students", { method: "POST", body: JSON.stringify({ csv: studentsCsv, dry_run: true }) });
ok("students dry run: 5 would create, 0 errors", dry.status === 201 && dry.body.would_create === 5 && dry.body.errors === 0, JSON.stringify(dry.body).slice(0, 160));
const commit = await call("/api/v1/import/students", { method: "POST", body: JSON.stringify({ csv: studentsCsv }) });
ok("students commit: 5 created", commit.status === 201 && commit.body.created === 5, JSON.stringify(commit.body).slice(0, 160));
const stuLinks = commit.body.rows.filter((r) => r.set_password_url);
ok("every password-less student got a set-password link", stuLinks.length === 5, `got ${stuLinks.length}`);
const again = await call("/api/v1/import/students", { method: "POST", body: JSON.stringify({ csv: studentsCsv }) });
ok("re-commit dedupes: 5 duplicate, 0 created", again.body.duplicates === 5 && again.body.created === 0, JSON.stringify(again.body).slice(0, 160));

const badCsv = [
  "email,display_name,password,admission_no,grade_level",
  "not-an-email,Bad Row,short,BFA-9999,10",
  "good@brightfuture.example,Good Row,Passw0rd!Policy1,BFA-9998,10",
].join("\n");
const bad = await call("/api/v1/import/students", { method: "POST", body: JSON.stringify({ csv: badCsv, dry_run: true }) });
ok("bad row reported, nothing written on dry run", bad.body.errors === 1 && bad.body.would_create === 1 && bad.body.rows[0].status === "error", JSON.stringify(bad.body).slice(0, 200));

const staffCsv = [
  "email,display_name,password,role",
  "tunde@brightfuture.example,Tunde Bakare,,teacher",
].join("\n");
const staff = await call("/api/v1/import/staff", { method: "POST", body: JSON.stringify({ csv: staffCsv }) });
ok("staff commit (no password column)", staff.status === 201 && staff.body.created === 1, JSON.stringify(staff.body).slice(0, 160));
const teacherLink = staff.body.rows.find((r) => r.set_password_url)?.set_password_url;
ok("teacher got a set-password link", !!teacherLink);
await call("/api/v1/auth/password/reset", { method: "POST", body: JSON.stringify({
  token: teacherLink.split("token=").pop(), password: "Teach!Passw0rd9" }) });
// (separate jar — must not clobber the admin session)
const tjar = new Map();
const tcall = async (path, opts = {}) => {
  const headers = { ...(opts.headers ?? {}) };
  const ck = [...tjar].map(([k, v]) => `${k}=${v}`).join("; "); if (ck) headers.cookie = ck;
  if (opts.body) headers["content-type"] = "application/json";
  if (tjar.has("csrf")) headers["x-csrf"] = tjar.get("csrf");
  const res = await fetch(API + path, { ...opts, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";"); const i = pair.indexOf("=");
    tjar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const teacherLogin = await tcall("/api/v1/auth/login", { method: "POST", body: JSON.stringify({
  email: "tunde@brightfuture.example", password: "Teach!Passw0rd9" }) });
ok("teacher logs in with self-chosen password (no forced change)",
  teacherLogin.status === 201 && teacherLogin.body.mustChangePassword !== true && teacherLogin.body.mfaRequired === true,
  JSON.stringify(teacherLogin.body).slice(0, 160));

const sectionsCsv = [
  "course_code,course_title,name,term_name",
  "MTH-101,Mathematics,Mathematics 10A,First Term",
].join("\n");
const sections = await call("/api/v1/import/sections", { method: "POST", body: JSON.stringify({ csv: sectionsCsv }) });
ok("sections commit", sections.status === 201 && sections.body.created === 1, JSON.stringify(sections.body).slice(0, 160));

const enrolCsv = [
  "student_admission_no,course_code,section_name,term_name",
  "BFA-0001,MTH-101,Mathematics 10A,First Term",
  "BFA-0002,MTH-101,Mathematics 10A,First Term",
].join("\n");
const enrol = await call("/api/v1/import/enrollments", { method: "POST", body: JSON.stringify({ csv: enrolCsv }) });
ok("enrollments commit", enrol.status === 201 && enrol.body.created === 2, JSON.stringify(enrol.body).slice(0, 160));

/* ── 5. guardians: accounts, links, verify + confirm paths ─────────────── */
const g1 = await call("/api/v1/users", { method: "POST", body: JSON.stringify({
  email: "mama.amina@brightfuture.example", display_name: "Hauwa Bello", password: "Passw0rd!Policy1", roles: ["parent"] }) });
const g2 = await call("/api/v1/users", { method: "POST", body: JSON.stringify({
  email: "papa.chidi@brightfuture.example", display_name: "Obinna Okafor", password: "Passw0rd!Policy1", roles: ["parent"] }) });
ok("guardian accounts created", g1.status === 201 && g2.status === 201, `${g1.status} ${g2.status}`);

const list = await call("/api/v1/students?per=100");
const amina = list.body.data.find((s) => s.admissionNo === "BFA-0001");
ok("GET /students lists imported student", !!amina, JSON.stringify(list.body).slice(0, 160));

const link1 = await call(`/api/v1/students/${amina.userId}/guardians`, { method: "POST", body: JSON.stringify({
  guardian_email: "mama.amina@brightfuture.example", relationship: "mother" }) });
ok("guardian link created (emailed-token path)", link1.status === 201 && !!link1.body.verifyUrl, JSON.stringify(link1.body).slice(0, 160));
const links1 = await call(`/api/v1/students/${amina.userId}/guardians`);
ok("GET /students/:id/guardians shows pending", links1.body.data.length === 1 && !links1.body.data[0].verifiedAt, JSON.stringify(links1.body.data).slice(0, 200));

/* office-confirm path for the second family */
const chidi = list.body.data.find((s) => s.admissionNo === "BFA-0002");
await call(`/api/v1/students/${chidi.userId}/guardians`, { method: "POST", body: JSON.stringify({
  guardian_email: "papa.chidi@brightfuture.example", relationship: "father" }) });
const links2 = await call(`/api/v1/students/${chidi.userId}/guardians`);
const gid = links2.body.data[0].id;
const confirm = await call(`/api/v1/guardian-links/${gid}/confirm`, { method: "POST" });
ok("admin confirms guardian link (office path)", confirm.status === 200 || confirm.status === 201, JSON.stringify(confirm.body).slice(0, 120));

/* ── 5b. review-6 #2: bulk parent import — accounts auto-created ───────── */
const parentsCsv = [
  "student_admission_no,guardian_email,relationship,guardian_name",
  "BFA-0003,yusuf.mum@brightfuture.example,mother,Mrs Yusuf",
  "BFA-0004,nwosu.dad@brightfuture.example,father,Mr Nwosu",
  "BFA-0005,aliyu.mum@brightfuture.example,mother,Mrs Aliyu",
].join("\n");
const parents = await call("/api/v1/import/guardians", { method: "POST", body: JSON.stringify({ csv: parentsCsv }) });
ok("bulk parent import: 3 accounts + links created", parents.status === 201 && parents.body.created === 3, JSON.stringify(parents.body).slice(0, 200));
ok("each new parent got a set-password link", parents.body.rows.filter((r) => r.set_password_url).length === 3);
// office confirms the three bulk links
for (const adm of ["BFA-0003", "BFA-0004", "BFA-0005"]) {
  const stu = list.body.data.find((x) => x.admissionNo === adm);
  const ls = await call(`/api/v1/students/${stu.userId}/guardians`);
  await call(`/api/v1/guardian-links/${ls.body.data[0].id}/confirm`, { method: "POST" });
}
ok("office confirmed the 3 bulk guardian links", true);

/* ── 6. parent experiences it end-to-end (students have no MFA) ────────── */
const pjar = new Map();
const pcall = async (path, opts = {}) => {
  const headers = { ...(opts.headers ?? {}) };
  const ck = [...pjar].map(([k, v]) => `${k}=${v}`).join("; "); if (ck) headers.cookie = ck;
  if (opts.body) headers["content-type"] = "application/json";
  if (pjar.has("csrf")) headers["x-csrf"] = pjar.get("csrf");
  const res = await fetch(API + path, { ...opts, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";"); const i = pair.indexOf("=");
    pjar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
await pcall("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email: "mama.amina@brightfuture.example", password: "Passw0rd!Policy1" }) });
const kids0 = await pcall("/api/v1/parent/children");
ok("parent sees child as PENDING before verification", kids0.body.data?.length === 1 && kids0.body.data[0].verified === null, JSON.stringify(kids0.body).slice(0, 200));
const token = link1.body.verifyUrl?.split("token=").pop();
const selfVerify = await pcall("/api/v1/family/guardian-verify", { method: "POST", body: JSON.stringify({ token }) });
ok("parent self-verifies via emailed token", selfVerify.status === 201, JSON.stringify(selfVerify.body).slice(0, 160));
const kids1 = await pcall("/api/v1/parent/children");
ok("child now verified for parent", !!kids1.body.data?.[0]?.verified, JSON.stringify(kids1.body).slice(0, 200));

/* ── 7. fees from a template ───────────────────────────────────────────── */
const tpl = await call("/api/v1/fees/templates", { method: "POST", body: JSON.stringify({
  name: "First Term Tuition", amount_kobo: 1200000, grade_level: 10, due_days: 21 }) });
ok("fee template created", tpl.status === 201, JSON.stringify(tpl.body).slice(0, 120));
const gen = await call(`/api/v1/fees/templates/${tpl.body.id}/generate`, { method: "POST", body: JSON.stringify({ term_id: term.body.id }) });
ok("generate invoices for the grade scope", gen.status === 201 && gen.body.created === 2, JSON.stringify(gen.body).slice(0, 160));
const gen2 = await call(`/api/v1/fees/templates/${tpl.body.id}/generate`, { method: "POST", body: JSON.stringify({ term_id: term.body.id }) });
ok("re-generate creates nothing", gen2.body.created === 0 && gen2.body.skipped === 2, JSON.stringify(gen2.body).slice(0, 120));

/* ── 8. reconciliation sees the whole school ───────────────────────────── */
const rec = await call("/api/v1/reports/reconciliation");
ok("reconciliation: head-count 2 for Mathematics 10A", rec.body.sections.some((s) => s.head_count === 2 && s.name === "Mathematics 10A"), JSON.stringify(rec.body.sections).slice(0, 200));
ok("reconciliation: verified guardians not flagged", !rec.body.parents_without_children.some((p) => p.email === "mama.amina@brightfuture.example"), JSON.stringify(rec.body.parents_without_children).slice(0, 200));
ok("reconciliation: no pending guardian links left", rec.body.pending_guardian_links === 0, `pending: ${rec.body.pending_guardian_links}`);

/* ── 9. invited student lands WITH a students row ──────────────────────── */
const inv = await call("/api/v1/invites", { method: "POST", body: JSON.stringify({
  email: "blessing@brightfuture.example", display_name: "Blessing Danladi", roles: ["student"], grade_level: 10 }) });
ok("invite student (grade carried)", inv.status === 201 && !!inv.body.inviteToken, JSON.stringify(inv.body).slice(0, 160));
const itoken = inv.body.inviteToken;
const accept = await call("/api/v1/auth/invite/accept", { method: "POST", body: JSON.stringify({
  token: itoken, password: "Passw0rd!Policy1" }) });
ok("accept invite", accept.status === 201, JSON.stringify(accept.body).slice(0, 160));
const blessing = await call("/api/v1/students?q=Blessing");
ok("invited student has a students row + auto admission no",
  blessing.body.data.length === 1 && /^STU-\d+$/.test(blessing.body.data[0].admissionNo) && blessing.body.data[0].gradeLevel === 10,
  JSON.stringify(blessing.body.data).slice(0, 200));

/* ── 10. grading scale ─────────────────────────────────────────────────── */
const grade = await call("/api/v1/grading-config", { method: "PUT", body: JSON.stringify({
  scale: [
    { letter: "F", min_pct: 0, point: 0 },
    { letter: "A", min_pct: 75, point: 5 },
    { letter: "B", min_pct: 65, point: 4 },
    { letter: "C", min_pct: 55, point: 3 },
  ],
  weights: { exam: 60, coursework: 40 },
}) });
ok("grading config saved (sorted desc)", grade.status === 200 && grade.body.scale.map((x) => x.letter).join("") === "ABCF", JSON.stringify(grade.body).slice(0, 160));

console.log(`\nbootstrap-live: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
