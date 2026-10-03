# High School Portal — Project Documentation

Secure, mobile-first, multi-persona portal for **Admin · Teacher · Student · Parent**.

## Documentation index

| Phase | Document | Status |
| --- | --- | --- |
| 1 | [Architecture & Tech Stack](docs/phase-1-architecture.md) | **Approved 2026-10-01** (decisions in ADR-009/010) |
| 1 | [System architecture diagram (SVG)](docs/diagrams/system-architecture.svg) | Approved |
| 1 | [Architecture Decision Records](docs/adr/phase-1-decisions.md) | ADR-001…013 |
| 2 | [Database schema & ER model](docs/phase-2-database-schema.md) | **Approved 2026-10-01** |
| 2 | [ER diagram (SVG)](docs/diagrams/er-diagram.svg) | Approved |
| 3 | [API design (REST/OpenAPI + WebSocket + webhooks)](docs/phase-3-api-design.md) | **Approved 2026-10-01** |
| 4 | [Frontend component tree & state strategy](docs/phase-4-frontend-design.md) | **Approved 2026-10-01** |
| 5 | [Implementation log](docs/phase-5-implementation.md) (auth + DB + web + notifications/messaging/SSO + fees/exams/transport, tested) | **Complete 2026-10-01 — steps 5.1–5.4 done (34 API tests, 43 web checks)** |
| 6 | [Production roadmap & review response](docs/production-roadmap.md) | **Hardened 2026-10-01** — real Postgres + tracked migrations, bootstrap admin, MFA/lockout/rate-limit, password lifecycle, SSO PKCE+nonce, Paystack Initialize, Docker/CI/health |
| 6 | **Review round 2 — all findings fixed 2026-10-02** | Role-grant hierarchy (privilege-escalation fix), CSP per-request nonce middleware, NAT-friendly rate limits (per-email strict / per-IP generous), PGlite fatal in production, MFA recovery codes + admin reset, invite-based admin UI, parent-pay exception, SSO httpOnly flow cookie + oid/tid linking + per-provider email_verified, health 503 on DB-down, encrypted outbox tokens, atomic idempotency, migration advisory lock, Caddy TLS in compose, NOLOGIN portal_app, k6 as a real CI gate, prod-only Docker image, in-app legal pages (48 API tests, 54 web checks) |
| 6 | [Privacy policy](docs/legal/privacy-policy.md) · [Terms](docs/legal/terms-of-service.md) · [Retention & export](docs/legal/data-retention.md) | FERPA/COPPA/NDPA-aligned · in-app at `/legal/*` (templates — need lawyer review) |
| 6 | [Real-school bootstrap — pilot runbook](docs/pilot-runbook.md) (ADR-013) | **Complete 2026-10-02** — one real school, zero demo data: bootstrap admin + ops-CLI MFA, school identity, years/terms, CSV import (dry-run + dedupe) for students/staff/guardians/classes/enrolments, guardian verification (email token **or** office confirm), fee templates with idempotent generation, grading config, reconciliation report as go-live gate · new admin screens: Students/Academics/Import/Reports/School · **67 API tests · 56 web smoke checks · 32/32 live bootstrap checks on an empty DB** |
| 7 | [Go-live plan](docs/go-live-plan.md) — the production-readiness pass | **Complete 2026-10-03** — the portal is operable by a school, not just demonstrable. Docker build fixed · real branded email templates over SMTP with SPF/DKIM/DMARC records and retry-with-backoff + dead-letter screen · roster import as a resumable background job (multipart upload, batching, progress, error CSV) · encrypted off-host backups with a weekly restore drill surfaced on `/api/v1/health` · offboarding, audit-log screen, academic-year rollover and bulk two-factor onboarding · retention purge and right-to-erasure that match the published legal pages · go-live readiness checks · CI (`.github/workflows/ci.yml`) · **229 API tests · 56 web smoke checks** |

## What state this is in

Phases 1–6 built the product. **Phase 7 (`docs/go-live-plan.md`) made it
operable**: the gap that mattered was not missing features but promises the
product did not keep — emails that were raw JSON dumps, backups that did not
match their runbook, legal pages describing a purge and an erasure right that
did not exist, and an import that fell over on a real school's roster.

Before a real school uses this, work through
[`docs/pilot-runbook.md`](docs/pilot-runbook.md) and get
**/admin/reports → Go-live readiness** green. It executes the runbook's
checklist — SMTP, backups, restore drill, DPO address, two-factor coverage,
calendar, roster — and blocks on the things that genuinely cannot wait.

Five things only the school can do, listed in the go-live plan: publish the
SPF/DKIM/DMARC records, supply `SMTP_URL`, provision the backup bucket and
`BACKUP_ENCRYPTION_KEY`, have a lawyer review the legal templates, and provide
the real roster.

## Running it

```bash
npm install && npm run build

# ── dev (PGlite in-memory, demo seeds) ────────────────────────────────
SEED_DEMO=true COOKIE_SECURE=false PAYSTACK_SECRET=sk_test_dev_secret \
  PAYSTACK_API_BASE=http://127.0.0.1:9311 npm start -w @portal/api
MOCK_PAYSTACK_STANDALONE=1 node apps/api/test/mock-paystack.mjs 9311 &
API_INTERNAL=http://127.0.0.1:8080 npm start -w @portal/web   # → :3000

# ── production-shaped (real Postgres + bootstrap admin) ───────────────
psql -f db/bootstrap.sql                      # roles + db (or compose init)
DATABASE_URL=postgres://portal_owner:…@host/portal \
APP_SECRET="$(openssl rand -base64 48)" NODE_ENV=production \
BOOTSTRAP_ADMIN_EMAIL=admin@school.example BOOTSTRAP_ADMIN_PASSWORD=… \
  node apps/api/dist/main.js
node scripts/mfa-token.mjs admin@school.example   # first-admin TOTP token (out-of-band)

# ── containers (Caddy terminates TLS and is the only exposed service) ─
docker compose up --build                     # https://localhost (PORTAL_DOMAIN)

# ── tests ─────────────────────────────────────────────────────────────
npm test                                      # 229 API tests
npm run smoke -w @portal/web                  # 56 web checks (servers up)
node apps/web/test/round4-live.mjs            # 17 live checks on the running stack (fresh DB)
```

Every environment variable the stack reads is documented in [`.env.example`](.env.example).

## Phase 1 at a glance

- **Frontend:** Next.js 16 (App Router) · React 19.2 · TypeScript strict · Tailwind v4 + shadcn/ui · TanStack Query · Serwist PWA with offline attendance
- **API:** NestJS 12 modular monolith · REST + OpenAPI 3.1 · Socket.IO gateway · BullMQ workers
- **Data:** PostgreSQL 18 + Row-Level Security · Redis 7 (sessions, cache, queues) · S3/R2 for files · read replica
- **Identity:** Microsoft Entra ID / Google Workspace via OIDC + PKCE · local email+passkey for parents · MFA (TOTP/WebAuthn) enforced for staff
- **Security:** BFF httpOnly session cookies · TLS 1.3 · AES-256-GCM envelope encryption on PII columns with HMAC blind indexes · append-only audit log
- **Compliance:** FERPA · COPPA under-13 gate · WCAG 2.2 AA · Nigeria NDPA 2023 + GAID 2025 where applicable

## Decisions received (2026-10-01) — locked for v1

1. Single school · 2. Both Entra **and** Google Workspace · 3. eu-west-1, Managed PaaS · 4. Parents read-only · 5. Fees/exams/transport **in** v1.
Full consequences: [`docs/adr/phase-1-decisions.md`](docs/adr/phase-1-decisions.md) (ADR-009, ADR-010).
