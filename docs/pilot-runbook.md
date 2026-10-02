# Pilot Runbook — taking one real school live

**Audience:** the operator taking a single school onto the portal.
**Proven by:** `apps/api/live/bootstrap-live.mjs` (32 checks, run against an empty database with no demo seed — every step below mirrors a PASS line in that script).

## 0. Provisioning (once, per ADR-010)
- Web (Vercel, `dub1`), API + worker containers (Railway/Render), Postgres (Supabase/Neon, eu-west-1), R2 for backups.
- Set: `DATABASE_URL`, `APP_SECRET` (≥32 chars), `PUBLIC_WEB_ORIGIN`, `COOKIE_SECURE=true`, `TRUST_PROXY=2`, `PAYSTACK_SECRET_KEY`, and for email `SMTP_URL` (until then links are shown to admins instead of mailed).
- **Never** set `SEED_DEMO=true` in production — the API refuses to boot with it.

## 1. Bootstrap the first admin
1. Start the API once with `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` (≥12 chars, mixed classes). A `super_admin` account is created and audited (`auth.bootstrap_admin`); the env vars can then be removed.
2. Issue their MFA enrollment token out-of-band:
   `DATABASE_URL=… node scripts/mfa-token.mjs admin@school.ng` (single-use, 24 h).
3. The admin signs in at `/login`, then enrolls TOTP with that token (QR or manual key) and verifies.

## 2. School identity — `/admin/school`
Name, logo URL, colours, contact + DPO email, timezone, currency, mail sender.
The login page, navigation and legal pages pick this up immediately (the endpoint is public before authentication).

## 3. Calendar — `/admin/academics`
Create the academic year (mark current) and its terms. Terms drive fee generation and reporting.

## 4. Roster import — `/admin/import`
Order matters; each kind has its own CSV header (shown on the page):
1. **Students** — `email,display_name,password,admission_no,grade_level`. The `password` column is **optional — leave it blank**: each student receives an emailed link to choose their own password (no plaintext in your CSV). A supplied password is treated as temporary: the account is locked to the password-change screen until they replace it.
2. **Staff** — `email,display_name,password,role` (`teacher`, `teacher_assistant`, `registrar`, …). Same password rules as students.
3. **Classes** — `course_code,course_title,name,term_name`.
4. **Enrolments** — `student_admission_no,course_code,section_name,term_name`.
5. **Parents + guardian links** — `student_admission_no,guardian_email,relationship,guardian_name`. Parent accounts are **created automatically** when the email is unknown (with their own set-password link), so the whole parent body imports in one file; the link stays pending until verified.

Without an SMTP server configured, set-password links are listed in the import result instead of emailed — copy them out immediately; they are shown once and expire after 24 h.

**Always dry-run first.** The dry run reports per-row errors (bad email, weak supplied password, grade out of 1–13, duplicate admission no) and writes nothing; **every** problem row is listed, not just the first 500. Commit skips duplicates automatically — re-running a corrected file is safe.

## 5. Guardians
- **Bulk path:** the parents CSV above creates accounts + pending links in one file.
- **Office path:** `/admin/students` → Guardians → **Confirm** (audited).
- **Email path:** the guardian receives a one-time link → `/parent/verify` → confirms. Until then their child shows as *Link pending* and **no child data is visible** (row-level security, not UI).
- Revoke at any time from the same panel.

## 6. Fees — `/admin/fees`
1. Add fee **templates** (name, amount, grade scope, due-in days).
2. **Generate** for a term — one invoice per active student in scope. Re-generating never double-charges: existing (student, term, label) pairs are skipped.
3. Parents pay through the Paystack checkout; the webhook marks invoices paid.

## 7. Grading — `/admin/academics` → Grading scale
Set the school's bands (letter, min %, point) and exam/coursework weights. Stored sorted, and **used**: report-card generation applies the weights (exam vs coursework) to produce per-subject percentages, letters and points, plus an overall average/GPA. The scale in force is baked into each snapshot. Report cards are generated **per term** — the term must be chosen explicitly.

**Inviting students individually?** Set the grade level **on the invite** — an invitee cannot supply their own grade or admission number (a made-up number would collide with the real roster later).

## 8. Go-live gate — `/admin/reports`
The reconciliation report is the acceptance checklist:
- every class shows its true head-count;
- no *students without a verified guardian*;
- no *students without enrolments*;
- no *parents with no child linked*;
- pending guardian links worked to zero.

Only when this page is clean should the school stop using its old spreadsheet. From that moment the portal is the system of record (ADR-013).

## 9. First week operations
- Nightly encrypted `pg_dump` → R2 (`scripts/backup.sh`, 35-day retention).
- Staff TOTP resets: `scripts/mfa-token.mjs <email>` (requires the admin endpoint or ops CLI).
- Watch `audit_log` for `guardian_link.*`, `fee.*`, `import.*` actions — every phase-6 write is audited.

## Rollback
The portal is stateless above Postgres: restore the nightly dump, redeploy the previous image tag. Nothing in the pilot writes back to the school's old systems.
