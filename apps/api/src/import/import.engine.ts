import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import {
  users, students, userRoles, identities, courseSections, courses, enrollments,
  guardians, terms, passwordResetTokens,
} from "../db/schema";
import { assertCanGrant } from "../common/role-policy";
import { hashPassword, assertPasswordPolicy, PasswordPolicyError } from "../crypto/password";
import { enqueue } from "../notify/notify.service";
import { config } from "../config";

/**
 * Roster import engine.
 *
 * Extracted from import.controller so the synchronous path (small pastes) and
 * the asynchronous job path (real school files) run byte-for-byte the same
 * logic. Previously the whole CSV went up as one JSON body and was applied in
 * one transaction — which a full-school enrolments file exceeds on both the
 * 1 MB body cap and the ~30 s proxy timeout.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Minimal RFC4180-ish parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export type RowStatus = "ok" | "duplicate" | "error";

export interface RowResult {
  row: number;
  status: RowStatus;
  errors?: string[];
  /** review-6 #3: set-password link for accounts created without a CSV password (dev sink only) */
  set_password_url?: string;
}

export interface CsvRecord {
  rowNum: number;
  get(name: string): string;
}

export const IMPORT_KINDS = ["students", "staff", "guardians", "sections", "enrollments"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const KIND_HEADERS: Record<ImportKind, string[]> = {
  students: ["email", "display_name", "password", "admission_no", "grade_level"],
  staff: ["email", "display_name", "password", "role"],
  guardians: ["student_admission_no", "guardian_email", "relationship", "guardian_name"],
  sections: ["course_code", "course_title", "name", "term_name"],
  enrollments: ["student_admission_no", "course_code", "section_name", "term_name"],
};

/** Columns without which the file is the wrong file, not merely a bad row. */
const REQUIRED_HEADERS: Record<ImportKind, string[]> = {
  students: ["email", "display_name"],
  staff: ["email", "display_name", "role"],
  guardians: ["student_admission_no", "guardian_email", "relationship"],
  sections: ["course_code", "course_title", "name", "term_name"],
  enrollments: ["student_admission_no", "course_code", "section_name", "term_name"],
};

/** review-6 #3: strong generated password — the user replaces it via the emailed link. */
export const genTempPassword = () => `Aa1!${randomBytes(12).toString("base64url")}`;

/** review-6 #2: fallback display name when the parents CSV omits guardian_name. */
export const nameFromEmail = (email: string) => {
  const local = email.split("@")[0].replace(/[._-]+/g, " ").trim();
  return local.replace(/\b\w/g, (c) => c.toUpperCase()) || email;
};

const IMPORT_RESET_TTL_MS = 24 * 60 * 60 * 1000; // 24 h — longer than the 1 h self-service reset
const STAFF_ROLES = new Set(["teacher", "teacher_assistant", "registrar", "counselor"]);

export interface ParsedCsv {
  header: string[];
  records: CsvRecord[];
}

/**
 * Parse and validate the shape of the file BEFORE any row work.
 *
 * Catching a wrong-file-uploaded here matters: on a 6,000-row enrolments file
 * the alternative is 6,000 identical row errors and a confused registrar.
 */
export function parseImportCsv(kind: ImportKind, text: string): ParsedCsv {
  // Strip a UTF-8 BOM — Excel on Windows writes one and it silently corrupts
  // the first header name ("\uFEFFemail" !== "email").
  const clean = text.replace(/^\uFEFF/, "");
  const grid = parseCsv(clean);
  if (grid.length < 2) {
    throw new ImportShapeError("csv_empty", "header + at least one row required");
  }
  const header = grid[0].map((h) => h.trim().toLowerCase().replace(/^\uFEFF/, ""));
  const missing = REQUIRED_HEADERS[kind].filter((h) => !header.includes(h));
  if (missing.length) {
    throw new ImportShapeError(
      "csv_header_mismatch",
      `missing column(s): ${missing.join(", ")}. Expected header for ${kind}: ` +
      `${KIND_HEADERS[kind].join(",")} (found: ${header.join(",") || "nothing"})`,
    );
  }
  const records: CsvRecord[] = grid.slice(1).map((cells, i) => ({
    rowNum: i + 2,
    get: (name: string) => (cells[header.indexOf(name)] ?? "").trim(),
  }));
  return { header, records };
}

export class ImportShapeError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "ImportShapeError"; }
}

export interface PasswordPlan { hash?: string; generated: boolean; temp?: string }

/**
 * Derive password hashes for a batch OUTSIDE any transaction.
 *
 * scrypt is ~100 ms per row by design. Doing this inside the transaction would
 * hold row locks for two minutes on a 1,200-student file.
 */
export async function planPasswords(
  kind: string, records: CsvRecord[], dryRun: boolean,
): Promise<Map<number, PasswordPlan>> {
  const plans = new Map<number, PasswordPlan>();
  if (kind !== "students" && kind !== "staff" && kind !== "guardians") return plans;

  for (const rec of records) {
    const given = kind === "guardians" ? "" : rec.get("password");
    if (given) {
      try { assertPasswordPolicy(given); plans.set(rec.rowNum, { generated: false }); }
      catch { /* surfaced as a row error inside processRows */ }
    } else plans.set(rec.rowNum, { generated: true });
  }
  if (dryRun) return plans;

  for (const rec of records) {
    const plan = plans.get(rec.rowNum);
    if (!plan) continue;
    const pw = plan.generated ? genTempPassword() : rec.get("password");
    if (plan.generated) plan.temp = pw;
    plan.hash = await hashPassword(pw);
  }
  return plans;
}

export interface ProcessContext {
  kind: string;
  dryRun: boolean;
  actorUserId: string;
  actorRole: string;
  /** when false, set-password links are returned so an admin can hand them out */
  smtpConfigured: boolean;
}

export interface BatchOutcome {
  results: RowResult[];
  created: number;
  duplicates: number;
  errors: number;
}

/**
 * Apply one batch of rows inside the caller's transaction.
 *
 * Atomicity note: the synchronous path passes the whole file as one batch, so
 * it is all-or-nothing exactly as before. The async job path commits per batch
 * — a deliberate trade so a 6,000-row file does not hold locks for minutes.
 * That is safe because every kind dedupes on its natural key, so re-running a
 * partially applied file skips what already landed.
 */
export async function processRows(
  tx: any, records: CsvRecord[], plans: Map<number, PasswordPlan>, ctx: ProcessContext,
): Promise<BatchOutcome> {
  const { kind, dryRun } = ctx;
  const results: RowResult[] = [];
  let created = 0, duplicates = 0;

  /** create a set-password (reset) token + email; returns the link for the dev sink */
  const issueSetPassword = async (userId: string): Promise<string> => {
    const token = randomBytes(24).toString("base64url");
    await tx.insert(passwordResetTokens).values({
      id: randomUUID(), userId, tokenHash: sha(token),
      expiresAt: new Date(Date.now() + IMPORT_RESET_TTL_MS),
    });
    const link = `${config.publicWebOrigin}/reset?token=${token}`;
    await enqueue(tx, { recipientUserId: userId, channel: "email",
      kind: "password_reset", payload: { link } });
    return link;
  };

  for (const rec of records) {
    const errors: string[] = [];
    let status: RowStatus = "ok";
    let setPasswordUrl: string | undefined;
    const plan = plans.get(rec.rowNum);
    try {
      switch (kind) {
        case "students": {
          const email = rec.get("email").toLowerCase();
          const name = rec.get("display_name");
          const password = rec.get("password"); // optional — review-6 #3
          const grade = Number(rec.get("grade_level"));
          let admissionNo = rec.get("admission_no").toUpperCase();
          if (!email.includes("@")) errors.push("email invalid");
          if (!name) errors.push("display_name required");
          if (!Number.isInteger(grade) || grade < 1 || grade > 13) errors.push("grade_level 1–13 required");
          if (password) {
            try { assertPasswordPolicy(password); }
            catch (e) { if (e instanceof PasswordPolicyError) errors.push(`password: ${e.detail}`); }
          }
          if (errors.length) break;
          if (admissionNo) {
            const [taken] = await tx.select({ userId: students.userId }).from(students)
              .where(eq(students.admissionNo, admissionNo)).limit(1);
            if (taken) { status = "duplicate"; break; } // dedupe on admission number
          }
          const [emailTaken] = await tx.select({ id: users.id }).from(users)
            .where(eq(sql`lower(${users.email})`, email)).limit(1);
          if (emailTaken) { errors.push("email already registered"); break; }
          if (!dryRun) {
            const [user] = await tx.insert(users).values({
              email, displayName: name, passwordHash: plan!.hash!,
              // review-6 #3: a CSV-supplied password is a temporary secret —
              // the account is locked to /auth until the student changes it
              mustChangePassword: plan!.generated === false,
            }).returning({ id: users.id });
            await tx.insert(identities).values({ userId: user.id, provider: "local", subject: email });
            await tx.insert(userRoles).values({ id: randomUUID(), userId: user.id, roleCode: "student" });
            if (!admissionNo) {
              const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(students);
              admissionNo = `STU-${String(n + 1).padStart(4, "0")}`;
            }
            await tx.insert(students).values({ userId: user.id, admissionNo, gradeLevel: grade });
            if (plan!.generated) {
              const link = await issueSetPassword(user.id);
              if (!ctx.smtpConfigured) setPasswordUrl = link; // dev sink: show once
            }
          }
          created++;
          break;
        }
        case "staff": {
          const email = rec.get("email").toLowerCase();
          const name = rec.get("display_name");
          const password = rec.get("password"); // optional — review-6 #3
          const role = rec.get("role");
          if (!email.includes("@")) errors.push("email invalid");
          if (!name) errors.push("display_name required");
          if (!STAFF_ROLES.has(role)) errors.push(`role must be one of ${[...STAFF_ROLES].join(", ")}`);
          else assertCanGrant(ctx.actorRole, [role]);
          if (password) {
            try { assertPasswordPolicy(password); }
            catch (e) { if (e instanceof PasswordPolicyError) errors.push(`password: ${e.detail}`); }
          }
          if (errors.length) break;
          const [emailTaken] = await tx.select({ id: users.id }).from(users)
            .where(eq(sql`lower(${users.email})`, email)).limit(1);
          if (emailTaken) { status = "duplicate"; break; } // dedupe on email
          if (!dryRun) {
            const [user] = await tx.insert(users).values({
              email, displayName: name, passwordHash: plan!.hash!,
              mustChangePassword: plan!.generated === false, // review-6 #3
            }).returning({ id: users.id });
            await tx.insert(identities).values({ userId: user.id, provider: "local", subject: email });
            await tx.insert(userRoles).values({ id: randomUUID(), userId: user.id, roleCode: role });
            if (plan!.generated) {
              const link = await issueSetPassword(user.id);
              if (!ctx.smtpConfigured) setPasswordUrl = link;
            }
          }
          created++;
          break;
        }
        case "guardians": {
          const admissionNo = rec.get("student_admission_no").toUpperCase();
          const guardianEmail = rec.get("guardian_email").toLowerCase();
          const relationship = rec.get("relationship");
          if (!admissionNo) errors.push("student_admission_no required");
          if (!guardianEmail.includes("@")) errors.push("guardian_email invalid");
          if (!relationship) errors.push("relationship required");
          if (errors.length) break;
          const [stu] = await tx.select({ userId: students.userId }).from(students)
            .where(eq(students.admissionNo, admissionNo)).limit(1);
          if (!stu) { errors.push("no student with that admission number"); break; }
          let [guardian] = await tx.select({ id: users.id, displayName: users.displayName }).from(users)
            .where(and(eq(sql`lower(${users.email})`, guardianEmail),
              eq(users.status, "active"))).limit(1);
          if (!guardian && !dryRun) {
            // review-6 #2: bulk parent onboarding — create the account here
            // (generated password + emailed set-password link, 24 h) instead
            // of forcing one-at-a-time invites. The guardian link below stays
            // PENDING until the parent verifies, exactly like the UI path.
            const gname = rec.get("guardian_name") || nameFromEmail(guardianEmail);
            [guardian] = await tx.insert(users).values({
              email: guardianEmail, displayName: gname, passwordHash: plan!.hash!,
            }).returning({ id: users.id, displayName: users.displayName });
            await tx.insert(identities).values({ userId: guardian.id, provider: "local", subject: guardianEmail });
            await tx.insert(userRoles).values({ id: randomUUID(), userId: guardian.id, roleCode: "parent" });
            const link = await issueSetPassword(guardian.id);
            if (!ctx.smtpConfigured) setPasswordUrl = link;
          }
          if (!guardian) break; // dry run: account would be created — row counts as valid
          const [dupe] = await tx.select({ id: guardians.id }).from(guardians)
            .where(and(eq(guardians.studentUserId, stu.userId), eq(guardians.userId, guardian.id))).limit(1);
          if (dupe) { status = "duplicate"; break; }
          if (!dryRun) {
            const token = randomBytes(24).toString("base64url");
            await tx.insert(guardians).values({
              studentUserId: stu.userId, userId: guardian.id, relationship,
              verifiedAt: null, verifyTokenHash: sha(token), requestedBy: ctx.actorUserId,
            });
            await enqueue(tx, { recipientEmail: guardianEmail, channel: "email",
              kind: "guardian_verify",
              payload: { display_name: guardian.displayName,
                verifyUrl: `${config.publicWebOrigin}/parent/verify?token=${token}` } });
          }
          created++;
          break;
        }
        case "sections": {
          const code = rec.get("course_code").toUpperCase();
          const title = rec.get("course_title");
          const name = rec.get("name");
          const termName = rec.get("term_name");
          if (!code) errors.push("course_code required");
          if (!title) errors.push("course_title required");
          if (!name) errors.push("name required");
          const [term] = await tx.select({ id: terms.id }).from(terms)
            .where(eq(terms.name, termName)).limit(1);
          if (!term) errors.push(`no term named '${termName}'`);
          if (errors.length) break;
          let [course] = await tx.select().from(courses).where(eq(courses.code, code)).limit(1);
          const [dupe] = course
            ? await tx.select({ id: courseSections.id }).from(courseSections)
              .where(and(eq(courseSections.courseId, course.id), eq(courseSections.termId, term!.id),
                eq(courseSections.name, name))).limit(1)
            : [undefined];
          if (dupe) { status = "duplicate"; break; }
          if (!dryRun) {
            if (!course) {
              [course] = await tx.insert(courses)
                .values({ id: randomUUID(), code, title }).returning();
            }
            await tx.insert(courseSections).values({
              id: randomUUID(), courseId: course.id, termId: term!.id, name,
            });
          }
          created++;
          break;
        }
        case "enrollments": {
          const admissionNo = rec.get("student_admission_no").toUpperCase();
          const code = rec.get("course_code").toUpperCase();
          const sectionName = rec.get("section_name");
          const termName = rec.get("term_name");
          if (!admissionNo) errors.push("student_admission_no required");
          const [stu] = await tx.select({ userId: students.userId }).from(students)
            .where(eq(students.admissionNo, admissionNo)).limit(1);
          if (!stu) errors.push("no student with that admission number");
          const [term] = await tx.select({ id: terms.id }).from(terms)
            .where(eq(terms.name, termName)).limit(1);
          if (!term) errors.push(`no term named '${termName}'`);
          let section;
          if (term) {
            [section] = await tx.select({ id: courseSections.id }).from(courseSections)
              .innerJoin(courses, eq(courses.id, courseSections.courseId))
              .where(and(eq(courseSections.termId, term.id), eq(courseSections.name, sectionName),
                eq(courses.code, code))).limit(1);
            if (!section) errors.push(`no section '${sectionName}' for ${code} in ${termName}`);
          }
          if (errors.length) break;
          const [dupe] = await tx.select({ id: enrollments.id }).from(enrollments)
            .where(and(eq(enrollments.studentUserId, stu!.userId),
              eq(enrollments.sectionId, section!.id), eq(enrollments.status, "enrolled"))).limit(1);
          if (dupe) { status = "duplicate"; break; }
          if (!dryRun) {
            await tx.insert(enrollments).values({
              id: randomUUID(), studentUserId: stu!.userId, sectionId: section!.id,
            });
          }
          created++;
          break;
        }
        default:
          throw new NotFoundException({ code: "unknown_import_kind",
            detail: "students | staff | guardians | sections | enrollments" });
      }
    } catch (e: any) {
      if (e?.response?.code === "role_above_your_tier") errors.push(e.response.title ?? "role above your tier");
      else if (e instanceof NotFoundException) throw e;
      else errors.push(String(e?.message ?? e).slice(0, 120));
    }
    if (errors.length) status = "error";
    if (status === "duplicate") duplicates++;
    results.push({ row: rec.rowNum, status, ...(errors.length ? { errors } : {}),
      ...(setPasswordUrl ? { set_password_url: setPasswordUrl } : {}) });
  }

  return {
    results, created, duplicates,
    errors: results.filter((r) => r.status === "error").length,
  };
}

/** CSV escaping for the downloadable error report. */
export function toCsvRow(cells: (string | number)[]): string {
  return cells.map((c) => {
    const s = String(c ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",") + "\r\n";
}
