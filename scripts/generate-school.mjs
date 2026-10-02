/**
 * Generate a realistic, school-sized roster so the import path is proven
 * BEFORE the school's real file arrives.
 *
 *   node scripts/generate-school.mjs [outdir] [--students=1200] [--staff=80]
 *
 * Produces the five CSVs in the order they must be imported:
 *   1-students.csv  2-staff.csv  3-sections.csv  4-enrollments.csv  5-guardians.csv
 *
 * Defaults model a typical secondary school: 1,200 students across years 7–13,
 * 80 staff, ~1.6 guardians per child, 8 subjects each → ~9,600 enrolments.
 * That enrolments file alone is several megabytes — comfortably past the 1 MB
 * JSON body cap the old import used, which is precisely the point.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const outdir = args.find((a) => !a.startsWith("--")) ?? "./data/sample-school";
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : dflt;
};

const STUDENTS = opt("students", 1200);
const STAFF = opt("staff", 80);
const SUBJECTS_PER_STUDENT = opt("subjects", 8);
const TERM = args.find((a) => a.startsWith("--term="))?.split("=")[1] ?? "Term 1";
const DOMAIN = args.find((a) => a.startsWith("--domain="))?.split("=")[1] ?? "school.example";

/* Nigerian and international names, so the sample looks like a real register
   rather than user1..user1200 — it also exercises non-ASCII and apostrophes. */
const FIRST = [
  "Amara", "Chidi", "Ngozi", "Emeka", "Folake", "Tunde", "Zainab", "Yusuf", "Ifeoma", "Obi",
  "Aisha", "Kelechi", "Bolanle", "Segun", "Hauwa", "Chinedu", "Temitope", "Musa", "Adaeze", "Bisi",
  "Oluwaseun", "Fatima", "Chiamaka", "Ibrahim", "Nneka", "Abiodun", "Halima", "Uche", "Yewande", "Sani",
  "Grace", "Daniel", "Sarah", "Michael", "Esther", "David", "Blessing", "Samuel", "Joy", "Peter",
];
const LAST = [
  "Okafor", "Adeyemi", "Balogun", "Eze", "Mohammed", "Okonkwo", "Afolabi", "Nwosu", "Bello", "Chukwu",
  "Danjuma", "Oyelaran", "Ibrahim", "Nnamdi", "Oluwole", "Abubakar", "Onyeka", "Adewale", "Umeh", "Garba",
  "O'Brien", "Smith", "Olatunji", "Ekwueme", "Lawal", "Nwachukwu", "Ojo", "Suleiman", "Anyanwu", "Idris",
];

const SUBJECTS = [
  ["MTH", "Mathematics"], ["ENG", "English Language"], ["PHY", "Physics"],
  ["CHM", "Chemistry"], ["BIO", "Biology"], ["GEO", "Geography"],
  ["HIS", "History"], ["ECO", "Economics"], ["CSC", "Computer Science"],
  ["LIT", "Literature"], ["FRN", "French"], ["AGR", "Agricultural Science"],
];
const STAFF_ROLES = ["teacher", "teacher", "teacher", "teacher", "teacher_assistant", "registrar", "counselor"];
const RELATIONSHIPS = ["mother", "father", "guardian", "grandmother", "uncle"];

/* Deterministic PRNG so repeated runs produce the same school — a flaky
   fixture would make a performance regression impossible to spot. */
let seed = opt("seed", 20261002);
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (cells) => cells.map(csvCell).join(",");

mkdirSync(outdir, { recursive: true });

/* ── students ──────────────────────────────────────────────────────────── */
const students = [];
const seenEmail = new Set();
for (let i = 0; i < STUDENTS; i++) {
  const first = pick(FIRST), last = pick(LAST);
  const grade = 7 + (i % 7);                    // years 7–13, evenly spread
  const admissionNo = `GHS-${String(2020 + (13 - grade)).slice(2)}-${String(i + 1).padStart(4, "0")}`;
  let local = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "");
  let email = `${local}@${DOMAIN}`;
  let n = 1;
  while (seenEmail.has(email)) email = `${local}${++n}@${DOMAIN}`;
  seenEmail.add(email);
  students.push({ email, name: `${first} ${last}`, admissionNo, grade });
}
writeFileSync(join(outdir, "1-students.csv"),
  // password column left blank on purpose: each student gets an emailed
  // set-password link, so no plaintext credentials sit in the school's CSV.
  row(["email", "display_name", "password", "admission_no", "grade_level"]) + "\n" +
  students.map((s) => row([s.email, s.name, "", s.admissionNo, s.grade])).join("\n") + "\n");

/* ── staff ─────────────────────────────────────────────────────────────── */
const staff = [];
for (let i = 0; i < STAFF; i++) {
  const first = pick(FIRST), last = pick(LAST);
  let local = `${first[0]}.${last}`.toLowerCase().replace(/[^a-z.]/g, "");
  let email = `${local}@${DOMAIN}`;
  let n = 1;
  while (seenEmail.has(email)) email = `${local}${++n}@${DOMAIN}`;
  seenEmail.add(email);
  staff.push({ email, name: `${first} ${last}`, role: i === 0 ? "registrar" : pick(STAFF_ROLES) });
}
writeFileSync(join(outdir, "2-staff.csv"),
  row(["email", "display_name", "password", "role"]) + "\n" +
  staff.map((s) => row([s.email, s.name, "", s.role])).join("\n") + "\n");

/* ── sections: one per subject per year group ──────────────────────────── */
const sections = [];
for (const [code, title] of SUBJECTS) {
  for (let grade = 7; grade <= 13; grade++) {
    for (const stream of ["A", "B"]) {
      sections.push({ code, title, name: `Y${grade}-${code}-${stream}`, grade, term: TERM });
    }
  }
}
writeFileSync(join(outdir, "3-sections.csv"),
  row(["course_code", "course_title", "name", "term_name"]) + "\n" +
  sections.map((s) => row([s.code, s.title, s.name, s.term])).join("\n") + "\n");

/* ── enrolments: each student takes N subjects in their own year group ─── */
const enrollments = [];
for (const s of students) {
  const forYear = sections.filter((x) => x.grade === s.grade);
  const chosen = new Set();
  while (chosen.size < Math.min(SUBJECTS_PER_STUDENT, SUBJECTS.length)) {
    chosen.add(pick(forYear.map((x) => x.code)));
  }
  for (const code of chosen) {
    const opts = forYear.filter((x) => x.code === code);
    const sec = opts[int(0, opts.length - 1)];
    enrollments.push([s.admissionNo, code, sec.name, TERM]);
  }
}
writeFileSync(join(outdir, "4-enrollments.csv"),
  row(["student_admission_no", "course_code", "section_name", "term_name"]) + "\n" +
  enrollments.map(row).join("\n") + "\n");

/* ── guardians: 1–2 per child, siblings deliberately share a parent ────── */
const guardians = [];
for (let i = 0; i < students.length; i++) {
  const s = students[i];
  const count = rnd() < 0.6 ? 2 : 1;
  for (let g = 0; g < count; g++) {
    // ~8% of guardians are shared with the previous student (siblings), which
    // exercises the "account already exists, add a second link" path.
    const sibling = g === 0 && i > 0 && rnd() < 0.08;
    const src = sibling ? students[i - 1] : s;
    const last = src.name.split(" ").slice(-1)[0];
    const first = pick(FIRST);
    const email = `${first}.${last}.${sibling ? i - 1 : i}${g}`.toLowerCase().replace(/[^a-z.0-9]/g, "")
      + `@parents.${DOMAIN}`;
    guardians.push([s.admissionNo, email, pick(RELATIONSHIPS), `${first} ${last}`]);
  }
}
writeFileSync(join(outdir, "5-guardians.csv"),
  row(["student_admission_no", "guardian_email", "relationship", "guardian_name"]) + "\n" +
  guardians.map(row).join("\n") + "\n");

/* ── report ────────────────────────────────────────────────────────────── */
const { statSync } = await import("node:fs");
const files = ["1-students.csv", "2-staff.csv", "3-sections.csv", "4-enrollments.csv", "5-guardians.csv"];
console.log(`Sample school written to ${outdir}\n`);
console.log("file".padEnd(22) + "rows".padStart(8) + "size".padStart(12));
console.log("-".repeat(42));
const counts = [students.length, staff.length, sections.length, enrollments.length, guardians.length];
let totalBytes = 0;
files.forEach((f, i) => {
  const bytes = statSync(join(outdir, f)).size;
  totalBytes += bytes;
  const over = bytes > 1024 * 1024 ? "  ← over the 1 MB JSON cap" : "";
  console.log(f.padEnd(22) + String(counts[i]).padStart(8) +
    `${(bytes / 1024).toFixed(0)} KB`.padStart(12) + over);
});
console.log("-".repeat(42));
console.log("total".padEnd(22) + String(counts.reduce((a, b) => a + b)).padStart(8) +
  `${(totalBytes / 1024 / 1024).toFixed(2)} MB`.padStart(12));
console.log(`\nImport in numbered order at /admin/import (term "${TERM}" must exist first).`);
