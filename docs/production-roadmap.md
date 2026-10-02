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
| Paystack Initialize not implemented | ✅ real `POST /transaction/initialize` (Bearer secret, NGN kobo) → `checkout_url`+`access_code`; 502/503 on failure; `PAYSTACK_API_BASE` for test mocks |
| Email/push sinks | 🟡 unchanged dev sinks; production = set `SMTP_URL` + `VAPID_*` (documented in .env.example) |
| Standalone worker PGlite-only | ✅ worker uses the same `DATABASE_URL` path as the API |
| Idempotency in-memory map | ✅ `idempotency_keys` table (survives restarts, shared across nodes), 24 h TTL sweep |
| No Dockerfile / CI / health / logging / error monitoring | ✅ multi-stage Dockerfile + compose (web = sole ingress); ✅ GitHub Actions CI (build, tests, real-PG migration proof, smoke); ✅ `GET /api/v1/health` (public, db probe); 🟡 Nest logger levels via `LOG_LEVEL` (structured pino = backlog); 📋 Sentry hook (backlog) |
| Audit `rowHash` salted with random UUID | ✅ deterministic sha256 over canonical payload — recomputable, tamper-evident (phase6 verifies). Append-order chaining via prev_hash deferred: audit_log SELECT is admin/auditor/service-only under RLS, so non-admin writers cannot read the previous row to chain; needs a scoped SECURITY DEFINER helper |
| k6 never run | 🟡 script + CI step added; requires running servers (not executed in this sandbox — k6 absent) |
| Playwright e2e | 📋 backlog — node:test + supertest + 54-check smoke cover the flows |

## Promised-in-docs gaps

| Item | Status |
| --- | --- |
| Privacy policy / ToS / retention & export | ✅ `docs/legal/*` + in-product export `GET /users/:id/export` (exports:write) |
| Transport capacity enforcement | ✅ 409 `capacity_reached` on assign (phase6) |
| PII column encryption beyond TOTP | 📋 design: deterministic AES-256-GCM + HMAC blind index for lookup columns (email), envelope per-row keys from KMS; migration rewrites rows in batches |
| COPPA gate (under-13) | 📋 design: `users.date_of_birth` + guardian-consent flag at provisioning; block invite/SSO self-service for under-13s without verified guardian link |
| WebAuthn passkeys | 📋 backlog: `@simplewebauthn/server`, webauthn_credentials table, platform-authenticator-first for staff |
| WebSockets (live updates) | 📋 backlog: currently polling + digest; ws gateway for attendance/grade events |
| PWA / offline attendance | 📋 backlog: service worker + IndexedDB queue for teacher registers |
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
