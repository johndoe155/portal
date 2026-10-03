# Production Readiness — Status & Roadmap

**Date:** 2026-10-01 · Responds to the production review of the same date.
Legend: ✅ fixed in this pass (with verification) · 🟡 partial / config-gated · 📋 backlog (design noted).

## Blockers — all fixed

| # | Finding | Fix | Verified by |
| --- | --- | --- | --- |
| 1 | In-memory PGlite loses data on restart | `DATABASE_URL` → node-postgres pool (Neon/Supabase/RDS); PGlite only as dev fallback. `db/bootstrap.sql` + `scripts/backup.sh` | API booted on real PG 17; restart kept data (same userId); `scripts/verify-pg.mjs` in CI |
| 2 | Migrations re-run every boot, no tracking | `schema_migrations` table + SHA-256 checksums; edited-after-apply = hard error; all files self-transactional | second boot logs "up-to-date"; verify-pg.mjs asserts |
| 3 | Demo accounts seeded with `Passw0rd!` | Demo seed gated behind `SEED_DEMO=true`, forbidden in production; one-time bootstrap admin from `BOOTSTRAP_ADMIN_*` env with password policy | phase6 suite; seedFromEnv guard |
| 4 | `APP_SECRET` hardcoded fallback | Production refuses to boot without ≥32-char non-placeholder secret | config.ts resolveAppSecret |
| 5 | MFA bypass via self-enroll | Enrollment requires admin-issued single-use 24 h token (`POST /users/:id/mfa-enroll-token`, `scripts/mfa-token.mjs` bootstrap); verify has replay protection (users.mfa_last_counter) + per-user rate limit | phase6: no-token 403, bad-token 403, replay 401, dup-factor 409; smoke |
| 6 | No rate limiting / lockout / headers | Sliding-window limiter on login/TOTP/forgot/reset/invite; DB-backed lockout (5 fails → 423, 15 min); helmet + locked-down CSP on API; CSP/XFO/nosniff/Permissions-Policy/HSTS(https) on web; `TRUST_PROXY` for req.ip | phase6 lockout test; smoke security-headers check |
| 7 | No account lifecycle | forgot → emailed 1 h token → reset (revokes sessions); self-service change-password; invite flow (admins never set passwords); policy: ≥12 chars, mixed classes, blocklist | phase6 + smoke invite/login |

## Before-launch items

| Finding | Status |
| --- | --- |
| SSO: link-by-email without `email_verified` | ✅ rejected unless IdP asserts verified |
| SSO: no nonce / PKCE | ✅ nonce in signed state verified against id_token; PKCE S256 on every authorization (mock IdP enforces both) |
| SSO: HS256 mock path in production | ✅ config throws on `*_HMAC_SECRET` when NODE_ENV=production (override: `SSO_ALLOW_INSECURE=true`) |
| Paystack Initialize not implemented | ✅ real `POST /transaction/initialize` (Bearer secret) → `checkout_url`+`access_code`; 502/503 on failure; `PAYSTACK_API_BASE` for test mocks. 2026-10-03: canonical `PAYSTACK_SECRET_KEY` (matching the runbook), `callback_url` + a `/fees/return` page so the payer is not stranded, and the charge currency comes from `school_settings` and is stored per payment (0016) instead of being hardcoded to NGN |
| Email/push sinks | ✅ email: real SMTP via nodemailer, production refuses to boot without `SMTP_URL`, branded templates, retry/dead-letter. Push: **removed** 2026-10-03 (migration 0015) — it had no client and silently marked undelivered notifications "sent" |
| Standalone worker PGlite-only | ✅ worker uses the same `DATABASE_URL` path as the API |
| Idempotency in-memory map | ✅ `idempotency_keys` table (survives restarts, shared across nodes), 24 h TTL sweep |
| No Dockerfile / CI / health / logging / error monitoring | ✅ multi-stage Dockerfile + compose (web = sole ingress); ✅ GitHub Actions CI — 7 jobs: build+API suite, real-PG migration proof (twice, for idempotency), `docker build`, backup→encrypt→restore drill, **web smoke** and **k6** (both added 2026-10-03; the docs had claimed k6 was a gate while nothing ran it), `npm audit`; ✅ `GET /api/v1/health` (public, db probe); 🟡 Nest logger levels via `LOG_LEVEL` (structured pino = backlog); 📋 Sentry hook (backlog) |
| Audit `rowHash` salted with random UUID | ✅ deterministic sha256 over canonical payload — recomputable, tamper-evident (phase6 verifies). Append-order chaining via prev_hash deferred: audit_log SELECT is admin/auditor/service-only under RLS, so non-admin writers cannot read the previous row to chain; needs a scoped SECURITY DEFINER helper |
| k6 never run | ✅ 2026-10-03: CI job `loadtest` installs k6, starts the API with load-test rate-limit ceilings and runs `PROFILE=ci` on every push. The full 50-VU + 300 req/s profile stays a manual run — a shared runner cannot measure a production SLO (see `apps/api/loadtest/README.md`) |
| Playwright e2e | 📋 backlog — node:test + supertest + 54-check smoke cover the flows |

## Promised-in-docs gaps

| Item | Status |
| --- | --- |
| Privacy policy / ToS / retention & export | ✅ `docs/legal/*` + in-product export `GET /users/:id/export` (exports:write) |
| Transport capacity enforcement | ✅ 409 `capacity_reached` on assign (phase6) |
| PII column encryption beyond TOTP | 📋 design: deterministic AES-256-GCM + HMAC blind index for lookup columns (email), envelope per-row keys from KMS; migration rewrites rows in batches |
| COPPA gate (under-13) | 📋 design: `users.date_of_birth` + guardian-consent flag at provisioning; block invite/SSO self-service for under-13s without verified guardian link. **The legal pages no longer claim this exists** (corrected 2026-10-03): the portal holds no DOB and no consent record, so it cannot identify under-13s, and `/legal/privacy` and `/legal/retention` now say so plainly instead of asserting "verified parental consent obtained at enrollment" |
| WebAuthn passkeys | 📋 backlog: `@simplewebauthn/server`, webauthn_credentials table, platform-authenticator-first for staff |
| WebSockets (live updates) | 📋 backlog: currently polling + digest; ws gateway for attendance/grade events |
| PWA / offline attendance | 📋 backlog: service worker + IndexedDB queue for teacher registers. The half-built Web Push server code was removed in 0015 rather than left in place; a PWA will bring its own subscription table when it is actually built |
| File storage (materials/uploads) | 📋 backlog: S3-compatible bucket, presigned URLs, MIME allowlist, per-object RLS via signed claims |

## Runbook essentials

- First boot: set `BOOTSTRAP_ADMIN_*` + `APP_SECRET` + `DATABASE_URL`; start API; `node scripts/mfa-token.mjs <admin-email>` → hand token over a trusted channel.
- Backups: `scripts/backup.sh` nightly (cron) + provider PITR; restore drill quarterly.
- Scaling: API/worker are stateless (rate limiter per-node; lockout/idempotency in DB) → horizontal scale behind the LB. `TRUST_PROXY` = number of proxies appending X-Forwarded-For in front of the API — compose default `2` (Caddy → web(Next) → api, see `docker-compose.yml` / `.env.example`); `1` only if TLS terminates directly in front of the API. A count that is too high lets clients spoof `req.ip` and dodge per-IP rate limits; too low lumps everyone behind one IP.

## Round-3 hardening (2026-10-01 review)

| Item | Status |
| --- | --- |
| PKCE verifier / OIDC nonce exposure | ✅ kept in `sso_flow` cookie only (httpOnly, 10 min, lax) — never in query strings |
| Entra nOAuth (unverified email claim) | ✅ email-claim JIT blocked unless IdP asserts `email_verified`; boot refuses `common`/`organizations` authority for Entra |
| Idempotency key stuck on failure | ✅ key released when the handler throws (in-tx delete) |
| Migrations racing on multi-node boot | ✅ `pg_advisory_lock` on a pinned connection around migration run |
| Invite link echoed to admin with SMTP configured | ✅ accept URL returned only when SMTP is absent (dev sink) |
| Paystack webhook amount trust | ✅ webhook amount/currency validated against the pending row; stored amount never overwritten; pending row reused instead of duplicated |
| Next.js rewrites for API proxying | ✅ replaced with `proxy.ts` (single request pipeline: CSP, nonce, CSRF, cookie hardening) |
| CSP for App Router | ✅ (round-3 shape superseded by round-4 below — see CSP entry there) |

## Round-4 hardening (2026-10-02 review)

| Item | Status |
| --- | --- |
| CSP incomplete — static pages bake a build-time nonce; request CSP header required | ✅ `proxy.ts` sets the `content-security-policy` request header (Next reads it per request for nonce) on every request; the six previously-static pages (`/forgot`, `/invite`, `/reset`, `/legal/*`) plus a new branded `/_not-found` are `force-dynamic`. Verified live: header nonce === inline-script nonce, fresh per request, on `/legal/privacy` and `/forgot` |
| Payment retry after abandoned checkout → 502 (Paystack rejects duplicate references) | ✅ `fee_payments.checkout_url` + `access_code` persisted at Initialize (migration `0006`); re-initiate on a pending row returns the stored checkout with no gateway call (phase54 + round4-live prove same reference/URL) |
| Partially paid invoices charged in full | ✅ initiate computes remaining = invoice − Σ(success payments); ≤ 0 → 409 `invoice_not_payable`; webhook settles only the remainder (phase54 + round4-live: 500k invoice, 200k cash, gateway charge = 300k) |
| Entra sign-in blocked for existing password users (nOAuth guard has no escape hatch) | ✅ callback issues a signed short-lived `link_token` and redirects to `/login?sso_error=sso_link_required`; `POST /auth/sso/link` (password + token) links the identity, session amr `pwd + sso-link`, audit `auth.sso_linked`; forged tokens → 403 `link_token_invalid` |
| Invites get stuck (lost email / wrong address) | ✅ admin console: `GET /directory/invites` (pending), `POST .../:id/resend` (rotates token — old link dies), `POST .../:id/revoke`; re-invite after revoke reuses the row (partial unique index allows one unaccepted row per email) |

Verification for round 4: 54/54 API tests · 54/54 web smoke · 17/17 `round4-live.mjs` on real Postgres 17 + running web/API/mock Paystack.

## Round-5 hardening (2026-10-02 review)

| Item | Status |
| --- | --- |
| `POST /auth/sso/link` skipped the account lockout (password oracle for whoever can make the IdP assert an email) | ✅ ssoLink now runs the SAME DB-backed lockout as login: `lockedUntil` check → 423 `account_locked`, failed attempts increment `failedLoginCount` (lock at 5 fails / 15 min), success resets; counters commit via the outcome pattern; audit `auth.login_failed` with `via: "sso-link"`. phase53 proves 5 wrong passwords → 6th attempt (correct password) 423 → normal login also 423 |
| Invite revoke had no role-tier check (registrar could revoke a school_admin's invite) | ✅ `assertCanGrant` on the stored roles — same rule as resend/issue; phase53: registrar (holds `directory:write`) gets 403 `role_above_your_tier` on an admin-tier invite, can still manage student invites |
| `TRUST_PROXY`: runbook said 1, compose defaulted to 2 | ✅ runbook aligned to compose default **2** (Caddy → web → api) with the counting rule documented in runbook + `.env.example` (too high ⇒ clients spoof `req.ip` and dodge per-IP limits) |
| Pending payments never expire — stored checkout could go stale | ✅ checkout reused only while fresh: `PAYSTACK_CHECKOUT_TTL_MS` (default 30 min); stale pendings get a fresh reference + Initialize and the row's `created_at` resets with the session (phase54 proves refresh + post-refresh stability). A payment landing on a superseded reference surfaces as webhook `unknown_reference` |
| Paystack HTTP call held a DB connection (inside the transaction) | ✅ three-phase flow: tx1 validates + prepares the pending row (advisory xact lock per invoice + in-process per-invoice queue), gateway call runs with NO transaction open, tx2 persists checkout + audit. Crash between phases leaves a checkout-less pending row → next initiate refreshes it |

Verification for round 5: 57/57 API tests (was 54) · 54/54 web smoke · 17/17 `round4-live.mjs` on real Postgres 17.

---

## Phase 6 — real-school bootstrap (2026-10-02)

Status: ✅ complete. The portal runs one real school with **no demo data**: bootstrap admin
(`BOOTSTRAP_ADMIN_*` + ops-CLI MFA token), school identity, academic years/terms, student/staff/
guardian/class/enrolment CSV import (dry-run + dedupe), guardian verification (email token or
office confirm, both audited), fee templates with idempotent generation, grading config, and a
reconciliation report as the go-live gate. Admin screens: Students, Academics, Import, Reports,
School; fee templates panel on Fees; `/parent/verify` for guardians. Decisions: ADR-013.
Operator guide: `docs/pilot-runbook.md`.

Verified by: `apps/api/test/phase55.test.mjs` (10), full suite **67/67**,
`apps/api/live/bootstrap-live.mjs` (**32/32** against an empty Postgres — bootstrap admin login →
TOTP → school settings → CSV school build → guardian verify + confirm → fee generation →
reconciliation → invited-student roster row), web smoke **56/56** (adds: login shows school
identity, demo card removed, verify page gated).

### Review round 6 — all five findings fixed (2026-10-02)

| # | Finding | Fix | Verified by |
| --- | --- | --- | --- |
| 1 | Grading scale/weights never read; report-card term guessed (`limit 1`) | `report-cards/generate` **requires** `term_id` (403 validation otherwise); generator reads `grading_config`, computes per-subject exam/coursework/weighted %, letter, point and overall average/GPA; scale + weights baked into the snapshot; letters render on student + parent report cards | phase56 (74% = 0.7·80 + 0.3·60 → B); phase53 term-required |
| 2 | Parents couldn't be bulk-imported | guardians CSV **auto-creates** the parent account when the email is unknown (`guardian_name` column, random password + emailed set-password link, parent role) and links it pending | phase56; bootstrap-live (3 parents) |
| 3 | CSV demanded plaintext passwords; nothing forced a change | `password` column optional → generated password + 24 h set-password link (import-then-invite); supplied passwords set `users.must_change_password` (0008) — middleware 403s `password_change_required` on everything except `/api/v1/auth` until changed (login/session carry the flag; `/change` page); scrypt hashing moved **outside** the import transaction | phase56 (both paths); bootstrap-live (5 students + teacher) |
| 4 | Invitee could pick grade/admission on accept | accept uses **invite values only**; missing grade → 422 `grade_level_required`; admission auto-numbers when the invite omits it — invitee body values ignored | phase56 (FAKE-1234 → `STU-####`) |
| 5 | Import results capped at 500 rows | every problem row returned (ok rows omitted except those carrying set-password links) | phase56 (600/600 listed) |

Suites after round 6: unit **75/75** · smoke **56/56** · bootstrap-live **39/39**.

---

## Phase 7 — go-live hardening (2026-10-03)

Status: ✅ complete. Plan and rationale: [`docs/go-live-plan.md`](./go-live-plan.md).

Phases 1–6 built a portal that demonstrates well. This phase fixed the places
where it made a promise it could not keep — the failures a school hits on day
one rather than the ones a reviewer finds in the code.

| # | What was wrong | What it is now |
| --- | --- | --- |
| A1 | `Dockerfile` line 27 had a trailing `#` on a `COPY`, so the image could never build | Fixed, and CI builds the image on every push so it cannot silently break again |
| A2 | Every email was `JSON.stringify(payload)` — a parent's password-reset arrived as a raw object dump | Branded HTML + plain-text templates per notification kind, rendered from school settings |
| A3 | No SMTP transport at all | Provider-agnostic nodemailer over `SMTP_URL`, connection verified at worker start-up, with the exact SPF/DKIM/DMARC records to publish in [`docs/email-setup.md`](./email-setup.md) |
| A4 | One SMTP hiccup set a notification to `failed` forever | Retry with jittered backoff (1→5→15→60→240→720 min), `dead` state when exhausted, dead-letter screen at `/admin/notifications` with requeue |
| A5 | Roster import sent the whole CSV as one JSON body — a real school's file hit the 1 MB cap and the proxy timeout | Multipart upload → background job with batching, progress polling, resumability, cancel, downloadable error CSV and one-time credentials CSV |
| A6 | Backups were unencrypted, local-only, 14 dumps, unscheduled and never restore-tested, while the runbook claimed otherwise | AES-256 encrypted nightly `pg_dump`, off-host upload with verification, 35-day retention, weekly restore drill into a throwaway database, both surfaced on `/api/v1/health` |
| A7 | The legal pages promised a purge, an erasure right and a DPO contact, none of which existed | Daily retention purge (audited, previewable, idempotent) · erasure as irreversible anonymisation with the statutory carve-out shown before committing · the configured DPO address rendered on `/legal/*`, with the absence of one stated plainly |
| B1 | No way to offboard anybody — a teacher who resigned kept working credentials | `/users/:id/offboard-preview` + reversible `deactivate`/`reactivate`, blocked on the last super admin |
| B2 | `audit:read` existed as a permission with nothing to read | `/admin/audit`: filters, readable actions, before/after, hash-chain verification, CSV export |
| B3 | Nothing for promotion or year rollover — the portal was a one-year tool | `/admin/academics` → End-of-year rollover: preview, per-pupil overrides, idempotent commit, undo |
| B4 | MFA enrolment tokens were issued one person at a time | Coverage view + bulk issue for everyone outstanding, email or printable sheet |
| C1–C4 | Only the zip was tracked; `npm test` failed on the supported Node; a high-severity drizzle advisory; no `.env.example` | Source tree committed, test command fixed, dependency bumped, every variable documented |
| C5 | Docs claimed a CI gate; there was no `.github/` | `.github/workflows/ci.yml`: build + test, migrations against real Postgres (twice, for idempotency), `docker build`, a full backup→encrypt→restore drill, `npm audit --audit-level=high` |
| C6 | The go-live checklist was prose in a runbook | `/admin/reports` → Go-live readiness: the same checklist, executed, with blocking vs advisory severity and a link to the fix |
| C7 | README/roadmap/runbook quoted stale test counts and backup behaviour that did not exist | Corrected throughout |

Suites after phase 7: API **229/229** · web smoke **56/56**.
