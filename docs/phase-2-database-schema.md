# Phase 2 — Database Schema

**Project:** High School Portal · **Status:** Proposed — awaiting approval · **Date:** 2026-10-01
**Companion:** [`diagrams/er-diagram.svg`](diagrams/er-diagram.svg) · builds on [`phase-1-architecture.md`](phase-1-architecture.md)

---

## 0. How the approved decisions shaped this schema

| # | Decision | Schema consequence |
| --- | --- | --- |
| 1 | **Single school** | No `school_id` columns anywhere. RLS is keyed on *role + ownership* (teacher→section, parent→linked student) instead of tenant. Reversal path if the school ever merges: add nullable `school_id`, backfill the single value, make it `NOT NULL` — purely additive (ADR-009). |
| 2 | **Both Entra + Google Workspace** | `identities.provider ∈ {local, entra, google}`. A user may hold one identity per provider; same verified email across providers links to the **same** `users` row (account linking), never duplicates. |
| 3 | **eu-west-1, Managed PaaS** | Schema is provider-neutral Postgres 16+. Works identically on Supabase (confirmed eu-west-1) or Neon (EU region; US-headquartered → SCC required either way). PaaS PITR windows are shorter than RDS, so a nightly `pg_dump` to R2 with 35-day retention is mandatory, not optional. |
| 4 | **Parents read-only** | Enforced in **policy, not schema**: `messages.author_id` accepts any user so that enabling parent replies later is a one-line CASL change, zero migrations. v1 grants parents `SELECT` only. Threaded teacher↔parent structure from the original brief is preserved (threads exist; parents read). |
| 5 | **Fees / Exams / Transport in v1** | +11 tables: Fees (5), Exams (3), Transport (3), designed below. |

---

## 1. Conventions

| Convention | Rule |
| --- | --- |
| PKs | `id uuid DEFAULT uuid_v7()` — time-ordered, index-friendly, non-guessable |
| Common columns | Every table has `id`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz` (maintained by trigger). Listed once; omitted below. |
| Time | Always `timestamptz`. Wall-clock times for meetings use `time` + explicit day; academic dates use `date`. |
| Money | `numeric(12,2)` + ISO-4217 `currency char(3)` default `'NGN'` |
| Grades | `numeric(6,2)`; letters are **derived**, never stored as source of truth |
| Enums | Postgres `CREATE TYPE … AS ENUM`; new values are additive-safe (expand/contract) |
| Soft delete | `deleted_at timestamptz` only where humans delete things (`users`, `announcements`, `conversations`). Statutory data (grades, attendance, invoices, audit) is **never** deleted — it is superseded or archived |
| Encryption suffix | `_enc` = AES-256-GCM ciphertext (bytea); `_bidx` = HMAC-SHA256 blind index (bytea, unique) for exact-match lookup |
| FK indexes | Every FK gets an index (omitted below unless notable) |
| Audit | `updated_at` trigger everywhere; grade/invoice/payment mutations additionally write `grade_revisions` / `audit_log` rows from application code (not triggers — we need actor + reason) |
| Naming | snake_case, plural tables, singular enums |

---

## 2. Entity-Relationship overview

Nine domains, **49 tables**. Cardinalities below are the load-bearing ones; the full picture is in the SVG.

```
IDENTITY                DIRECTORY              ACADEMICS
users 1──∞ identities   users 1──1 students    academic_years 1──∞ terms 1──∞ course_sections
users 1──∞ sessions     users 1──1 staff       courses 1──∞ course_sections
users 1──∞ mfa_factors  staff ∞──1 departments course_sections 1──∞ section_meetings
roles 1──∞ user_roles   students ∞──∞ users    course_sections 1──∞ section_staff (users)
      (via users)             (as guardians)   course_sections ∞──∞ students (enrollments)

GRADEBOOK               ATTENDANCE             ASSIGNMENTS
grades ∞──1 students    attendance_sessions    assignments ∞──1 course_sections
grades ∞──1 sections      1──∞ attendance_     assignments 1──∞ submissions ∞──1 students
grade_revisions ∞──1        records (students) submissions 1──∞ files
      grades              (PK session,student) assignments 1──∞ files

EXAMS                   FEES                   TRANSPORT
exam_periods 1──∞ exams fee_items 1──∞         transport_routes 1──∞ route_stops
exams ∞──1 sections        invoice_lines       transport_routes 1──∞ student_transport
exam_scores ∞──1 exams  invoices 1──∞ lines       (students)
exam_scores ∞──1        invoices ∞──1 students payments 1──∞ payment_allocations
      students          payments 1──∞ allocations ──∞ invoices

CALENDAR / COMMS        NOTIFICATIONS          COMPLIANCE
events (standalone +    notifications ∞──1     audit_log (append-only)
  mirrored via views       users               consent_records ∞──1 users
announcements           notification_deliveries
conversations ∞──1         ∞──1 notifications
  students (subject)    push_subscriptions ∞──1 users
messages ∞──1 conversations
```

**Design notes**

- `students` and `staff` are 1:1 *profile extensions* of `users`. A person is a `users` row; their role rows say what they may do; their profile row carries role-specific data. A teacher who is also a parent = one `users` row, two `user_roles`, one `staff` profile, and `guardians` links to their children.
- The `guardians` table is the **authorization spine for the parent role**: every parent read path (grades, attendance, invoices, messages) joins through it.
- `files` is a central storage registry; assignments, submissions, report cards and avatars all reference it. Storage keys are opaque; nothing public.
- Report cards are **precomputed snapshots** (`report_cards.payload jsonb` + PDF in `files`) generated by the worker — never computed live on report night (Phase 1 load model).
- Calendars/schedules are **views over base tables** (§6), not stored copies — a single source of truth.

---

## 3. Table specifications

> Common columns (`id`, `created_at`, `updated_at`) omitted per §1.

### 3.1 Identity & access

**users** — every human in the system.

| Column | Type | Notes |
| --- | --- | --- |
| email | citext | `UNIQUE NOT NULL` |
| password_hash | text | nullable — null for SSO-only accounts |
| display_name, given_name, family_name | text | |
| phone_enc / phone_bidx | bytea | encrypted PII + blind index |
| avatar_file_id | uuid→files | |
| status | user_status | `invited, active, suspended, left` |
| is_under_13 | boolean | maintained by nightly job from `students.dob_enc` decrypt; gates COPPA behaviour |
| directory_opt_out | boolean | FERPA directory-information opt-out; filters every directory/roster query |
| preferred_language | char(2) | default `'en'` |
| deleted_at | timestamptz | soft delete |

**identities** — external IdP links. `PK (provider, subject)`; `UNIQUE (user_id, provider)`; `provider ∈ {local, entra, google}`; `subject text` (IdP `sub`); `email_snapshot citext`; `last_seen_at`.

**sessions** — opaque BFF sessions. `user_id` FK; `token_hash bytea UNIQUE`; `ip inet`; `user_agent text`; `amr jsonb` (how auth happened: `["mfa","webauthn"]`); `mfa_verified_at`; `expires_at`; `last_active_at`; `revoked_at`. Index `(user_id, revoked_at)`.

**mfa_factors** — `user_id`; `kind ∈ {totp, webauthn}`; `label`; `secret_enc bytea` (TOTP key) or `credential_json jsonb` (WebAuthn); `last_used_at`.

**roles** — `code role_code UNIQUE`, `name`, `description`, `is_system bool` (system roles cannot be deleted).

**user_roles** — `user_id`, `role_id`, `granted_by uuid→users`, `granted_at`, `revoked_at` (null = active). `UNIQUE (user_id, role_id) WHERE revoked_at IS NULL` (partial unique → role can be re-granted later).

**role_permissions** — `role_id`, `permission text` (capability string e.g. `gradebook:write`). Source of truth for the admin UI; the API loads it into CASL at boot and on change (Redis pub/sub invalidate).

**consent_records** — `user_id` (consenter), `student_id` nullable, `kind ∈ {coppa_parent_consent, directory_opt_out, media_release, data_processing}`, `granted bool`, `given_by uuid→users`, `valid_from`, `valid_until`, `document_file_id`. Append-only: revocation = new row with `granted=false`.

### 3.2 Directory

**students** — 1:1 with users.

| Column | Type | Notes |
| --- | --- | --- |
| user_id | uuid→users | `PK` |
| admission_no | text | `UNIQUE NOT NULL` |
| grade_level | smallint | 7–12 (JSS1–SS3 mapping in code) |
| house | text | |
| dob_enc | bytea | encrypted |
| gender | char(1) | |
| address_enc | bytea | encrypted |
| medical_notes_enc | bytea | encrypted; visible to counselor + school_admin + nurse only |
| national_id_enc / national_id_bidx | bytea | encrypted + unique blind index |
| enrolled_at, graduated_at, left_at | date | |
| status | student_status | `active, graduated, transferred, withdrawn` |

**staff** — `user_id PK`; `staff_no UNIQUE`; `job_title`; `department_id`; `hired_at`; `contract_end date`.

**departments** — `name UNIQUE`, `hod_user_id` nullable.

**guardians** — the parent↔student link. `student_id`, `user_id` (the parent), `relationship ∈ {mother,father,guardian,other}`, `is_primary bool`, `can_view bool` default true (future-proofing; v1 always true), `verified_at` (set after onboarding challenge), `ended_at`. `UNIQUE (student_id, user_id)`. **Every parent RLS policy in the system joins through this table.**

### 3.3 Academics

**academic_years** — `name UNIQUE` ("2026/2027"), `start_date`, `end_date`, `is_current bool` (exactly one true — enforced by partial unique index `WHERE is_current`).

**terms** — `academic_year_id`, `name` ("First Term"), `term_no smallint`, `start_date`, `end_date`. `UNIQUE (academic_year_id, term_no)`.

**courses** — `code UNIQUE` ("MTH-101"), `title`, `department_id`, `description`.

**course_sections** — the teachable unit. `course_id`, `term_id`, `name` ("MTH-101 A"), `room`, `capacity smallint`, `grade_scale_id` nullable, `status ∈ {draft, active, archived}`. `UNIQUE (term_id, course_id, name)`.

**section_meetings** — weekly recurrence. `section_id`, `day smallint` (0=Mon…6=Sun or 1–7; documented), `start_time time`, `end_time time`. Overlap detection per teacher/room done in API (advisory, not DB constraint).

**section_staff** — `section_id`, `user_id`, `role ∈ {teacher, assistant}`. `UNIQUE (section_id, user_id)`; exactly one `teacher` per section enforced in API + checked by reconciliation job.

**enrollments** — `student_user_id`, `section_id`, `enrolled_at`, `status ∈ {enrolled, dropped, completed}`, `dropped_at`. `UNIQUE (student_user_id, section_id)`.

**grade_scales** / **grade_scale_bands** — `grade_scales(name UNIQUE, min_pass_pct)`; `bands(scale_id, min_pct, max_pct, letter, remark, sort)` e.g. WAEC-style `A1…F9` or `A…F`. One default scale per school; sections may override.

### 3.4 Gradebook

**grades** — one row per scored item per student.

| Column | Type | Notes |
| --- | --- | --- |
| student_user_id | uuid→users | |
| section_id | uuid | |
| source_type | grade_source | `assignment, exam, custom` |
| source_id | uuid | nullable → assignments.id / exams.id |
| label | text | "Mid-term CA", fallback for custom |
| points, max_points | numeric(6,2) | |
| weight_pct | numeric(5,2) | contribution within term |
| graded_by | uuid→users | |
| graded_at | timestamptz | |
| released_at | timestamptz | **students/parents see nothing until released** — the release gate |
| feedback_text | text | |

`UNIQUE (student_user_id, source_type, source_id) WHERE source_id IS NOT NULL` (one grade per student per assignment/exam; custom grades unlimited). Index `(student_user_id, section_id, released_at)`.

**grade_revisions** — immutable timeline. `grade_id`, `prev_points`, `new_points`, `prev_feedback`, `changed_by`, `changed_at`, `reason text NOT NULL`. **No row in `grades` is ever physically updated without a revision row** (API enforces; nightly reconciliation job asserts).

### 3.5 Attendance

**attendance_sessions** — one register per section per day. `section_id`, `date date`, `taken_by`, `status ∈ {draft, final}`, `finalized_at`. `UNIQUE (section_id, date)`.

**attendance_records** — `PK (session_id, student_user_id)`; `status ∈ {present, late, absent, excused}`; `note text`. Edits after `final` write an audit row.

### 3.6 Assignments & files

**assignments** — `section_id`, `title`, `instructions`, `type assignment_type`, `points_possible numeric(6,2)`, `due_at timestamptz`, `allow_late bool`, `published_at` (null = invisible to students), `created_by`.

**submissions** — `assignment_id`, `student_user_id`, `attempt smallint`, `status ∈ {draft, submitted, graded, returned}`, `submitted_at`, `late bool` (computed at submit). `UNIQUE (assignment_id, student_user_id, attempt)`.

**files** — central registry. `storage_key text UNIQUE`, `owner_id`, `kind ∈ {submission, material, export, avatar, report_card, document}`, `filename`, `mime`, `size_bytes bigint`, `scan_status scan_status` (`pending, clean, infected`), `scanned_at`. Only `clean` files are servable (API enforces).

### 3.7 Exams

**exam_periods** — `academic_year_id`, `term_id`, `name` ("First Term Examination"), `start_date`, `end_date`, `status ∈ {draft, published, closed}`.

**exams** — `exam_period_id`, `section_id`, `title`, `date`, `start_time`, `end_time`, `room`, `max_score numeric(6,2)`, `weight_pct` (exam's share of term grade). The **exam timetable** = this table filtered by student enrollments (view §6).

**exam_scores** — `exam_id`, `student_user_id`, `score numeric(6,2)`, `graded_by`, `released_at`. `UNIQUE (exam_id, student_user_id)`. Revisions reuse `grade_revisions` pattern via a mirror row in `grades` (`source_type='exam'`) on release — keeps the report-card query single-source.

### 3.8 Fees

**fee_items** — `academic_year_id`, `term_id`, `name` ("Tuition", "Transport — Route 3"), `amount numeric(12,2)`, `currency char(3)`, `applies_to_grade smallint NULL` (null = all grades), `due_date date`, `transport_route_id` nullable (auto-links transport levies).

**invoices** — `invoice_no text UNIQUE` (seq `INV-2026-000001`), `student_user_id`, `term_id`, `status invoice_status`, `issued_at`, `due_date`.

**invoice_lines** — `invoice_id`, `fee_item_id`, `description`, `amount`. (Bundles multiple items on one invoice.)

**payments** — `amount`, `currency`, `method payment_method`, `gateway payment_gateway` (`paystack, flutterwave, manual`), `gateway_ref text` (provider transaction id; `UNIQUE` when gateway ≠ manual), `status payment_status`, `received_at`, `recorded_by` (null for gateway-auto).

**payment_allocations** — `payment_id`, `invoice_id`, `amount`. Allows one payment to settle several invoices and part-payments. Invoice status transitions (`partial`/`paid`/`overdue`) computed by worker from allocations vs lines.

### 3.9 Transport

**transport_routes** — `name`, `description`, `vehicle_reg`, `driver_name`, `driver_phone_enc`, `active bool`.

**route_stops** — `route_id`, `name`, `pickup_time time`, `sort smallint`. `UNIQUE (route_id, sort)`.

**student_transport** — `student_user_id`, `route_id`, `stop_id`, `academic_year_id`, `status ∈ {active, ended}`, `ended_at`. `UNIQUE (student_user_id, academic_year_id) WHERE status='active'`.

### 3.10 Calendar, announcements, messaging

**events** — `title`, `description`, `category event_category`, `starts_at`, `ends_at`, `all_day bool`, `audience ∈ {all, students, staff, parents}`, `grade_level smallint NULL`, `created_by`.

**announcements** — `title`, `body_md`, `audience`, `grade_level NULL`, `pinned bool`, `published_at`, `expires_at`, `author_id`, `deleted_at`.

**conversations** — thread anchored to one student. `student_user_id`, `started_by uuid→users` (teacher), `subject`, `status ∈ {open, closed}`, `last_activity_at`. Participants = starter + the student's **verified** guardians (derived, not stored).

**messages** — `conversation_id`, `author_id`, `body text`, `deleted_at`. v1 authorship restricted to teachers by policy (§4); schema already parent-capable.

### 3.11 Notifications

**notification_preferences** — `user_id`, `kind notification_kind`, `channel ∈ {email, push}`, `enabled bool`. `UNIQUE (user_id, kind, channel)`. Sensible defaults seeded at first login.

**notifications** — in-app record. `user_id`, `kind`, `title`, `body`, `entity_type text`, `entity_id uuid`, `read_at`. Index `(user_id, read_at DESC)`.

**notification_deliveries** — per-channel send log. `notification_id`, `channel`, `status ∈ {queued, sent, failed, bounced}`, `provider_ref`, `sent_at`, `error`.

**push_subscriptions** — `user_id`, `endpoint text UNIQUE`, `p256dh_key`, `auth_secret`, `user_agent`.

### 3.12 Compliance

**audit_log** — append-only, hash-chained. `actor_user_id` (null = system), `action`, `entity_type`, `entity_id`, `before_json jsonb`, `after_json jsonb`, `ip inet`, `user_agent`, `occurred_at`, `prev_hash bytea`, `row_hash bytea`. **No UPDATE/DELETE privileges for any role** (RLS §4). Written for: auth events, permission changes, grade/invoice/payment mutations, PII reads, admin CRUD, exports.

**report_cards** — `student_user_id`, `term_id`, `generated_at`, `generated_by` (system), `payload jsonb` (full snapshot: grades, attendance summary, teacher comments, conduct), `pdf_file_id`, `version smallint` (regeneration increments; parents always see latest released). `UNIQUE (student_user_id, term_id, version)`.

### 3.13 Phase-3 addendum (2026-10-01)

**comment_bank** — reusable report-card comments. `id`, `owner_user_id` (null = school-wide), `category text` ("effort", "conduct", "improvement"), `body text`, `archived_at`. Teachers pick from bank or free-type; comments land in `report_cards.payload`. Added per Phase-3 resolution of open item #4.

---

## 4. Row-Level Security — policy matrix

RLS is **enabled on every table**. Principles:

1. Staff see what their role needs; teachers only their sections; counselors additionally `medical_notes_enc`-holding rows (still encrypted at app layer).
2. Students see their own rows **after `released_at`/`published_at`** gates.
3. Parents see only rows for students present in `guardians` with `can_view AND verified_at NOT NULL AND ended_at IS NULL`, same release gates, **SELECT only on everything, everywhere**.
4. Admin/registrar: broad SELECT + writes on directory/fees; **no** writing grades/attendance (separation of duties).
5. `auditor`: SELECT-only on everything except PII plaintext (sees ciphertext + bidx only).
6. Workers use a named `service_role` session variable for batch jobs; every such transaction is audit-logged.

Representative policies (full set ships as SQL in `db/policies/`):

```sql
-- students: self, linked parents, staff with directory access
CREATE POLICY students_sel ON students FOR SELECT USING (
     user_id = current_setting('app.user_id')::uuid
  OR EXISTS (SELECT 1 FROM guardians g
              WHERE g.student_user_id = students.user_id
                AND g.user_id = current_setting('app.user_id')::uuid
                AND g.can_view AND g.verified_at IS NOT NULL AND g.ended_at IS NULL)
  OR current_setting('app.role') IN ('school_admin','registrar','counselor','teacher','auditor')
);

-- grades: release-gated, writer-scoped, parent read-only via guardians
CREATE POLICY grades_sel ON grades FOR SELECT USING (
  released_at IS NOT NULL AND (
     student_user_id = current_setting('app.user_id')::uuid
  OR EXISTS (SELECT 1 FROM guardians g WHERE g.student_user_id = grades.student_user_id
              AND g.user_id = current_setting('app.user_id')::uuid AND g.can_view
              AND g.verified_at IS NOT NULL AND g.ended_at IS NULL) )
  OR EXISTS (SELECT 1 FROM section_staff ss WHERE ss.section_id = grades.section_id
              AND ss.user_id = current_setting('app.user_id')::uuid)
  OR current_setting('app.role') IN ('school_admin','registrar','auditor')
);
CREATE POLICY grades_ins_upd ON grades FOR INSERT/UPDATE WITH CHECK (
  EXISTS (SELECT 1 FROM section_staff ss WHERE ss.section_id = grades.section_id
           AND ss.user_id = current_setting('app.user_id')::uuid) );
-- parents get NO insert/update/delete policy on grades, attendance, invoices → read-only by construction

-- messages: teacher authors in v1; participants read
CREATE POLICY messages_ins ON messages FOR INSERT WITH CHECK (
  current_setting('app.role') IN ('teacher','school_admin') );
CREATE POLICY messages_sel ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM conversations c
           JOIN guardians g ON g.student_user_id = c.student_user_id
          WHERE c.id = messages.conversation_id
            AND (c.started_by = current_setting('app.user_id')::uuid
                 OR g.user_id = current_setting('app.user_id')::uuid)) );

-- audit_log: insert for all authenticated, select for admin/auditor, never update/delete
CREATE POLICY audit_ins ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_sel ON audit_log FOR SELECT USING (
  current_setting('app.role') IN ('school_admin','auditor','super_admin') );
```

Denial-test suite (Phase 1 §10) asserts, per role: parent cannot INSERT anywhere; teacher A cannot read teacher B's section; parent of X cannot read student Y; student cannot read unreleased grades; nobody can UPDATE `audit_log`.

---

## 5. Encryption at the column level

| Table | Encrypted (`_enc`) | Blind index (`_bidx`) |
| --- | --- | --- |
| users | phone_enc | phone_bidx |
| students | dob_enc, address_enc, medical_notes_enc, national_id_enc | national_id_bidx (unique) |
| transport_routes | driver_phone_enc | — |
| mfa_factors | secret_enc | — |

Everything else relies on provider disk encryption (AES-256, KMS/CMK). Rationale for the narrow field-level set: these are the columns whose leak is catastrophic *and* which never need range/fuzzy queries (§ADR-005).

---

## 6. Derived views (single source of truth)

```sql
-- per-student weekly timetable
CREATE VIEW v_student_schedule AS
SELECT e.student_user_id, s.id AS section_id, s.term_id, m.day, m.start_time, m.end_time, s.room, c.title
FROM enrollments e
JOIN course_sections s ON s.id = e.section_id
JOIN section_meetings m ON m.section_id = s.id
JOIN courses c ON c.id = s.course_id
WHERE e.status = 'enrolled';

-- per-student calendar = school events + assignment dues + exams
CREATE VIEW v_student_calendar AS
SELECT student_user_id, category, title, starts_at, ends_at, ref_type, ref_id FROM (
  SELECT e.student_user_id, ev.category, ev.title, ev.starts_at, ev.ends_at, 'event' , ev.id
    FROM enrollments e CROSS JOIN events ev
   WHERE ev.audience IN ('all','students') AND (ev.grade_level IS NULL OR ev.grade_level =
        (SELECT st.grade_level FROM students st WHERE st.user_id = e.student_user_id))
  UNION ALL
  SELECT e.student_user_id, 'assignment', a.title, a.due_at, a.due_at, 'assignment', a.id
    FROM enrollments e JOIN assignments a ON a.section_id = e.section_id
   WHERE a.published_at IS NOT NULL AND e.status='enrolled'
  UNION ALL
  SELECT e.student_user_id, 'exam', x.title, (x.date + x.start_time)::timestamptz,
         (x.date + x.end_time)::timestamptz, 'exam', x.id
    FROM enrollments e JOIN exams x ON x.section_id = e.section_id
   WHERE e.status='enrolled') t;

-- outstanding fee balance per student per term
CREATE VIEW v_fee_balance AS
SELECT i.student_user_id, i.term_id,
       SUM(l.amount) AS billed,
       COALESCE(SUM(pa.amount) FILTER (WHERE p.status='succeeded'),0) AS paid,
       SUM(l.amount) - COALESCE(SUM(pa.amount) FILTER (WHERE p.status='succeeded'),0) AS balance
FROM invoices i
JOIN invoice_lines l ON l.invoice_id = i.id
LEFT JOIN payment_allocations pa ON pa.invoice_id = i.id
LEFT JOIN payments p ON p.id = pa.payment_id
WHERE i.status NOT IN ('draft','void')
GROUP BY 1,2;
```

Plus `v_teacher_today` (my sections meeting today + register status), `v_parent_dashboard` (children → latest attendance, released grade summary, balance, next deadline) used by the Phase 4 dashboards.

---

## 7. Index highlights (beyond FKs/uniques)

| Table | Index | Serves |
| --- | --- | --- |
| attendance_sessions | `(section_id, date DESC)` | teacher's register history |
| attendance_records | `(student_user_id)` + via session date join | student/parent attendance history |
| grades | `(student_user_id, section_id, released_at DESC)` | report card & student view |
| assignments | `(section_id, published_at)`, `(due_at) WHERE published_at IS NOT NULL` | missing-work job |
| submissions | `(assignment_id, status)` | grading queue |
| invoices | `(student_user_id, term_id, status)` | parent fee view |
| payments | `(gateway_ref) WHERE gateway_ref IS NOT NULL` | webhook idempotency |
| notifications | `(user_id, read_at DESC)` | bell icon |
| events | `(starts_at)`, `(audience)` | calendars |
| messages | `(conversation_id, created_at)` | thread load |
| audit_log | `(entity_type, entity_id)`, `(occurred_at)` | compliance search |

---

## 8. Retention → table mapping

| Data | Tables | Rule |
| --- | --- | --- |
| Transcripts | `grades`, `exam_scores`, `report_cards` | **Permanent**; archived to R2 Glacier tier after graduation+5y |
| Attendance | `attendance_*` | 5y post-exit, then anonymise student FK |
| Assignment files | `files` (+S3) | current year+1 → cold tier; delete at +3 |
| Messages | `conversations`, `messages` | 24 months, then hard delete (no statutory hold) |
| Fees | `invoices`, `payments`, allocations | 7y (financial/tax), then archive |
| Audit | `audit_log` | 7y, never mutated |
| Erasure requests (NDPA §37) | PII columns | Suppress-and-shred: overwrite `_enc` with fresh key-less ciphertext, null the bidx; academic skeleton rows remain for transcript validity |

---

## 9. Bootstrap & migrations

- `db/seed/` ships: roles + `role_permissions` matrix, default grade scales (WAEC A1–F9 and A–F), notification preference defaults, one `academic_year` + three `terms`.
- Migrations are drizzle-kit, **expand/contract only**; every migration must pass the RLS denial suite in CI before merge.
- Staging = a Neon/Supabase **branch** seeded with synthetic data (decision #3 makes this nearly free).

---

## 10. Open items for Phase 3

1. Fee webhook contract (Paystack vs Flutterwave) — fixes `payments.gateway_ref` semantics and idempotency key format.
2. Exam moderation workflow (moderated score vs raw score columns) if the school runs internal moderation.
3. Whether transport levy is auto-invoiced from `student_transport` (recommended) or manually added per term.
4. Report-card comment bank structure (per-teacher reusable comments) if the school wants it.
