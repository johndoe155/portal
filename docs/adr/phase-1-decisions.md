# Architecture Decision Records — Phase 1

Status key: **Accepted** = agreed, build it · **Proposed** = awaiting sign-off · **Superseded** = replaced.

---

## ADR-001 — TypeScript everywhere with a shared contracts package
**Status:** Proposed · **Date:** 2026-10-01

**Context.** Four personas, dozens of endpoints, and a hard requirement that a grade field renamed in the API cannot silently break a parent's dashboard.

**Decision.** One language (TypeScript, strict) across web, API and worker. Zod schemas live in `packages/contracts`; the API validates with them (NestJS 12 Standard Schema support) and the web app imports the same objects. The OpenAPI spec is generated from the API and a typed client is generated back into `contracts`; a CI job fails if the generated client drifts from the checked-in one.

**Alternatives.** Separate Python/Go backend (rejected: two type systems, hand-maintained contracts); GraphQL codegen (see ADR-002); hand-written REST types (rejected: guaranteed drift).

**Consequences.** One toolchain to maintain and one CI config. A schema change fails the build on both sides, which is the point. Cost: the web app pulls in a package it does not fully use.

---

## ADR-002 — REST + OpenAPI over GraphQL
**Status:** Proposed

**Context.** The brief permits either. The data is highly relational and the access patterns are known in advance (a gradebook grid, an attendance register, a report card).

**Decision.** REST with OpenAPI 3.1. Aggregated dashboard reads use purpose-built read endpoints (`GET /students/:id/report-card`) that return exactly the shape the screen needs.

**Alternatives.** GraphQL: attractive for parent/student dashboards, but it needs its own authorization layer (object-level, per-field), which conflicts with our "RLS is the second gate" model — an RLS policy cannot see a GraphQL field selection. It also makes query-cost limiting and access-log auditing harder, and both matter for FERPA.

**Consequences.** Slightly chattier clients on dashboard pages, mitigated by coarse read endpoints. Much easier auditing and authorization.

---

## ADR-003 — Authorization enforced twice: CASL guards + PostgreSQL RLS
**Status:** Proposed

**Context.** The highest-consequence failure in this product is a parent seeing another child's record. Application-layer checks alone have a single point of failure: a developer forgetting one.

**Decision.** Every request passes `RolesGuard` → `PolicyGuard` (CASL ability over a school/term/section/student context). Every database transaction then sets `SET LOCAL app.user_id / app.role / app.school_id` and RLS policies re-evaluate the predicate. Service-role access bypassing RLS is a named, logged, audited exception used only by the worker.

**Alternatives.** ORM-level scoping middleware only (rejected: bypassable by any raw query); API-gateway policy (rejected: cannot see object ownership).

**Consequences.** Policies must be written twice conceptually — mitigated by a shared `policy/` package that generates both the CASL abilities and the RLS predicates from one definition. Every policy needs a **denial** test, not just an allow test.

---

## ADR-004 — BFF with httpOnly session cookies, no bearer tokens in the browser
**Status:** Proposed

**Context.** A school portal is a high-value XSS target (thousands of minors' records). Any token readable by JavaScript is a token that can be exfiltrated by one compromised dependency.

**Decision.** The IdP's tokens never reach the browser. The BFF exchanges the authorization code server-side and issues an opaque session id in a `__Host-`, `httpOnly`, `Secure`, `SameSite=Strict` cookie. Sessions live in Redis, so revocation is immediate and per-device.

**Alternatives.** SPA with JWT in localStorage (rejected: XSS-exfiltrable, no server-side revocation); JWT in an httpOnly cookie (workable, but revocation needs a blocklist — opaque ids are simpler).

**Consequences.** The web and API must share a first-party origin or use a same-site cookie domain; cross-origin third-party embedding is out. Native mobile apps would need a separate device-authorization flow.

---

## ADR-005 — Field-level AES-256-GCM envelope encryption for high-sensitivity PII
**Status:** Proposed

**Context.** The brief requires AES-256 for PII at rest. Disk-level encryption (RDS/SSE-KMS) protects against stolen hardware but not against a compromised application credential or an over-broad `SELECT *`.

**Decision.** Infrastructure-level encryption everywhere, **plus** application-level AES-256-GCM with a per-record data key from KMS for: national ID/passport, DOB, address & phone, health/medical notes, counselling and special-education flags, custody/legal documents. Each encrypted column gets a deterministic HMAC-SHA256 blind index for exact-match lookup.

**Alternatives.** `pgcrypto` inside the DB (rejected: keys live near the data, and DBAs/backups see plaintext); disk-only encryption (insufficient for the stated requirement).

**Consequences.** No range queries or `LIKE` on encrypted fields; the blind index leaks equality patterns, which is accepted for national IDs that are already unique. Key rotation becomes a real job that must be tested.

---

## ADR-006 — Self-hosted realtime (Socket.IO) rather than a managed push service
**Status:** Proposed

**Context.** Threaded teacher↔parent messages and grade-change notifications are education records under FERPA and personal data under NDPA. Using a third-party realtime SaaS makes it a data processor requiring a DPA and a sub-processor disclosure.

**Decision.** Socket.IO with the Redis adapter, running inside our VPC. Message bodies are stored in Postgres; the transport carries only ephemeral events.

**Alternatives.** Ably/Pusher (faster to ship, but adds a processor for PII); polling (rejected: unacceptable latency for chat).

**Consequences.** We own websocket scaling and reconnection logic. The Redis adapter keeps this to a solved problem at our scale.

---

## ADR-007 — Modular monolith with exactly two extracted services
**Status:** Proposed

**Context.** Peak load is a few thousand requests per second. Microservices would add failure modes without adding capacity.

**Decision.** One NestJS API process with strict module boundaries; separately deployed: `worker` (BullMQ consumers — bursty, must never block request handling) and `scanner` (ClamAV, resource-spiky).

**Consequences.** Simpler operations and one deploy pipeline. Extraction later is mechanical because modules never touch each other's tables.

---

## ADR-008 — Runtime version policy
**Status:** Proposed

**Context.** Node and Next.js both moved majors in 2026; a project that starts today will outlive one support cycle.

**Decision.** Pin **Node 24 LTS** (24.21.0) for launch — supported with security fixes to 2028-04-30 — and schedule the bump to **Node 26 LTS** in November 2026, after Node 26 enters LTS on 2026-10-28. **PostgreSQL 18.x** (18.6); do not adopt 19 until it leaves beta. **Next.js 16.3.x**; **NestJS 12**. Upgrades happen only in term breaks, never mid-term, and every pin is exact in the lockfile with Renovate PRs gated on green CI.

**Consequences.** One planned upgrade per term break, budgeted. No surprise major-version churn during exam periods.

---

## ADR-009 — Scope & tenancy decisions received 2026-10-01
**Status:** Accepted (stakeholder)

**Context.** Five open questions blocked Phase 2. Stakeholder answers received.

**Decisions.**
1. *Single school* → no `school_id` columns; RLS keyed on role + ownership. Reversal to multi-school is additive (nullable column → backfill → `NOT NULL`), no data migration trauma.
2. *Both Entra and Google Workspace* → `identities.provider ∈ {local, entra, google}`; same verified email links to one `users` row.
3. *Region eu-west-1/us-east-1, Managed PaaS* → see ADR-010.
4. *Parents read-only* → enforced in CASL policies, not schema. `messages.author_id` stays generic so enabling parent replies later is a policy flip, zero migrations. Original brief's threaded teacher↔parent messaging preserved as teacher-authored threads readable by verified guardians.
5. *Fees, exams, transport in v1* → +11 tables (Fees 5, Exams 3, Transport 3).

**Consequences.** Schema in Phase 2 reflects all five. Report-card night, fee reminders and exam timetables are now first-class v1 workloads.

---

## ADR-010 — Managed PaaS hosting in eu-west-1 with NDPA transfer instruments
**Status:** Accepted (stakeholder) · **Date:** 2026-10-01

**Context.** Stakeholder chose managed PaaS over self-operated ECS, and an EU/US region over `af-south-1`. Verified availability: Vercel serves `dub1` = eu-west-1 Dublin; Supabase projects run on AWS eu-west-1; Neon offers an EU region but is US-headquartered (Databricks), so the US CLOUD Act reaches it regardless of data location.

**Decision.** Primary region **eu-west-1 (Ireland)** for its GDPR adequacy profile and latency to Nigeria. Stack: **Vercel** (web, region dub1) · **Supabase or Neon** (Postgres 16+, RLS) · **Upstash** (Redis) · **Railway/Render** (NestJS API + worker containers) · **Cloudflare R2** (objects). Because Nigerian data subjects' PII resides outside Nigeria, the NDPA 2023 Part VIII obligations are satisfied operationally: DPIA filed with the NDPC before go-live, NDPC-aligned SCCs signed with every PaaS processor, a maintained cross-border transfer register (§41(2)), and the annual Compliance Audit Return. PaaS PITR windows are shorter than self-managed RDS, so a nightly encrypted `pg_dump` to R2 with 35-day retention is mandatory.

**Alternatives.** `af-south-1` self-managed (rejected by stakeholder); us-east-1 (acceptable fallback — weaker adequacy argument, keep SCCs identical).

**Consequences.** Lower ops burden; compliance shifts from infrastructure choices to paperwork + DPAs, which is budgeted in Phase 9 hardening. Neon's US headquarters is acceptable only because SCCs + encryption-at-rest apply regardless; if the NDPC later issues a restrictive determination, the schema is provider-neutral and can move to Supabase/eu or a local host without application changes.

---

## ADR-011 — Phase-2 open items resolved (2026-10-01)
**Status:** Accepted

1. **Paystack primary, Flutterwave fallback, manual for cash/POS.** Nigerian card/bank/USSD coverage; webhook contract identical shape for both; server-side verification + `gateway_ref` idempotency.
2. **Exam moderation via `grade_revisions.reason='moderation'`** — no schema change, full audit timeline preserved.
3. **Transport levy auto-invoiced** on assignment (worker adds the route `fee_item` line to the current-term invoice).
4. **`comment_bank`** table added (Phase-2 §3.13) for reusable report-card comments.

**Consequences.** Fees module is parent-self-service *initiate-only*: parents get a checkout URL from the gateway; they never write payment rows. API layer returns `403 parent_read_only` on any mutating verb before policy evaluation.

---

## ADR-012 — Frontend topology & state strategy (2026-10-01)
**Status:** Accepted

**Context.** Web lives on Vercel, API on Railway: different origins. `__Host-` cookies cannot be shared cross-origin, and shipping bearer tokens to the browser is forbidden (ADR-004).

**Decisions.**
1. Same-site subdomains `app.portal.example` / `api.portal.example`; Vercel **rewrites** `/api/v1/**` to the API over the private network → REST stays first-party, no CORS.
2. Socket.IO authenticates with a **one-time 30 s ticket** minted by the BFF (`POST /realtime/ticket`); the socket never carries PII payloads (triggers only).
3. RSC first paint via an internal service client; interactive screens use TanStack Query against the rewritten base.
4. Purpose-built calendar grid over FullCalendar (3 typed event sources, ~300 KB saved).
5. State split: TanStack Query (server truth) · Zustand (UI) · RHF+Zod (forms) · Dexie outbox (offline attendance/grade drafts, server-wins conflicts).

**Consequences.** Cookie security posture preserved across managed-PaaS split; offline attendance works in low-connectivity classrooms; missed socket events degrade to stale cache, never wrong data.

---

## ADR-013 — Real-school bootstrap: portal as system of record (2026-10-02, phase 6)
**Status:** Accepted (pilot scope: one school)

**Context.** The app must run a real school without the demo seed: identity, calendar, roster, guardian links, fees and grading all created by the school itself, from CSV exports of whatever spreadsheet/SIS they use today. A two-way SIS integration is out of scope for the pilot.

**Decisions.**
1. **The portal becomes the authoritative system of record once CSV import commits.** Imports dedupe (admission no / email / enrolment tuple) so re-running a corrected file is safe; dry-run validates without writing (sentinel rollback). A read-only SIS sync connector is backlog until a real SIS contract exists — until then, exports are re-imported.
2. **Bootstrap admin, no demo data in production.** `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` creates the first super_admin (audited `auth.bootstrap_admin`); its MFA enrollment token comes from the ops CLI (`scripts/mfa-token.mjs`), never an HTTP endpoint. `SEED_DEMO=true` is refused when `NODE_ENV=production`.
3. **Guardian verification is two-path:** emailed single-use token (self-service, `/parent/verify`) **or** office confirmation by an admin (`POST /guardian-links/:id/confirm`, audited with `method`). Both paths require a verified link before any child data is visible (enforced in RLS, not the handler).
4. **Single-authority config rows.** `school_settings` and `grading_config` are single-row tables (id=1) written via the SERVICE actor under `settings:write`; grading scale is stored sorted by `min_pct` descending so every consumer reads the same order.
5. **Invited students always land with a `students` row** (grade from invite or accept body, auto `STU-####` admission if absent) — an account without a roster record can never be fee- or grade-visible.

**Consequences.** Go-live for a school = runbook (`docs/pilot-runbook.md`), not a data-migration project. Cost: any later SIS must treat the portal as upstream or a reconciliation step is required — flagged in the reconciliation report, which is the pilot's acceptance gate.
