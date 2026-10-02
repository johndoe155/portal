# Go-Live Plan — "the school starts using this today"

**Date:** 2026-10-02 · **Branch:** `arena/01a0feba-portal`
**Goal:** close every gap between the current code and a portal a real school can
run on Monday morning — without weakening the security foundation already in place.

---

## 0. What I verified before writing this

I unzipped `school-portal.zip`, installed, built and ran the suite. Baseline:

| Check | Result |
| --- | --- |
| `npm install` | ✅ 205 packages |
| `npm run build` | ✅ contracts → api (tsc) → web (next build) all green |
| `npm test` | ❌ **fails** — `node --test test/` throws `MODULE_NOT_FOUND` on Node 22 |
| `node --test "test/*.test.mjs"` | ✅ **73/73 pass** |
| `npm audit` | ❌ 1 **high** — drizzle-orm `<0.45.2` SQL injection (GHSA-gpj5-g38j-94v9) |
| `Dockerfile` line 27 | ❌ `COPY scripts scripts  # comment` → confirmed broken |
| `.env.example` | ❌ **does not exist** — README and `docker-compose.yml` both reference it |
| `.github/` CI | ❌ **does not exist** — docs claim "k6 as a real CI gate" |

So on top of your list there are **four more day-one problems**: the test command
is broken, there's a high-severity dependency CVE, the env file every document
points at is missing, and there is no CI at all. All four are in scope below.

Also worth flagging: **the repo currently contains only `school-portal.zip`** —
no source tree is tracked in git. Step 1 is to commit the extracted tree so
diffs, review and CI are possible at all.

---

## Workstream A — Blockers (must land before any school touches it)

### A1. Fix the Docker build
`Dockerfile:27` — `COPY scripts scripts         # ops CLIs (…)`. Docker's exec-less
`COPY` treats `#` and everything after it as additional source arguments, so the
build fails (or, worse on older parsers, silently misinterprets the destination).

- Move the comment to its own line above the `COPY`.
- Audit every other `COPY`/`ADD` in the file for the same pattern (`RUN` lines are
  safe — those are shell comments).
- **Prove it:** add a CI job that actually runs `docker build .` to completion and
  then boots the image. Right now nothing ever built this image.

### A2. Real email templates
Today every email body is `JSON.stringify(payload, null, 2)` (`notify.service.ts:165`).
A parent resetting their password receives a JSON blob containing a URL.

- Add `apps/api/src/notify/templates/` — one module per `kind`
  (`password_reset`, `user_invite`, `guardian_verify`, `mfa_enroll_token`,
  `absence_recorded`, `grade_released`, `message_received`, `daily_digest`,
  plus the new `account_deactivated` / `erasure_complete`).
- Each template renders **both** `text` and `html` from a shared layout that pulls
  school name, logo, colours and contact address from `school_settings` (already
  in the DB and already loaded by the worker).
- Real, clickable absolute links built from `PUBLIC_WEB_ORIGIN` — reset, invite,
  guardian-verify and MFA-enrol links, each with its expiry stated in plain
  English ("this link expires in 1 hour").
- HTML is escaped at the interpolation boundary; tables-based layout so it renders
  in Outlook; plain-text part is a genuine readable alternative, not a dump.
- Add `List-Unsubscribe` + `Auto-Submitted: auto-generated` headers so digests and
  alerts don't trip spam filters.
- Golden-file tests: render every kind, assert the link is present, assert no raw
  JSON, assert no unescaped interpolation.

### A3. Email deliverability (SMTP + SPF/DKIM/DMARC)
- `createMailer()` currently falls back to `jsonTransport` whenever `SMTP_URL` is
  unset — **including in production**, which means production silently drops mail.
  Make a missing `SMTP_URL` **fatal in production** (same pattern as the PGlite
  guard in `db/client.ts`), and surface "email not configured" on the admin
  overview and `/health`.
- Add connection pooling, timeouts and `verify()` on worker boot so a bad SMTP
  config fails loudly at deploy time instead of at 2am.
- Add `scripts/mail-check.mjs` — sends a test message and prints the result, so
  the operator can prove delivery before go-live.
- Write `docs/email-setup.md`: the exact SPF / DKIM / DMARC DNS records, an
  ESP-agnostic walkthrough (Postmark / SES / Resend / plain SMTP), warm-up advice,
  and a verification checklist (mail-tester, Google Postmaster).
  **DNS itself is the school's to publish — I'll give them the exact records.**

### A4. Email retries with backoff + a dead-letter view
Currently one SMTP hiccup sets `status = 'failed'` forever, and the reset link is
gone. Notifications already have an `attempts` column; nothing uses it.

- Migration `0009`: add `next_attempt_at timestamptz`, `locked_at`, `locked_by`
  to `notifications`; index on `(status, next_attempt_at)`.
- Worker claims rows with `FOR UPDATE SKIP LOCKED` (safe for multiple workers)
  rather than a plain `SELECT … WHERE status='queued'`.
- On failure: exponential backoff with jitter (1m, 5m, 15m, 1h, 4h, 12h — 6
  attempts), `status='queued'` until attempts are exhausted, then `'failed'`.
- Distinguish **permanent** failures (invalid recipient, 5.1.1 hard bounce,
  "recipient not found") — those go straight to `failed`, no pointless retries.
- Admin UI: **Notifications** screen listing queued / failed with the last error,
  plus a **Retry** button and a **Resend** action. An admin must be able to see
  "Mrs Okoye's reset email bounced" without a DBA.
- Metrics on `/health`: queue depth, oldest queued age, failed count in 24h.

### A5. Roster import that survives a real school
Today the browser `JSON.stringify`s the whole CSV into one body. `express.json`
caps at **1 MB** (`app.factory.ts:36`) and the Next rewrite proxy times out around
30 s. A 1,200-student enrolments file with ~100 ms scrypt per row is both too big
and far too slow.

- **Transport:** switch `/import/:kind` to `multipart/form-data` file upload
  (streamed to disk/temp, not buffered), with a configurable cap (default 25 MB)
  applied *only* to that route — the 1 MB JSON limit stays everywhere else.
- **Async execution:** a commit creates an `import_jobs` row and returns `202` with
  a job id. A worker processes it in **batches** (e.g. 200 rows per transaction)
  so no single transaction holds locks for minutes, and progress is observable.
  Dry-run stays synchronous for small files and goes async above a threshold.
- **Progress + resumability:** `GET /import/jobs/:id` returns
  `{ state, processed, total, created, duplicates, errors }`; the admin page polls
  and shows a progress bar. A crashed worker resumes from the last committed batch.
- **Results:** per-row errors stored in the job, downloadable as a CSV
  (`row,status,problems`) rather than a 10,000-row HTML table.
- **Set-password links** currently returned inline become part of that downloadable
  artefact, available once, and only when SMTP is unconfigured.
- **Proof at school scale:** a generator script producing a realistic school
  (1,200 students, 80 staff, 2,000 guardians, 6,000 enrolments) and a test that
  imports all of it end-to-end and asserts the row counts and the wall-clock time.
  This is the test that is currently missing, and the one that decides whether
  this is actually ready.

### A6. Backups that match the runbook
`scripts/backup.sh` is a plain local `pg_dump`, keeps 14 files, has no encryption,
no offsite copy and no scheduler. The runbook promises encrypted nightly dumps to
R2 with 35-day retention.

- Rewrite `scripts/backup.sh`: `pg_dump --format=custom` → **age** or
  `openssl enc -aes-256-cbc -pbkdf2` encryption (key from `BACKUP_ENCRYPTION_KEY`)
  → upload to S3/R2 via `aws s3 cp` (S3-compatible endpoint) → **35-day**
  retention applied *remotely* as well as locally → structured log line + non-zero
  exit on any failure.
- Add `scripts/restore.sh` — decrypt + `pg_restore` into a target database, with a
  `--verify` mode that restores into a scratch DB and runs row-count assertions.
- Add `scripts/backup-verify.sh` — the **restore drill**: restore last night's
  dump into a throwaway database, assert `users`, `students`, `enrollments`,
  `grades`, `fee_invoices` counts are non-zero and migrations are at head. This is
  what turns "we have backups" into "we have *restorable* backups".
- **Schedule it:** a `backup` service in `docker-compose.yml` (ofelia or a small
  cron container) running nightly, plus the equivalent cron/scheduled-job snippets
  for Railway/Render/GitHub Actions in the docs for the managed-PaaS path.
- **Alert on silence:** the backup writes a heartbeat row/file; `/health` reports
  `last_backup_age_hours` and the admin overview shows a warning past 36 h.
- A CI job proves backup→encrypt→restore→verify round-trips against a real
  Postgres service container. No more untested promises.

### A7. Make the legal pages true
Three separate lies to fix.

1. **Purge job** — a `retention` worker task implementing exactly the table in
   `docs/legal/data-retention.md`: outbox 90 days, sessions 30 days after
   expiry/revocation, used reset/invite/enrol tokens 30 days, push subscriptions
   after 90 days of failure, idempotency keys, leaver anonymisation at 90 days.
   Each run is audited (`retention.purge`, with per-table counts), idempotent, and
   runs on a daily tick. `GET /admin/retention` shows last run + rows removed.
   **I will reconcile the two documents first** — `docs/legal/data-retention.md`
   says outbox 30 days / sessions 90 days, while `app/legal/retention/page.tsx`
   says outbox 90 / sessions 30. They contradict each other today.
2. **Erasure endpoint** — `POST /users/:id/erasure` (`directory:write` +
   confirmation), honouring the statutory-retention carve-out: direct identifiers
   are overwritten/tombstoned, pseudonymous keys kept so class statistics survive,
   records inside a statutory window are *restricted* rather than deleted and the
   restriction is recorded. Audited, irreversible, with a dry-run preview showing
   exactly what will be erased and what is held. Paired with the existing
   `GET /users/:id/export` so the subject-access pair (export + erase) is complete.
3. **DPO email** — `school_settings.dpo_email` already exists and is editable at
   `/admin/school`. Remove every hard-coded `admin@school.example` from
   `docs/legal/*` and the three `/legal/*` pages, and render the configured value
   instead (with a clear "not configured yet" state and a go-live check that
   refuses to pass until it is set). Same for `contact_email` in the ToS.

---

## Workstream B — Week-one admin tooling

### B1. Deactivate / offboard a user
No endpoint exists today. A teacher who resigns keeps working credentials.

- `POST /users/:id/deactivate` — sets `users.status='inactive'`, **revokes every
  session immediately**, revokes active `user_roles`, cancels pending invites and
  reset tokens, ends guardian links where appropriate, and audits the whole thing.
- `POST /users/:id/reactivate` — the symmetric operation.
- The session middleware must **reject inactive users on every request**, not just
  at login (today `status` is never re-checked after a session exists).
- Guard rails: you cannot deactivate yourself, and you cannot deactivate the last
  remaining `super_admin`.
- UI on `/admin/users/[id]`: status badge, Deactivate/Reactivate with a typed
  confirmation, "what this will do" explanation, and the offboarding checklist
  (sections they teach, threads they own, children linked) shown *before* you
  confirm — so the registrar reassigns their classes rather than orphaning them.

### B2. Audit-log screen
`audit:read` is granted to `super_admin`, `school_admin` and `auditor`, and the
`audit_log` table is append-only with a per-row hash — but **no endpoint and no
screen exist**, so the permission grants access to nothing.

- `GET /audit` (`audit:read`): keyset pagination, filters on actor, action,
  entity type/id and date range, plus full-text on the action.
- `GET /audit/verify`: recomputes `row_hash` over a range using the existing
  `computeRowHash` and reports any row that fails — surfacing the tamper-evidence
  that's already built but currently unreachable.
- `/admin/audit` screen: filter bar, readable action names, actor resolution to
  display names, before/after diff viewer, CSV export (audited as `audit.exported`).

### B3. Promotion / year rollover
Nothing exists. Without it the school cannot start a second term, let alone a
second year — the portal would be a one-term tool.

- `POST /academic-years/:id/rollover` (dry-run first, then commit, idempotent):
  - creates the next academic year and its terms from a template;
  - promotes students `grade_level + 1` within a chosen scope;
  - marks the top grade as **graduated** (status change, not deletion — their
    records stay for the statutory window, their portal access is offboarded);
  - carries sections/courses forward as templates for the new year, optionally
    with the same staff assignments;
  - leaves prior-year enrolments, grades, attendance and invoices untouched.
- Per-student overrides: retain, skip, withdraw, transfer-out.
- Preview screen at `/admin/academics` → **Year rollover**: a table of every
  student with their current and proposed grade, overridable, with counts, before
  anything is written. Fully audited, and reversible within the same day via the
  recorded before-state.

### B4. Bulk MFA onboarding
Today: `POST /users/:id/mfa-enroll-token`, one at a time. Sixty teachers = sixty
clicks and sixty out-of-band hand-offs.

- `POST /mfa/enroll-tokens/bulk` — select by role, by section, or by uploaded list;
  issues single-use 24 h tokens for everyone selected in one transaction.
- Each token is **emailed** using the new `mfa_enroll_token` template with a
  deep-link into the enrolment screen (the token is the sensitive payload the
  outbox already encrypts at rest).
- Fallback for a school with no email yet: a printable per-staff PDF/CSV handout,
  generated once, shown once.
- `/admin/users` → **MFA status** column (enrolled / token pending / none) and an
  **MFA rollout** panel: who's done, who hasn't, reissue expired tokens, nudge
  the stragglers. A deadline-driven view, because that's the actual job.
- Keep `scripts/mfa-token.mjs` as the break-glass path for the first admin.

---

## Workstream C — Hygiene the review didn't list but a school will hit

| # | Item | Why it matters on day one |
| --- | --- | --- |
| C1 | **Commit the extracted source tree** (zip currently the only tracked file) | Without it there is no diff, no review, no CI |
| C2 | **Fix `npm test`** → `node --test "test/*.test.mjs"` | The documented command fails outright on the supported Node |
| C3 | **Bump drizzle-orm ≥ 0.45.3** (GHSA-gpj5-g38j-94v9, high) and re-run the suite | Shipping a known SQL-injection advisory into a school |
| C4 | **Write `.env.example`** | README and `docker-compose.yml` both point at a file that doesn't exist; operator can't configure the stack |
| C5 | **Add CI** (`.github/workflows/ci.yml`): install → build → test → `docker build` → backup/restore drill → migrations-against-real-Postgres → `npm audit --audit-level=high` | Docs claim a CI gate; there is no `.github/` directory |
| C6 | **Go-live readiness endpoint + screen** — SMTP configured, DPO email set, backup fresh, MFA coverage, reconciliation clean, no demo seed | Turns the runbook's prose checklist into something the school can actually see is green |
| C7 | **Correct the docs** — README/roadmap/runbook cite "57 API tests" and various counts; actual is 73, and the runbook promises backup behaviour that doesn't exist yet | Trust: if the docs are wrong about the easy things, nobody believes them about the hard ones |

---

## Sequencing

| Phase | Contents | Rationale |
| --- | --- | --- |
| **1** | C1 (commit tree), C2, C3, C4, A1 (Docker) | Make the repo buildable, testable and reviewable before changing behaviour |
| **2** | A2, A3, A4 (email: templates → SMTP → retries) | One coherent pass over the notification path |
| **3** | A5 (import) + school-scale data generator and test | The highest-risk item; needs its own proving ground |
| **4** | A6 (backups + restore drill), C5 (CI) | Ops safety net, exercised by CI |
| **5** | B1, B2 (offboarding, audit screen) | Admin tooling built on the now-stable base |
| **6** | B3, B4 (rollover, bulk MFA) | Larger features, lower day-one urgency than offboarding |
| **7** | A7 (purge job, erasure, DPO), C6, C7 | Compliance + readiness gate + documentation truth-up |

Each phase ends with the full suite green and a commit on `arena/01a0feba-portal`.
I'll keep the existing 73 tests passing throughout and add tests with each phase —
I'd expect to land somewhere around 120–140 API tests by the end.

---

## What I cannot do from here (the school must do these)

1. **Publish DNS records** — SPF, DKIM and DMARC live on the school's domain. I'll
   produce the exact records and a verification checklist; someone with registrar
   access has to paste them in.
2. **Create the real mailbox / ESP account** and supply `SMTP_URL`.
3. **Provision R2/S3** and supply the bucket, credentials and
   `BACKUP_ENCRYPTION_KEY` (I'll make the scripts fail loudly until they do).
4. **Lawyer review of the legal pages** — they're templates. I can make the product
   behave as they describe; I can't make them legally sufficient.
5. **Supply real school data** for the first import — though I'll ship a realistic
   generator so the whole path is proven before their file arrives.

---

## Decisions — locked 2026-10-02

| # | Decision | Chosen |
| --- | --- | --- |
| 1 | Repo layout | **Commit the extracted tree at the repository root; drop `school-portal.zip`** |
| 2 | Email delivery | **Provider-agnostic SMTP via nodemailer + exact SPF/DKIM/DMARC records documented for the school to publish** |
| 3 | Import architecture | **Full async job: multipart upload, batched worker, progress polling, resumability, downloadable error CSV** |
| 4 | Scope | **Everything in this plan — all 7 phases** |

### Consequences

- **(1)** Phase 1 begins with `git rm school-portal.zip` and committing the 246
  extracted files, so every later phase is a reviewable diff.
- **(2)** No ESP SDK dependency. Missing `SMTP_URL` becomes fatal in production,
  and `docs/email-setup.md` carries the DNS records. Bounce handling is limited
  to SMTP-level rejections — there is no webhook feedback loop, so the
  dead-letter screen (A4) is the school's bounce visibility.
- **(3)** Adds an `import_jobs` table (migration `0010`), a multipart route with
  its own body cap, and worker-side batching. The 1 MB JSON limit stays
  everywhere else.
- **(4)** Year rollover (B3) is included — without it the school cannot start a
  second term.

### Open item carried into Phase 7

`docs/legal/data-retention.md` (outbox 30 d / sessions 90 d) and
`app/legal/retention/page.tsx` (outbox 90 d / sessions 30 d) contradict each
other. I'll propose one authoritative set of windows with the purge job and
flag it for confirmation rather than silently picking one.
