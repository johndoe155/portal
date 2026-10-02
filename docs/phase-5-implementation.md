# Phase 5 — Implementation Log

**Status:** Steps 5.1–5.4 **done & tested** · Phase 5 complete, pending sponsor approval · **Date:** 2026-10-01

## Step 5.1 — Auth + database setup (this step)

Runnable, tested vertical slice of the approved design:

```
apps/api        NestJS 12 · Express 5 · Drizzle ORM · PGlite (dev/test Postgres)
packages/contracts   Zod wire schemas shared by API and (later) web
db/migrations/0001_init.sql   DDL + RLS policies + least-privilege role
apps/api/test/api.test.mjs    9 integration tests (node:test + supertest)
```

**Implemented endpoints (Phase-3 subset):** `auth` (login, session, logout, TOTP enroll/verify, role switch, providers), `users` + `students/:id` + `users/:id/roles`, `sections` + `sections/:id/roster`, attendance (get / bulk upsert / finalize), gradebook (get / bulk upsert with revisions / release), student reads (`student/grades`, `student/attendance`), parent reads (`parent/children`, `…/grades`, `…/attendance`).

**Security machinery live:** BFF-style httpOnly session cookie + CSRF double-submit; MFA step-up enforced for staff (TOTP, RFC 6238, no deps); capability guard + parent read-only invariant at the router; **gate 2 RLS on every table** with `SET LOCAL ROLE portal_app` + `set_config(app.user_id/app.role)` per transaction; hash-chained-ish audit rows on mutations; RFC 9457 problem responses; idempotency keys on risky writes.

### Run it

```bash
npm install && npm run build
npm test                      # 9/9 pass
COOKIE_SECURE=false PORT=8080 npm start -w @portal/api
# seeded logins (password Passw0rd!): admin@ / t1@ / t2@ / s1@ / p1@ school.example
```

### What the tests prove

| # | Assertion |
| --- | --- |
| 1 | Staff session is locked (`403 mfa_required`) until TOTP verified; then teacher sees **only own** section |
| 2 | Mutation without `X-CSRF` → `403 csrf_missing` |
| 3 | Teacher writes own register (idempotent replay returns same body); other teacher → `403 outside_section_scope` |
| 4 | Finalized register → `409` on further writes; student sees own attendance |
| 5 | Grades invisible pre-release; visible post-release to student **and** verified parent; corrections write revisions |
| 6 | Parent mutating verb → `403 parent_read_only` before policy evaluation |
| 7 | Admin reads directory post-MFA; teacher lacks `directory:read` capability |
| 8 | RLS backstop: teacher2's gradebook read of section1 returns **zero rows** |
| 9 | Audit log captured grade writes with correct actor |

### Deviations & production notes (honest list)

1. **PGlite** stands in for Neon/Supabase in dev/test. The SQL is provider-neutral; production must connect as a **non-superuser** (`portal_app` pattern) — this step proved superusers bypass RLS even with `FORCE`, so the API transaction does `SET LOCAL ROLE portal_app`. Provision the same role on Neon/Supabase.
2. Idempotency replay cache is in-memory (single node). Production: Redis (Phase-1 stack).
3. SSO (Entra/Google) is advertised by `GET /auth/providers`; the OIDC callback + BFF live in **5.2** with the web app. Local email+password + TOTP is fully functional now.
4. Notification fan-out (email/push), messaging, fees/exams/transport endpoints, file uploads: **5.3/5.4** per plan.
5. Express cookie `maxAge` is milliseconds — caught and fixed during testing (sessions were 43 s long).

## Step 5.2 — Web app: Next.js 16 BFF + four role dashboards (complete 2026-10-01)

### What was built (`apps/web`)

- **BFF pattern (ADR-012):** `next.config.mjs` rewrites `/api/:path*` → `API_INTERNAL` (default `http://127.0.0.1:8080`), so the `sid`/`csrf` cookies stay first-party and browsers never call the API origin directly. Server components forward the viewer's cookie via `next/headers` (`lib/session.ts`); client components use `lib/client.ts`, which attaches `x-csrf` from the readable `csrf` cookie and optional `idempotency-key`.
- **Gate helpers:** `checkSession()` decides `authed | mfa | anon` (the API's `GET /auth/session` is MFA-exempt, so the web layer enforces the MFA gate); `requireRole(...)` redirects anon→`/login`, MFA-pending→`/mfa`, wrong-role→its own home. The API/RLS remain the authoritative enforcement — these are UX gates only.
- **Auth screens:** `/login` (local email+password; SSO buttons arrive with 5.3 OIDC callbacks), `/mfa` (TOTP enrol → secret + otpauth link → verify; 6-digit pad with `autocomplete="one-time-code"`).
- **Role dashboards (Phase-4 trees):**
  - `/teacher` section cards → `/teacher/attendance/[sectionId]` (chip register per student × 4 statuses, save with `crypto.randomUUID()` Idempotency-Key reused across failed retries, finalize with confirm + lock banner) and `/teacher/gradebook/[sectionId]` (record grade with source/points/max/feedback, release-all button, unreleased counter, full grade table).
  - `/student` (attendance counters, latest released grades, recent attendance) + `/student/grades` (released-only table with % + feedback).
  - `/parent` child cards → `/parent/[childId]` read-only grades + attendance; any mutating call from a parent session is refused `403 parent_read_only` by the API.
  - `/admin` (people/sections stats) + `/admin/users` (paged directory, role drill-down via `roles:read`) + `/admin/sections`.
- **Design system:** hand-rolled `globals.css` tokens/components (no Tailwind) — mobile-first: fixed bottom tab bar on phones converting to pills on ≥768 px, 44 px touch targets, `:focus-visible` rings, skip link. Deviation from the Phase-4 Tailwind plan, noted below.

### Verification (all through the web origin, port 3000)

`npm run smoke -w @portal/web` (`apps/web/test/smoke.mjs`) — **21/21 passing** against live API+web:

| Group | Checks |
| --- | --- |
| Anon/gates | `/`→307 `/login`; `/login` renders; staff session gated to `/mfa` before TOTP; student `/admin` bounced to `/student` |
| Auth via BFF | teacher login sets cookies; TOTP enrol + verify (real codes from `dist/crypto/totp.js`) |
| Teacher | `/teacher` lists MTH-101 A; register renders roster; gradebook renders; attendance save `201`; same-key replay returns identical body; missing key `400` |
| Student | dashboard renders released-only view |
| Parent | child card + child page render; parent mutation → `403 parent_read_only` |
| Admin | console + user directory render |

Plus `npm test` (API suite) still **9/9**, and `next build` compiles + typechecks all 15 routes.

### Run it

```bash
npm install
npm run build                       # contracts → api → web
COOKIE_SECURE=false PORT=8080 npm start -w @portal/api   # terminal 1
API_INTERNAL=http://127.0.0.1:8080 npm start -w @portal/web  # terminal 2 → http://localhost:3000
npm test                            # API suite (9)
npm run smoke -w @portal/web        # web e2e-ish smoke (21) — needs both servers up
```

### Deviations & notes (5.2)

1. **Hand-rolled CSS instead of Tailwind** — one dependency-light stylesheet with the same token/breakpoint approach as Phase-4; swap-in cost is low if Tailwind is preferred.
2. **TOTP enrol shows the secret + `otpauth://` link as text** (no QR image) to avoid a client-side QR dependency; authenticator apps accept the link/manual key.
3. Server components are used for all data reads (streamed, `cache: "no-store"`); client components only where interaction demands (forms/chips). A "use client" module cannot be imported by server code for function calls — helpers shared by both live in `lib/dates.ts`/`lib/roles.ts`.
4. Turbopack needs `turbopack.root` set explicitly when the monorepo root is the home directory.
5. Playwright e2e + WebSocket ticket route deferred to 5.3 with messaging (no WS surface yet).
6. Admin write screens (user/role CRUD, roster editing) need the registrar write endpoints — 5.3.

## Step 5.3 — Notifications worker, messaging, SSO, admin writes (complete 2026-10-01)

### What was built

**Database (`db/migrations/0002_messaging_notifications.sql`):** 5 new tables — `message_threads`, `messages` (with denormalized `sender_name`), `notifications` (transactional outbox), `push_subscriptions`, `report_cards` — all `FORCE RLS` with actor-scoped policies. New helper `is_teacher_of(stu)`. Two 0001 corrections ride along: the `identities` provider CHECK is dropped (provider set is governed by `SSO_<NAME>_*` config, not the DB — onboarding an IdP must not need a migration).

**Messaging (teacher↔parent, parents read-only per Phase-1):** `GET/POST /threads`, `GET /threads/:id`, `POST /threads/:id/messages`, `POST /threads/:id/close`. Teachers may only open threads for students they actually teach (gate 1 `outside_section_scope`, gate 2 RLS `threads_ins` via `is_teacher_of`). Parents read threads about their children; the blanket `parent_read_only` guard plus `msgs_ins` (author-only) make parent posting structurally impossible. Web: `/teacher/messages` (+ thread view with reply/close) and `/parent/messages` (read-only, banner shown).

**Notification pipeline (outbox pattern):** feature code enqueues rows *inside the same actor transaction* as the business write — absence transition (`absent` only on change, guardian email+push), grade release (student + guardians), teacher message (guardians). `GET /notifications` = own inbox (RLS-protected). Worker (`startWorker`, in-process by default; standalone `npm run worker` for production) drains the queue: email via nodemailer (`SMTP_URL` in prod, JSON transport in dev), Web Push via `web-push` when VAPID keys are set else a JSONL dev sink (`data/push-outbox.jsonl`); failed deliveries keep `attempts`/`last_error`. `runDigest()` = idempotent per-recipient daily rollup.

**SSO (OIDC authorization-code, Entra + Google):** `GET /auth/sso/:provider/start|callback`, providers fully config-driven (`SSO_<NAME>_{ISSUER,AUTH_URL,TOKEN_URL,CLIENT_ID,CLIENT_SECRET,SCOPES,JWKS_URL|HMAC_SECRET,JIT_ROLE}`). HMAC-signed stateless `state` (10-min TTL, timing-safe verify), code exchange, id_token verification (RS256 via JWKS in prod; HS256 for dev mock IdP), then identity link → user resolution (existing-identity → link-by-email → optional JIT) → session. `redirect_uri` points at the **web origin** so the cookie lands first-party via the BFF rewrite; staff still hit the MFA gate. Login page now has both SSO buttons. Tests run against a local mock IdP (`test/mock-idp.mjs`) using the real provider names.

**Admin/registrar writes:** `POST /users` (with roles, duplicate-email 409), `POST|DELETE /users/:id/roles[/:code]` (`roles:write` = super_admin only — school_admin gets `missing_capability`), `GET /students-lookup?admission_no=`, `POST /sections`, `POST /sections/:id/enrollments`, `GET /terms`, report cards (`POST /report-cards/generate` behind `exports:write`, `GET /students/:id/report-card` for self/guardian/admin). Web: create-user form, role grant/revoke chips, section create + enroll forms, report-card blocks on student & parent pages. Seed gains `root@school.example` (super_admin).

### Verification

- **API suite: 26/26** (`npm test` — 10 from 5.1 + 16 new in `test/phase53.test.mjs`: thread scoping, parent read-only, notification hooks incl. no-duplicate absence, worker drain with honest failure for unsubscribed push, idempotent digest, report-card access matrix, user creation + role gating, section/enroll + duplicates, full SSO redirect chain incl. JIT, email-linking with staff MFA gate, unprovisioned refusal, tampered-state rejection).
- **Web smoke: 32/32** (`npm run smoke -w @portal/web`, all through the BFF origin, both servers live).
- `next build` clean (19 routes); live worker observed draining (`[worker] processed … sent …`).

### RLS lessons from this step (added to the codebase as comments)

1. **`INSERT … RETURNING` re-checks the SELECT policy** — a teacher enqueuing a notification *for a guardian* cannot read that inbox row, so `enqueue()` must not use `.returning()`.
2. **Joins need every joined table visible to the actor** (again): guardians cannot read staff rows in `users`, so `messages.sender_name` is snapshotted at post time instead of joining.
3. CHECK constraints that encode *configuration* (IdP names) become operational drag — govern provider identity in config, validate in the API.

### Deviations & production notes (5.3)

1. Dev email = nodemailer JSON transport; push without VAPID = JSONL sink. Production: `SMTP_URL` (SES/Postmark) + `VAPID_*` (web-push) — no code change.
2. Worker runs in-process by default (`WORKER_INPROC`); production runs `npm run worker` beside real Postgres with `FOR UPDATE SKIP LOCKED` batching if multiple replicas.
3. SSO providers for tests are a local mock IdP speaking HS256; Entra/Google need only env config (issuer/auth/token/JWKS URLs) — the flow code is unchanged. JIT provisioning is **off** unless `SSO_<NAME>_JIT_ROLE` is set.
4. Push subscriptions: parents are blocked by the blanket read-only guard (they get email alerts/digests instead) — revisit only with the parent-replies policy change.
5. Playwright e2e still deferred (node:test + supertest + smoke cover the flows); fees/exams/transport remain 5.4.

## Step 5.4 — Fees (Paystack), exams, transport, load testing (complete 2026-10-01)

### What was built

**Database (`db/migrations/0003_fees_exams_transport.sql`):** 6 tables — `fee_invoices`, `fee_payments`, `exams`, `bus_routes`, `bus_stops`, `transport_assignments` — all `FORCE RLS`. Money is `bigint` **kobo** (NGN minor units, Paystack convention). Transport uniqueness is a *partial* index (`WHERE status='active'`) so a student's assignment history survives re-assignment. Fees are family-visible; writes are limited to `fees:write` roles + the webhook `service` actor; exam results reuse `grades(source_type='exam', source_id=exams.id)` so the existing release/revision machinery applies unchanged.

**Fees (`src/fees/fees.controller.ts`):** admin ledger, student `/fees/my`, guardian `/parent/children/:id/fees`, invoice create (unique per student+term+label), payment `initiate` (returns a Paystack reference; the production path calls *Initialize Transaction*), offline cash/transfer recording, and the **`POST /webhooks/paystack`** endpoint. The webhook is public (CSRF-exempt, signature-gated) and verifies **HMAC-SHA512 over the raw body** (`x-paystack-signature`) — `app.factory` captures `req.rawBody` via `express.json({ verify })` for exactly this. It's idempotent through the unique `gateway_ref`: a replayed `charge.success` returns `{duplicate:true}` and never double-credits. Every payment recomputes invoice status (`due → partial → paid`).

**Exams (`src/exams/exams.controller.ts`):** teachers schedule exams for their own sections only (gate 1 `outside_section_scope`, gate 2 RLS `exams_wr` via `is_section_staff`); students and guardians read the schedule. Results flow through the gradebook with `source_type=exam` + `source_id`.

**Transport (`src/transport/transport.controller.ts`):** routes + stops (admin-managed, `transport:write`), per-term student assignments (partial-unique), student `/student/transport` and guardian `/parent/children/:id/transport` read their own assignment.

**Web UI:** admin **Fees** (ledger + new-invoice form, Naira↔kobo), admin **Transport** (route/stop/assign forms), exam scheduling + exam-source grade picker in the teacher gradebook, and fees/exams/transport cards on the student dashboard and parent child page. Seed adds a ₦150,000 tuition invoice, a First-Term exam, and a bus route+stop+assignment for Sola.

**Load testing (`apps/api/loadtest/portal.js` + README):** k6 steady + spike scenarios over the hot paths (student/parent reads, teacher TOTP-gated reads — the script computes a real RFC-6238 code in-script). Thresholds: `http_req_failed<1%`, `p(95)<600ms`. Not run here (k6 isn't installed in the sandbox) — it's for CI/prod against managed Postgres.

### Verification

- **API suite: 34/34** (`npm test` — 8 new in `test/phase54.test.mjs`: family/admin fee visibility + teacher blocked, invoice create/duplicate/parent-read-only, **webhook unsigned→401, signed→applied, replay→duplicate (single credit)**, partial→paid cash flow, exam scheduling scoping + family read, exam grade through gradebook, transport read + admin assign/duplicate/capability-gate).
- **Web smoke: 43/43** (`npm run smoke -w @portal/web`, all through the BFF). The Paystack webhook check posts through the Next.js proxy and the HMAC still verifies — confirming the raw body survives the rewrite byte-for-byte.
- `next build` clean (24 routes); k6 script `node --check` clean.

### Deviations & production notes (5.4)

1. **Paystack Initialize** (checkout `auth_url`) is stubbed — `initiate` returns the reference; wiring the live `POST https://api.paystack.co/transaction/initialize` + secret key is a config step. The webhook half of the loop is fully functional and tested.
2. `PAYSTACK_SECRET` must be set in production (unset ⇒ webhook returns 503 `webhook_not_configured`); dev/smoke use `sk_test_dev_secret`.
3. Money is integer kobo end-to-end — no float currency anywhere (NGN correctness).
4. Transport "capacity" is recorded but not yet enforced against assignment count — flagged for the ops backlog.
5. Playwright e2e remains deferred (node:test + supertest + 43-check smoke cover the flows); k6 not executed in-sandbox.

## Phase 5 — complete

All four steps done and tested end-to-end:

| Step | Scope | API tests | Web smoke |
| --- | --- | --- | --- |
| 5.1 | Auth + database (RLS, MFA, idempotency) | 10 | — |
| 5.2 | Next.js 16 BFF + four role dashboards | — | 21 |
| 5.3 | Notifications worker, messaging, SSO, admin writes | 16 | 32 |
| 5.4 | Fees (Paystack), exams, transport, load tests | 8 | 43 |

Totals: **34 API tests**, **43 web smoke checks**, all green; 3 migrations, 26 tables.
