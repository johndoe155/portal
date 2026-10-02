import {
  Body, Controller, ForbiddenException, Inject, NotFoundException, Param, Post, Req,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import {
  users, students, userRoles, identities, courseSections, courses, enrollments,
  guardians, terms, passwordResetTokens,
} from "../db/schema";
import { Perm } from "../common/guards";
import { insertAudit } from "../common/audit";
import { assertCanGrant } from "../common/role-policy";
import { hashPassword, assertPasswordPolicy, PasswordPolicyError } from "../crypto/password";
import { enqueue } from "../notify/notify.service";
import { config } from "../config";
import { ImportBody } from "@portal/contracts";
import type { Request } from "express";

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

type RowResult = { row: number; status: "ok" | "duplicate" | "error"; errors?: string[];
  /** review-6 #3: set-password link for accounts created without a CSV password (dev sink only) */
  set_password_url?: string };

/** review-6 #3: strong generated password — the user replaces it via the emailed link. */
const genTempPassword = () => `Aa1!${randomBytes(12).toString("base64url")}`;
/** review-6 #2: fallback display name when the parents CSV omits guardian_name. */
const nameFromEmail = (email: string) => {
  const local = email.split("@")[0].replace(/[._-]+/g, " ").trim();
  return local.replace(/\b\w/g, (c) => c.toUpperCase()) || email;
};
const IMPORT_RESET_TTL_MS = 24 * 60 * 60 * 1000; // 24 h — longer than the 1 h self-service reset

const STAFF_ROLES = new Set(["teacher", "teacher_assistant", "registrar", "counselor"]);

/**
 * Phase 6: bulk CSV import — the bridge from spreadsheets/SIS exports.
 * Every kind supports dry_run (validate everything, write nothing) and
 * dedupes on the natural key (admission number / email / composite).
 * A commit applies all valid rows in ONE transaction; invalid rows are
 * reported and skipped (never half-import a row).
 */
@Controller()
export class ImportController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  @Post("import/:kind")
  async import(@Req() req: Request, @Param("kind") kind: string, @Body() body: unknown) {
    const parsed = ImportBody.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({ code: "validation", detail: parsed.error.message });
    }
    const p = req.principal!;
    // per-kind capability, same rule the @Perm decorator enforces
    const perm = (kind === "sections" || kind === "enrollments") ? "academics:write" : "directory:write";
    if (!p.perms.includes(perm)) {
      throw new ForbiddenException({ code: "missing_capability", detail: `requires ${perm}` });
    }
    const dryRun = parsed.data.dry_run ?? false;

    const grid = parseCsv(parsed.data.csv);
    if (grid.length < 2) {
      throw new UnprocessableEntityException({ code: "csv_empty", detail: "header + at least one row required" });
    }
    const header = grid[0].map((h) => h.trim().toLowerCase());
    const records = grid.slice(1).map((cells, i) => ({
      rowNum: i + 2,
      get: (name: string) => (cells[header.indexOf(name)] ?? "").trim(),
    }));

    const results: RowResult[] = [];
    let created = 0, duplicates = 0;

    // review-6 #3: the password column is OPTIONAL for students/staff. Rows
    // without one get a generated password + an emailed set-password link
    // (import-then-invite — no plaintext passwords in the school's CSV).
    // review-6 #3b: scrypt is ~100ms/row — every hash is derived HERE, outside
    // the transaction, so a large file never holds locks while hashing.
    // Guardians rows always plan a generated password (account may be created).
    const passwordPlan = new Map<number, { hash?: string; generated: boolean; temp?: string }>();
    if (kind === "students" || kind === "staff" || kind === "guardians") {
      for (const rec of records) {
        const given = kind === "guardians" ? "" : rec.get("password");
        if (given) {
          try { assertPasswordPolicy(given); passwordPlan.set(rec.rowNum, { generated: false }); }
          catch { /* surfaced as a row error inside run() */ }
        } else passwordPlan.set(rec.rowNum, { generated: true });
      }
      if (!dryRun) {
        for (const rec of records) {
          const plan = passwordPlan.get(rec.rowNum);
          if (!plan) continue;
          const pw = plan.generated ? genTempPassword() : rec.get("password");
          if (plan.generated) plan.temp = pw;
          plan.hash = await hashPassword(pw);
        }
      }
    }

    /** create a set-password (reset) token + email; returns the link for the dev sink */
    const issueSetPassword = async (tx: any, userId: string, email: string): Promise<string> => {
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

    const run = async (tx: any) => {
      for (const rec of records) {
        const errors: string[] = [];
        let status: RowResult["status"] = "ok";
        let setPasswordUrl: string | undefined;
        const plan = passwordPlan.get(rec.rowNum);
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
                  const link = await issueSetPassword(tx, user.id, email);
                  if (!process.env.SMTP_URL) setPasswordUrl = link; // dev sink: show once
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
              else assertCanGrant(p.activeRole, [role]);
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
                  const link = await issueSetPassword(tx, user.id, email);
                  if (!process.env.SMTP_URL) setPasswordUrl = link;
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
                const link = await issueSetPassword(tx, guardian.id, guardianEmail);
                if (!process.env.SMTP_URL) setPasswordUrl = link;
              }
              if (!guardian) break; // dry run: account would be created — row counts as valid
              const [dupe] = await tx.select({ id: guardians.id }).from(guardians)
                .where(and(eq(guardians.studentUserId, stu.userId), eq(guardians.userId, guardian.id))).limit(1);
              if (dupe) { status = "duplicate"; break; }
              if (!dryRun) {
                const token = randomBytes(24).toString("base64url");
                await tx.insert(guardians).values({
                  studentUserId: stu.userId, userId: guardian.id, relationship,
                  verifiedAt: null, verifyTokenHash: sha(token), requestedBy: p.userId,
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
                  .where(and(eq(courseSections.courseId, course.id), eq(courseSections.termId, term.id),
                    eq(courseSections.name, name))).limit(1)
                : [undefined];
              if (dupe) { status = "duplicate"; break; }
              if (!dryRun) {
                if (!course) {
                  [course] = await tx.insert(courses)
                    .values({ id: randomUUID(), code, title }).returning();
                }
                await tx.insert(courseSections).values({
                  id: randomUUID(), courseId: course.id, termId: term.id, name,
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
                .where(and(eq(enrollments.studentUserId, stu.userId),
                  eq(enrollments.sectionId, section!.id), eq(enrollments.status, "enrolled"))).limit(1);
              if (dupe) { status = "duplicate"; break; }
              if (!dryRun) {
                await tx.insert(enrollments).values({
                  id: randomUUID(), studentUserId: stu.userId, sectionId: section!.id,
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
    };

    // dry run must not persist — run on a transaction we always roll back by
    // throwing a sentinel; commits run the same code path and persist.
    if (dryRun) {
      try {
        await withActor(this.db, SERVICE, async (tx) => {
          await run(tx);
          throw new Error("__dry_run__");
        });
      } catch (e: any) {
        if (String(e?.message) !== "__dry_run__") throw e;
      }
      created = 0; duplicates = 0;
      for (const r of results) { if (r.status === "ok") created++; if (r.status === "duplicate") duplicates++; }
    } else {
      await withActor(this.db, SERVICE, async (tx) => {
        await run(tx);
        await insertAudit(tx, { actorUserId: p.userId, action: "import.completed",
          entityType: "import", after: { kind, rows: records.length, created,
            duplicates, errors: results.filter((r) => r.status === "error").length }, ip: req.ip });
      });
    }

    return {
      kind, dry_run: dryRun, total: records.length,
      valid: results.filter((r) => r.status === "ok").length,
      duplicates, errors: results.filter((r) => r.status === "error").length,
      ...(dryRun ? { would_create: created } : { created }),
      // review-6 #5: every problem row is listed (no 500 cap). Ok rows are
      // omitted to keep the payload small — EXCEPT ones carrying a set-password
      // link, which the admin must see once. Counts above cover the full file.
      rows: results.filter((r) => r.status !== "ok" || r.set_password_url),
    };
  }
}
