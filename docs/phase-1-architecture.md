# Phase 1 — Architecture & Tech Stack

**Project:** High School Portal (multi-persona: Admin / Teacher / Student / Parent)
**Document status:** Proposed — awaiting stakeholder approval
**Date:** 2026-10-01
**Author:** Principal Architect
**Companion files:** [`diagrams/system-architecture.svg`](diagrams/system-architecture.svg) · [`adr/phase-1-decisions.md`](adr/phase-1-decisions.md)

---

## 0. Executive summary

A **TypeScript-first modular monolith** behind an **edge-hardened BFF**:

- **Next.js 16 (App Router)** presentation layer with server-rendered, role-routed dashboards
- **NestJS 12** API (REST + OpenAPI + WebSocket gateway) enforcing RBAC in guards *and* in the database
- **PostgreSQL 18** as the single system of record, with Row-Level Security as the second, independent authorization gate
- **Redis + BullMQ** for caching, sessions, rate limiting and the notification pipeline
- **Federated identity** (Microsoft Entra ID / Google Workspace) with enforced MFA for staff, plus a separate email+passkey path for parents who are not in the school directory
- **Defense in depth on data:** TLS 1.3, KMS-backed AES-256-GCM envelope encryption for high-sensitivity PII, append-only audit log, 7-year transcript retention

Design target is a **multi-school-capable multi-tenant** deployment that can also run cheaply for a single campus.

---

## 1. Design assumptions and load profile

These numbers drive every sizing decision. **Confirm or correct them before Phase 2.**

| Dimension | Assumption |
| --- | --- |
| Tenancy | Single school to start, `school_id` on every table so a district/SaaS roll-out needs no schema change |
| Students | 1,500 – 5,000 (Tier A) · design ceiling 50,000 (Tier B) |
| Staff | 80 – 300 |
| Parents/guardians | 2× students, many-to-many with students |
| Courses/sections | 200 – 1,200 per academic year |
| Academic records written/term | ~40 grades/student/course + ~180 attendance rows/student |
| Concurrent users, normal | 200 – 600 |
| Concurrent users, peak | 3,000 (report-card release night) |

### Load spikes that actually shape the architecture

| Event | Shape | Architectural consequence |
| --- | --- | --- |
| 07:45–08:15 attendance | ~200 teachers × ~30 rows in a 10-minute window ≈ 6,000 writes/10 min | Bulk write endpoint (`POST /attendance:bulk`), one transaction per class, no per-row round trips |
| Deadline 23:59 | Assignment upload storm + bandwidth | Presigned direct-to-S3 uploads (files never transit the API box), async virus scan |
| Report-card night | 3,000 parents reading in ~2 hours | Precomputed report-card snapshots + CDN-cached, ETag'd responses; **never** compute GPAs live under this load |
| First bell | Every dashboard hits `GET /me` at once | Session + permissions cached in Redis; `stale-while-revalidate` |
| Nigeria/mobile reality | Intermittent 3G, frequent dropouts | Offline-first attendance (IndexedDB + sync queue), ≤150 KB initial JS budget, PWA installable |

---

## 2. Technology stack

### 2.1 Frontend

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | **Next.js 16 (App Router), React 19.2, TypeScript strict** | RSC keeps gradebook/roster data server-side (never ships full rosters to the client), `proxy.ts` gives a Node-runtime edge guard for auth checks before render. Next.js 16.3.x is the current stable line. |
| Styling / UI kit | **Tailwind CSS v4 + shadcn/ui (Radix primitives)** | Mobile-first utility model, accessible by default (focus traps, ARIA, keyboard nav), zero runtime CSS cost |
| Server state | **TanStack Query v5** | Cache invalidation per resource, optimistic updates for attendance ticks, `staleTime` tuning per role |
| Client state | **Zustand** | Tiny; holds only UI concerns (active term, selected class, drawer state) — never authoritative data |
| Large lists | **TanStack Virtual** | Gradebooks and rosters at 1,000+ rows stay at 60 fps on a mid-range Android |
| Forms / validation | **React Hook Form + Zod** | Zod schemas live in `packages/contracts` and are **shared with the API** — one source of truth |
| Offline / PWA | **Serwist (service worker) + IndexedDB (Dexie)** | Teachers mark attendance in a dead-signal classroom; queue and reconcile on reconnect |
| Charts | **Recharts** | Lightweight grade-distribution and trend visuals |
| Calendar | **FullCalendar** (or a purpose-built month/week grid) | Master events + per-student assignment calendar in one component |
| Testing | **Vitest + Testing Library + Playwright** (mobile viewport matrix) | E2E runs on 360×800 and 390×844 as first-class targets, not an afterthought |

### 2.2 Backend

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | **Node.js 24 LTS (Krypton)** | Current LTS line (24.21.0, Sep 2026). Note: Node 24 leaves *active* support 2026-10-20 and Node 26 enters LTS 2026-10-28 — we pin 24 for launch and schedule the bump to 26 LTS in Nov 2026 (tracked in the ADR). |
| Framework | **NestJS 12** | Ships ESM-first, Standard Schema validation (Zod on `@Body()`), `@nestjs/observe` for native tracing, and graceful shutdown. Its DI container, guards, interceptors and module boundaries map 1:1 onto our RBAC and domain modules. Requires Node ≥ 20.19. |
| API style | **REST + OpenAPI 3.1**, with a WebSocket gateway for messaging/notifications | Predictable per-resource caching, trivially auditable access logs, and a typed client generated into `packages/contracts`. GraphQL was considered and rejected — see ADR-002. |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | Type-safe but SQL-transparent: we need raw control for RLS `SET LOCAL` session variables, window functions on attendance, and zero-downtime expand/contract migrations. (Prisma is the fallback if the team prefers convention over control.) |
| Validation | **Zod (Standard Schema)** | Same schemas as the frontend |
| Jobs | **BullMQ on Redis** | Email/push fan-out, report-card generation, roster CSV import, absence digests — with retries, backoff and dead-letter queues |
| Realtime | **Socket.IO (Nest `@nestjs/websockets`) + Redis adapter** | Self-hosted deliberately: message bodies are education records; we do not want a third-party realtime SaaS as a data processor (FERPA vendor clause / NDPA sub-processor) |
| Search | **Postgres FTS + `pg_trgm`** first; Meilisearch when directory search needs typo tolerance | Don't add a search cluster before it earns its keep |
| Files | **S3-compatible object storage + presigned PUT/GET**, ClamAV scan worker | Uploads bypass the API; downloads are short-lived signed URLs (no public buckets, ever) |
| Email | **Amazon SES** (or Postmark) with SPF/DKIM/DMARC | Bounce/complaint suppression list is mandatory for a school mailing to thousands of parents |
| API docs | **Swagger UI + contract tests** | Auto-generated from decorators; contract test fails CI if the web app's generated client drifts |

### 2.3 Data

| Concern | Choice | Why |
| --- | --- | --- |
| Primary DB | **PostgreSQL 18.x** (18.6 is the current stable release; 19 is beta — not for production) | Relational integrity is non-negotiable for grades/enrollment; RLS gives us a second authorization layer; native `timestamptz`, ranges and JSONB cover scheduling and audit payloads |
| Read scaling | One **read replica** (report cards, analytics, parent reads) | Keeps the 23:59 write spike and report-card read storm off the same instance |
| Cache / sessions / queues | **Redis 7.x (or Valkey)** | Session store, permission cache, rate-limit counters, BullMQ |
| Object storage | **AWS S3** (or Cloudflare R2 for zero egress fees) | SSE-KMS encryption at rest, lifecycle policy to Glacier for prior-year submissions |
| Backups | Automated snapshots + **PITR**, 35-day hot retention, 7-year archive for transcripts | Schools cannot lose a transcript; restore is rehearsed quarterly |
| Analytics (later) | Read replica + materialized views; move to ClickHouse only past Tier B | |

### 2.4 Identity & security

| Concern | Choice | Why |
| --- | --- | --- |
| IdP federation | **Microsoft Entra ID** and/or **Google Workspace** via OIDC/SAML, federated through **Auth0** (Okta) or **Clerk**; **Keycloak** if the school requires self-hosting | One integration point per provider, centralized MFA policy, and a JIT-provisioning hook we control |
| Parent identity | **Email + password with WebAuthn/passkey upgrade**, invitation-token onboarding linked to verified students | Parents are almost never in the school's AD tenant; forcing them through Entra would fail on day one |
| MFA / 2FA | **Enforced for staff & admin** (IdP MFA accepted via `amr`/`acr`, otherwise in-app **TOTP or WebAuthn** step-up). Optional for parents. | Meets the stated constraint and survives IdP misconfiguration |
| Session | **BFF pattern**: opaque session id in Redis, `httpOnly` + `Secure` + `SameSite=Strict` cookie. **No JWT in localStorage.** | Kills the entire XSS-token-theft class of incidents |
| Secrets | **AWS KMS + Secrets Manager**, no secrets in env files or the repo | Envelope encryption keys, rotation, and access logging |
| Edge | **Cloudflare** (DNS, TLS 1.3, WAF, bot control, rate limiting) | Front door and DDoS absorber in front of everything |
| Observability | **OpenTelemetry → Grafana Cloud/CloudWatch**, **Sentry** for errors | Distributed traces across web → api → worker |
| Audit | **Append-only, hash-chained `audit_log`** table | FERPA "school official" access must be demonstrable after the fact |

### 2.5 Platform

| Concern | Choice |
| --- | --- |
| IaC | **Terraform** (state in S3 + DynamoDB lock) |
| CI/CD | **GitHub Actions** — lint → typecheck → unit → integration (Testcontainers) → build → migrate → deploy |
| Containers | **Docker, multi-arch (amd64/arm64)**, distroless runtime images |
| Runtime | **AWS ECS Fargate** (recommended) or EKS if the team already runs K8s. Low-ops alternative: Vercel (web) + Railway/Render (api/worker) + Neon/Supabase (Postgres) |
| DB hosting | **RDS for PostgreSQL, Multi-AZ**, encrypted with a customer-managed KMS key |
| Environments | `dev` → `staging` (**synthetic data only**) → `prod`, blue/green with automated rollback |
| Feature flags | **Unleash** or Flagsmith (self-hostable) |
| Load testing | **k6** — attendance spike and report-card read scenarios in CI |
| Security scanning | **npm audit / Snyk** in CI, **OWASP ZAP** baseline scan on staging, annual external pentest |

---

## 3. System architecture

### 3.1 Layered view

```
                                    USERS
   Admin ── Teacher ── Student ── Parent        (browser / PWA / phone)
      │         │          │         │
      ▼         ▼          ▼         ▼
┌─────────────────────────────────────────────────────────────────┐
│  EDGE  —  Cloudflare: DNS · TLS 1.3 · WAF · Bot mgmt · Rate lim │
└─────────────────────────────────────────────────────────────────┘
                              │  HTTPS only (HSTS preload)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PRESENTATION — Next.js 16 App Router (RSC + proxy.ts guard)    │
│                                                                 │
│   /admin   /teacher   /student   /parent   /login  /callback    │
│   Role-routed layouts · offline attendance · Web Push client    │
│                                                                 │
│   BFF: httpOnly session cookie, no bearer tokens in the browser │
└───────────────┬─────────────────────────────┬───────────────────┘
                │ REST /api/v1 (OpenAPI)      │ WSS (Socket.IO)
                ▼                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  API — NestJS 12 modular monolith                               │
│                                                                 │
│  Guards: JwtSessionGuard → RolesGuard → PolicyGuard (CASL)      │
│  Modules: identity · directory · academics · gradebook ·        │
│           attendance · assignments · calendar · messaging ·     │
│           notifications · reporting · admin                     │
│  Every DB tx: SET LOCAL app.user_id / app.role / app.school_id  │
└───┬───────────────┬───────────────┬──────────────┬──────────────┘
    │               │               │              │
    ▼               ▼               ▼              ▼
┌────────┐   ┌───────────┐   ┌────────────┐  ┌──────────────────┐
│Postgres│   │  Redis 7  │   │ S3 / R2    │  │ Socket.IO + Redis│
│ 18     │   │ cache ·   │   │ submissions│  │ adapter (WS fan- │
│ + RLS  │   │ sessions ·│   │ materials ·│  │ out across nodes)│
│ +replica│  │ BullMQ    │   │ exports    │  └──────────────────┘
└───┬────┘   └─────┬─────┘   └──────┬─────┘
    │              │                │
    │              ▼                ▼
    │      ┌───────────────────────────────────┐   ┌───────────────┐
    │      │ WORKERS — BullMQ consumers        │   │ Virus scan    │
    │      │ email · push · digests · report   │──▶│ (ClamAV)      │
    │      │ cards · roster import · retention │   └───────────────┘
    │      └───────────────┬───────────────────┘
    │                      ▼
    │              ┌───────────────┐   ┌───────────────────────┐
    │              │ SES / Postmark│   │ Web Push (VAPID/FCM)  │
    │              └───────────────┘   └───────────────────────┘
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  PLATFORM — Terraform · GitHub Actions (blue/green) · KMS ·     │
│  OTel traces · Sentry · Prometheus/SLO alerts · PITR backups    │
└─────────────────────────────────────────────────────────────────┘

                    EXTERNAL IDENTITY
   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐
   │ Microsoft Entra  │   │ Google Workspace │   │ Local: email │
   │ (staff + students)│  │ (staff + students)│  │ + passkey    │
   └────────┬─────────┘   └────────┬─────────┘   │ (parents)    │
            └──────────┬───────────┘             └──────┬───────┘
                       ▼ OIDC/SAML (Auth Code + PKCE)   │
              ┌──────────────────┐                      │
              │ Auth0 / Clerk /  │◀─────────────────────┘
              │ Keycloak         │   MFA: TOTP · WebAuthn
              └──────────────────┘
```

### 3.2 Why a modular monolith and not microservices

A school of 5,000 students generates single-digit thousands of requests per second at absolute peak. Splitting gradebook, attendance and messaging into separately deployed services would add network hops, distributed-transaction pain and on-call surface area for **zero** throughput benefit. Instead:

- Strict module boundaries inside NestJS (`imports`/`exports`, no cross-module table access)
- One **separate deployable** only where the workload genuinely differs: the **notification worker** (I/O-bound, bursty, must not block the API during a 3,000-parent fan-out) and the **file scanner**
- `packages/contracts` keeps module boundaries honest; extraction to a service later is mechanical, not archaeological

### 3.3 The two-gate authorization model

This is the single most important security decision in the system.

1. **Gate 1 — application:** `RolesGuard` checks role; `PolicyGuard` (CASL) checks capability + object ownership ("may this teacher write this grade for this student in this section?").
2. **Gate 2 — database:** every transaction opens with
   ```sql
   SET LOCAL app.user_id = $1; SET LOCAL app.role = $2; SET LOCAL app.school_id = $3;
   ```
   and every PII-bearing table carries an RLS policy that re-checks the predicate. A bug, a missed guard or a hand-written admin query **cannot** return another school's or another parent's child's record, because Postgres will not.

Parents get an additional narrowing: the policy restricts to students present in `student_guardians` with `can_view_grades = true`.

---

## 4. Authentication & authorization flow

### 4.1 Login sequence

```
Browser                Next.js (BFF)              NestJS API            IdP / Auth0
   │                        │                        │                      │
   │ GET /teacher           │                        │                      │
   ├───────────────────────▶│ no session cookie      │                      │
   │                        │ → 302 /login?next=…    │                      │
   │◀───────────────────────┤                        │                      │
   │ /login: "School account" | "Parent email"       │                      │
   ├───────────────────────────────────────────────────────────────────────▶│
   │      Authorization Code + PKCE, scopes: openid profile email           │
   │◀───────────────────────────────────────────────────────────────────────┤
   │ 302 /callback?code=…   │                        │                      │
   ├───────────────────────▶│ POST /auth/callback    │                      │
   │                        ├───────────────────────▶│ code → id_token      │
   │                        │                        ├─────────────────────▶│
   │                        │                        │◀─────────────────────┤
   │                        │                        │ 1. verify iss/aud/exp/nonce
   │                        │                        │ 2. identities(provider,subject) → user
   │                        │                        │    · staff: must pre-exist (no JIT)
   │                        │                        │    · parent: invite token + student link
   │                        │                        │ 3. status check (active/suspended/left)
   │                        │                        │ 4. MFA policy check (staff/admin)
   │                        │                        │ 5. create session row (hash, ttl, amr)
   │                        │◀───────────────────────┤
   │ Set-Cookie: sid (httpOnly, Secure, SameSite=Strict, __Host- prefix)    │
   │◀───────────────────────┤                        │                      │
   │ 302 → role home: /admin | /teacher | /student | /parent                │
   │◀───────────────────────┤                        │                      │
```

### 4.2 Rules that are not negotiable

| Rule | Detail |
| --- | --- |
| No JIT staff accounts | A teacher who is not in `users` cannot self-register by signing in with a school account. Admin (or SCIM/directory sync) provisions first. |
| Parent onboarding is invitation-only | Token is single-use, 72 h TTL, and bound to a verified student relationship; the parent must confirm at least one shared data point (student number + DOB) before linkage is confirmed. |
| MFA for staff/admin | Enforced at login; `sessions.amr` records how. Password reset forces MFA re-enrolment. |
| Session TTLs | Idle 30 min + absolute 12 h for staff/admin; idle 60 min + absolute 24 h for students; absolute 30 days with refresh rotation for parents. All revocable per-device from a "Your devices" screen. |
| No bearer tokens in the browser | `httpOnly` cookie only. The API rejects any `Authorization: Bearer` from a browser origin (native-app clients use a separate device flow, out of scope for v1). |
| RBAC redirect, not RBAC hiding | `proxy.ts` redirects an unauthorised role away from the route **before** render; the API enforces it again. Hiding a nav item is UX, never security. |
| Rate limiting | Per-IP + per-session limits; hard limits on `/auth/*`, `/messages`, and password-reset paths. |
| Full audit | Every login, MFA challenge, failed auth, permission-denied and PII read writes to `audit_log`. |

### 4.3 RBAC model (Phase 2 will formalise the tables)

- **Roles:** `super_admin`, `school_admin`, `registrar`, `counselor`, `teacher`, `teacher_assistant`, `student`, `parent`/`guardian`, `auditor` (read-only, compliance).
- **Permissions** are capability strings (`gradebook:write`, `attendance:read`, `message:send`, `user:manage`) granted to roles, evaluated against an object context (school → term → course section → student).
- **Multi-role users** (a teacher who is also a parent — very common) get an explicit role switcher; the session carries the **active** role, and switching re-issues the session so the audit trail is unambiguous.
- **Scope hierarchy** `school > academic_year > term > course_section > student` is the axis every policy check runs on.

---

## 5. Data protection

### 5.1 Encryption

| Layer | Mechanism |
| --- | --- |
| In transit | TLS 1.3 terminated at Cloudflare, re-encrypted to origin; HSTS with `preload`; internal traffic over private VPC subnets; no plaintext HTTP endpoints exist |
| At rest (infrastructure) | RDS storage encrypted with a customer-managed KMS key (AES-256); S3 `SSE-KMS`; EBS volume encryption; Redis on private subnets with AUTH + TLS |
| At rest (application, PII) | **AES-256-GCM envelope encryption** in the app layer for high-sensitivity fields, using a KMS-issued data-encryption key per record, stored alongside the ciphertext |

**Field-level encryption scope** (Phase 2 will mark these in the schema): national ID / passport / NIN, date of birth, home address & phone, medical/allergy/health notes, counselling or special-education flags, custody and legal documents, guardian identity documents.

**Searchability:** encrypted columns are not queryable, so each carries a deterministic `*_bidx` HMAC-SHA256 blind index column for exact-match lookups (e.g. find a student by national ID). Ranges and fuzzy search on encrypted data are out of scope by design — if you need to search it, it is not sensitive enough to encrypt.

**Key hierarchy & rotation:** KMS CMK (annual rotation) → per-table DEK (90-day rotation) → per-record IV. Rotation is a background job that re-encrypts in place; no downtime.

### 5.2 Retention and rights

| Data | Retention |
| --- | --- |
| Transcripts / final grades | **Permanent** (archived, encrypted, restorable) |
| Attendance, coursework grades | 5 years after graduation, then archive |
| Assignment files | Current year + 1, then Glacier → delete after 3 |
| Messages | 24 months, then hard delete |
| Audit log | 7 years, append-only |
| Deleted students (GDPR/NDPA erasure) | **Suppress, don't purge**, where statutory retention applies — flag the record, encrypt-and-shred the PII, keep the anonymised academic row so the transcript stays valid |

### 5.3 Operational security

- Least-privilege IAM; break-glass admin access is time-bound, logged and requires two-person approval
- `staging` contains **only** synthetic data — never a copy of prod
- Secrets rotation on a schedule; dependency and container scanning in CI; SBOM per release
- Quarterly **restore rehearsal** (a backup you have never restored is not a backup)
- Incident runbook with a 72-hour regulator-notification path (FERPA SPP0 / NDPC)

---

## 6. Compliance mapping

| Obligation | Where it lands in this architecture |
| --- | --- |
| **FERPA** — parents/eligible students may inspect records within 45 days | Admin "Student record export" produces a complete, human-readable PDF + machine-readable JSON of every education record we hold |
| **FERPA** — no disclosure of PII without consent or an exception | Every external integration is a signed DPA listing it as a "school official with legitimate educational interest"; the vendor list is user-visible |
| **FERPA** — directory-information opt-out | `directory_info_opt_out` flag on `students`; every directory/roster/announcement query filters on it |
| **FERPA** — right to request amendment | Amendment-request workflow with an immutable audit trail on the original value (never overwrite silently) |
| **FERPA** — annual notification | Templated annual notice, tracked per household with delivery receipts |
| **COPPA** — under-13 | Most high-school students are 13+, but feeder campuses and early entrants are not. A computed `is_under_13` flag gates: verifiable parental consent before account activation, **zero** third-party trackers/ad-tech on any student-facing page, no analytics that build behavioural profiles, no social sharing |
| **WCAG 2.2 AA / Section 508** | shadcn/Radix primitives, ≥4.5:1 contrast, 44 px touch targets, full keyboard paths, screen-reader-tested dashboards, `axe` in CI |
| **Nigeria NDPA 2023 + GAID 2025** *(applies if the school is in Nigeria)* | Lawful basis recorded per processing activity; DPIA filed with the NDPC **before** any cross-border transfer; 72-hour breach notification; named DPO; annual Compliance Audit Return; data-subject rights (access, rectification, erasure §37, portability §39) implemented as first-class API endpoints |
| **NDPA cross-border transfer (§§41–43)** | If hosting outside Nigeria: documented adequacy assessment, NDPC-approved SCCs, transfer register. See the region decision below. |
| **SOPIPA-style vendor restrictions** | No sale of student data, no targeted advertising, no third-party data sharing — contractual *and* enforced by having no ad/analytics SDKs in the student bundle |

> **Region decision (needs your input).** AWS Cape Town (`af-south-1`) keeps data on the African continent and simplifies the NDPA transfer story but has a thinner service catalogue (no Fargate parity in some services, fewer managed options). `eu-west-1` has full service parity and strong adequacy arguments but requires a documented cross-border transfer instrument for Nigerian data subjects. Both are viable; the answer changes the Terraform, not the application.

---

## 7. Non-functional requirements & SLOs

| Metric | Target |
| --- | --- |
| Availability (06:00–22:00 local, term time) | **99.9%** |
| RPO / RTO | **5 min / 1 h** |
| API p95 latency | **< 300 ms**; p99 < 800 ms |
| Web LCP on 3G mid-range Android | **< 2.5 s**; initial JS ≤ **150 KB** gz |
| Attendance bulk write (30 rows) | < 500 ms |
| Report-card page under 3,000 concurrent | p95 < 1 s (served from snapshot + CDN) |
| Message delivery (in-app + push) | < 5 s p95 |
| Deploy → live | < 10 min, zero-downtime, automated rollback on error-rate breach |

---

## 8. Repository layout

```
portal/
├── apps/
│   ├── web/            # Next.js 16 App Router + BFF
│   ├── api/            # NestJS 12 (REST + WS gateway)
│   └── worker/         # BullMQ consumers (email, push, reports, imports)
├── packages/
│   ├── contracts/      # Zod schemas + generated OpenAPI client (shared)
│   ├── ui/             # shadcn components, design tokens, mobile nav
│   ├── policy/         # CASL ability definitions (shared by web + api)
│   └── config/         # eslint, tsconfig, tailwind presets
├── db/
│   ├── migrations/     # drizzle-kit, expand/contract only
│   ├── policies/       # RLS policy SQL, reviewed separately from app code
│   └── seed/
├── infra/
│   ├── terraform/      # vpc, ecs, rds, redis, s3, kms, cloudfront
│   └── docker/
├── docs/               # ← you are here
└── .github/workflows/  # ci.yml, deploy-staging.yml, deploy-prod.yml
```

---

## 9. Delivery phases & effort (indicative)

| Phase | Scope | Effort (2 senior devs) |
| --- | --- | --- |
| 0 | Foundations: monorepo, CI, Terraform skeleton, design tokens, a11y baseline | 1.5 wks |
| 1 | Identity: SSO, local auth, MFA, sessions, RBAC + RLS, role dashboards shells | 3 wks |
| 2 | Directory & enrollment: users CRUD, rosters, CSV import, guardians linkage | 2 wks |
| 3 | Academics: courses/sections, timetable, gradebook, report cards | 4 wks |
| 4 | Attendance: daily register, offline mode, absence alerts | 2.5 wks |
| 5 | Assignments: posting, submissions (S3), grading, late/missing tracking | 3 wks |
| 6 | Calendar, announcements, notifications pipeline (email + push) | 2.5 wks |
| 7 | Messaging (teacher ↔ parent), threading, read receipts | 2 wks |
| 8 | Compliance tooling: record export, amendment requests, audit viewer, retention jobs | 2 wks |
| 9 | Hardening: load tests, pentest remediation, DR rehearsal, docs, training | 2 wks |
| | **Total** | **~24 wks** |

A meaningful pilot (identity + directory + attendance + gradebook + announcements) ships at **week 10**.

---

## 10. Top risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| RLS policy error leaks cross-tenant data | Critical | Policies live in `db/policies/`, reviewed by a second engineer, and covered by a dedicated test suite that asserts **denial** for every role/pair |
| Parent identity onboarding fails at scale (thousands of invitations, mistyped emails) | High | Bulk invite with SMS/email fallback, self-service "link my child" with verification challenge, support tooling for staff |
| Report-card night melts the API | High | Precomputed snapshots generated by the worker hours in advance; CDN + ETag; read replica; queue the export generation |
| Teachers in low-connectivity classrooms can't take attendance | High | Offline-first register with conflict-free sync (server wins on conflict, teacher is notified) |
| Grade-integrity dispute ("my grade was changed") | High | Grade history table — every change is a new row with actor, timestamp, old/new value; UI shows the timeline |
| FERPA/NDPA misstep on a third-party integration | High | No integration ships without a signed DPA and a data-flow entry; student bundle contains no third-party scripts |
| Node/Next major-version churn mid-project | Medium | Pin exact versions in the lockfile; scheduled upgrade window each term break, never mid-term |
| Scope creep into full SIS (fees, transport, library, exams board) | Medium | Explicit v1 boundary; the schema is designed to admit these later without migration trauma |

---

## 11. Decisions needed before Phase 2 — ✅ RESOLVED 2026-10-01

1. **Tenancy** → single school. 2. **Identity** → both Entra and Google Workspace. 3. **Hosting** → eu-west-1, Managed PaaS (with NDPA transfer instruments). 4. **Parents** → read-only. 5. **Scope** → fees/exams/transport in v1.
Consequences recorded in [`adr/phase-1-decisions.md`](adr/phase-1-decisions.md) ADR-009/010; schema in [`phase-2-database-schema.md`](phase-2-database-schema.md).

---

## Sources checked (2026-10-01)

- Next.js 16.3.1 current stable; App Router, React 19.2, Turbopack default, `proxy.ts` replaces `middleware.ts` — https://tech-insider.org/nextjs-tutorial-app-router-13-steps-2026/ ; https://www.buildmvpfast.com/blog/nextjs-app-router-vs-pages-router-saas-2026
- PostgreSQL 18.6 latest stable (2026-08-13); 19 in beta; 14 EOL 2026-11-12 — https://www.postgresql.org/ ; https://versionlog.com/postgresql/
- NestJS 12 released 2026-08-28 (ESM-first, Standard Schema, `@nestjs/observe`, Node ≥ 20.19/22.12) — https://trilon.io/blog/nestjs-12-is-now-available
- Node.js 24 LTS 24.21.0; active support ends 2026-10-20, EOL 2028-04-30; Node 26 enters LTS 2026-10-28 — https://latestat.com/nodejs/24 ; https://eosl.date/eol/product/nodejs/
- FERPA: 34 CFR part 99 remains operative; ED rulemaking RIN 1875-AA15 targeted NPRM 01/2026 and final action 05/2026, no confirmed final amendment as of Sep 2026 — https://studentprivacy.ed.gov/ferpa ; https://www.reginfo.gov/public/do/eAgendaViewRule?pubId=202504&RIN=1875-AA15
- Nigeria NDPA 2023 + GAID 2025: cross-border transfers §§41–43, DPIA filing, 72-hour breach notification, annual Compliance Audit Return — https://iclg.com/practice-areas/data-protection-laws-and-regulations/nigeria/ ; https://globallawexperts.com/nigeria-data-protection-compliance-2026/
