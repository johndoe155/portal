# Phase 3 — API Design

**Project:** High School Portal · **Status:** Proposed — awaiting approval · **Date:** 2026-10-01
**Builds on:** [`phase-1-architecture.md`](phase-1-architecture.md) · [`phase-2-database-schema.md`](phase-2-database-schema.md)

REST + OpenAPI 3.1 for reads/writes, **Socket.IO** for realtime events, **webhooks** for payment gateways.
Role legend: `SA` super_admin · `A` school_admin · `R` registrar · `C` counselor · `T` teacher · `TA` assistant · `S` student · `P` parent · `AU` auditor.

---

## 0. Phase-2 open items — resolved

| # | Item | Resolution |
| --- | --- | --- |
| 1 | Payment gateway | **Paystack primary** (dominant NG card/bank/USSD coverage), Flutterwave fallback, `manual` for cash/POS. Webhook contract in §7 covers both. |
| 2 | Exam moderation | No new columns. Moderation = grade change with `grade_revisions.reason = 'moderation'`; full timeline retained. |
| 3 | Transport levy auto-invoice | **Yes** — `POST /students/{id}/transport` enqueues a worker that adds the route's `fee_item` line to the student's current-term invoice. |
| 4 | Report-card comment bank | `comment_bank` table added (Phase-2 §3.13 addendum). |

---

## 1. Conventions

### 1.1 Transport & versioning
- Base `https://portal.school.example/api/v1`. Breaking changes → `/v2` with 12-month overlap; deprecations announced via `Deprecation` + `Sunset` headers.
- JSON only (`Content-Type: application/json`), UTF-8. Dates ISO-8601 (`timestamptz` → `2026-10-01T07:30:00Z`). Money as `{ "amount": "150000.00", "currency": "NGN" }` (strings, never floats).
- **No bearer tokens.** AuthN = `__Host-sid` httpOnly cookie. Mutating requests additionally require `X-CSRF: <token>` (double-submit; token in a non-httpOnly cookie set by BFF). API rejects mutations without it (403 `csrf_missing`).
- `GET /healthz`, `GET /readyz`, `/metrics` live **outside** `/api/v1`, unexposed to the internet (internal LB only).

### 1.2 Envelopes
```jsonc
// single resource → raw object
{ "id": "0192…", "student_user_id": "…", "points": "18.00", "max_points": "20.00", "released_at": null }

// collections
{ "data": [ … ], "meta": { "page": 1, "per": 25, "total": 412, "sort": "-created_at" } }

// errors → RFC 9457 problem+json
{ "type": "https://portal.school/errors/validation", "title": "Validation failed",
  "status": 422, "code": "grade_exceeds_max",
  "detail": "points (25.00) exceeds max_points (20.00)",
  "errors": [{ "pointer": "/grades/2/points", "message": "…" }],
  "trace_id": "0192abc…" }
```

### 1.3 Query params (all collections)
`page` (1-based), `per` (default 25, max 100), `sort` (`-created_at`, comma-list), `q` (trgm search on named fields per resource), plus named filters (`?status=active&grade_level=10`). Unknown params → 400 (typo safety).

### 1.4 Idempotency & concurrency
- `Idempotency-Key` (UUID, 24 h replay window) **required** on: `POST /sections/{id}/attendance`, `POST /sections/{id}/grades/bulk`, `POST /payments/record`, `POST /invoices/generate`. Replay returns the original response.
- Optimistic concurrency on contested resources: `If-Match: <version>` on `PATCH /grades/{id}`, `PATCH /invoices/{id}`; mismatch → 409 with current state.

### 1.5 Caching
- All PII reads: `Cache-Control: private, no-store`.
- Aggregated dashboards & calendars: `ETag` + `Cache-Control: private, max-age=30, stale-while-revalidate=120`; clients send `If-None-Match`, server returns 304. Report-card PDFs: immutable, `max-age=31536000` (content-addressed URL).

### 1.6 Rate limits (per session unless noted)
| Scope | Limit |
| --- | --- |
| Global | 300 req/min |
| `/auth/*` | 10/min per IP, 30/min per session |
| `POST /files/presign` | 60/min |
| `POST /conversations/*/messages` | 30/min (anti-harassment) |
Bulk writes capped at 500 rows per request. 429 carries `Retry-After`.

### 1.7 Authorization mechanics
Every route declares `@Roles(...)` + a CASL ability; RLS is the backstop (Phase-2 §4). Parent role: **no mutating verb exists on any parent-scoped route** — the router itself returns 403 `parent_read_only` before policy evaluation, so the invariant holds even if a policy regresses.

### 1.8 Audit & observability
Mutations and PII reads emit `audit_log` rows (actor from session, IP/UA from edge). Every response carries `X-Trace-Id`; OTel spans per controller→service→query.

---

## 2. Endpoint catalogue

### 2.1 Auth & session (14)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /auth/providers` | Enabled IdPs + parent-email login flag | public |
| `GET /auth/{provider}/start?next=` | Begin OIDC Auth-Code+PKCE | public |
| `GET /auth/callback` | Code exchange, identity link, MFA step-up, issue session | public |
| `POST /auth/logout` | Revoke session | any |
| `GET /auth/session` | Principal, roles, active role, MFA state | any |
| `POST /auth/role/switch` | Re-issue session with new active role (multi-role users) | any |
| `GET /auth/devices` · `DELETE /auth/devices/{id}` | List / revoke sessions | any (self) |
| `POST /auth/mfa/totp/enroll` → `POST /auth/mfa/totp/verify` | TOTP enrollment (staff enforced) | any |
| `POST /auth/mfa/webauthn/options` → `…/verify` | Passkey ceremony | any |
| `POST /auth/password/forgot` · `POST /auth/password/reset` | Local-account recovery (rate-limited, no user enumeration) | public |
| `POST /auth/parent-invite/redeem` | Single-use token + verification challenge → account + guardian link | public |

### 2.2 Admin — directory & enrollment (27)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /users` · `POST /users` · `GET /users/{id}` · `PATCH /users/{id}` · `DELETE /users/{id}` | User CRUD (soft delete) | A R (read+create), A (mutate) |
| `POST /users/import` · `GET /imports/{id}` | Async CSV roster import (job status) | A R |
| `GET /users/{id}/roles` · `POST /users/{id}/roles` · `DELETE /users/{id}/roles/{rid}` | Role assignment / revocation | SA A |
| `GET /students` · `GET /students/{id}` · `PATCH /students/{id}` | Student profiles (PII decrypted per-role) | A R C T(own sections) |
| `GET /students/{id}/guardians` · `POST /students/{id}/guardians/invite` | Links; invite issues 72 h token | A R |
| `GET /staff` · `POST /staff` · `PATCH /staff/{id}` | Staff profiles | A R |
| `GET /departments` · `POST` · `PATCH /departments/{id}` | CRUD | A R |
| `POST /students/{id}/record-export` · `GET /record-exports/{id}` | FERPA 45-day right: full record PDF+JSON | A R (+parent self-request via support) |
| `POST /students/{id}/amendments` · `PATCH /amendments/{id}` | Record amendment workflow | A R; resolve: A |
| `POST /consents` · `GET /consents?student=` | Consent ledger (COPPA/directory/media) | A R C P(self-child) |

### 2.3 Academics structure (19)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /academic-years` · `POST` · `PATCH /academic-years/{id}` | Year mgmt; `POST …/activate` flips `is_current` | A |
| `GET /terms` · `POST /terms` | | A |
| `GET /courses` · `POST` · `PATCH /courses/{id}` | | A R |
| `GET /sections?term=` · `POST /sections` · `GET /sections/{id}` · `PATCH /sections/{id}` | Section CRUD | A R; read: T/S/P scoped |
| `PUT /sections/{id}/meetings` | Replace weekly meeting pattern | T(own) A |
| `POST /sections/{id}/staff` · `DELETE /sections/{id}/staff/{uid}` | Assign teacher/assistant | A |
| `GET /sections/{id}/roster` · `POST /sections/{id}/roster` · `DELETE /sections/{id}/roster/{sid}` | Enrollment bulk add / drop | A R |
| `GET /grade-scales` | | all staff |

### 2.4 Teacher workspace (22)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /teacher/today` | My sections meeting today + register status (v_teacher_today) | T TA |
| `GET /sections/{id}/attendance?date=` | Register state | T(own) |
| `POST /sections/{id}/attendance` | **Bulk upsert** (draft), idempotent; ≤ class size rows | T(own) |
| `POST /sections/{id}/attendance/finalize` | Lock register → triggers absence notifications | T(own) |
| `GET /sections/{id}/gradebook` | Students × items grid (weights, released flags) | T(own) |
| `POST /sections/{id}/grades/bulk` | Upsert grades (writes `grade_revisions`), idempotent | T(own) |
| `PATCH /grades/{id}` | Single correction (revision + audit; `If-Match`) | T(own) A |
| `GET /grades/{id}/history` | Revision timeline | T(own) A AU |
| `POST /sections/{id}/grades/release` | Release gate → notifies students+parents | T(own) |
| `GET /sections/{id}/assignments` · `POST` · `PATCH /assignments/{id}` | Authoring (draft) | T(own) |
| `POST /assignments/{id}/publish` | Visible to students; calendar view picks it up | T(own) |
| `GET /assignments/{id}/submissions` · `GET /submissions/{id}` | Grading queue | T(own) |
| `POST /submissions/{id}/grade` | Points + feedback → grade row + notification | T(own) |
| `GET /comment-bank?category=` · `POST /comment-bank` | Reusable comments | T |
| `POST /conversations` · `POST /conversations/{id}/messages` · `POST /conversations/{id}/close` | Teacher→parent threads | T |
| `GET /conversations?mine=1` | My threads | T P(read) |

### 2.5 Student workspace (9)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /student/schedule` | Weekly timetable (view) | S |
| `GET /student/calendar` | Events ∪ dues ∪ exams (view) | S P |
| `GET /student/grades` | Released grades by section/term | S P(self-child) |
| `GET /student/attendance` | Own register history | S P |
| `GET /student/assignments` | Due/missing/graded, with late flags | S P |
| `POST /files/presign` | `{kind, parent_entity}` → presigned PUT (S3/R2, 15 min) | S T A |
| `POST /assignments/{id}/submissions` | `{file_ids[], attempt}` — files must be `scan=clean` | S |
| `GET /student/exam-timetable` | My exams (published periods only) | S P |
| `GET /student/fees` | Invoices + balance (v_fee_balance) | S P |

### 2.6 Parent workspace (6 — **GET only**)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /parent/children` | Linked students (verified guardians) | P |
| `GET /parent/dashboard` | Per child: attendance-today, unreleased-hidden grade summary, balance, next deadlines (ETag) | P |
| `GET /parent/children/{id}/report-cards` · `GET /report-cards/{id}` | Snapshot + immutable PDF | P S(self) A |
| `GET /conversations/{id}/messages` | Read teacher threads | P(participant) |
| `GET /parent/children/{id}/transport` | Route, stops, pickup times | P S |

Any `POST/PUT/PATCH/DELETE` under a parent-scoped route → `403 parent_read_only` (§1.7).

### 2.7 Exams (9)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /exam-periods` · `POST` · `POST /exam-periods/{id}/publish` | Period lifecycle | A; publish: A |
| `GET /exam-periods/{id}/exams` · `POST /exams` · `PATCH /exams/{id}` | Exam + room/time (timetable source) | A; T(own section) |
| `GET /exams/{id}/scores` · `POST /exams/{id}/scores/bulk` | Mark entry | T(own) |
| `POST /exams/{id}/release` | Mirror into `grades(source_type=exam)` + notify | T(own) A |

### 2.8 Fees (13)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /fee-items` · `POST` · `PATCH /fee-items/{id}` | Fee catalogue per term/grade | A |
| `POST /invoices/generate` | `{term_id, scope: all|grade|students[]}` idempotent job | A |
| `GET /invoices?status=` · `GET /invoices/{id}` | | A R P(self-child) S(self) |
| `POST /invoices/{id}/void` | With audit + reason | A |
| `POST /payments/record` | Manual/cash entry (idempotent) | A R |
| `GET /payments?invoice=` | | A R |
| `POST /payments/intent` | Paystack/Flutterwave init → `{gateway_url}` for parent self-service *view-initiated* pay (parent never writes DB; gateway does) | P S |
| `POST /webhooks/payments/{gateway}` | Provider callback (§7) | gateway (signature) |
| `GET /student/fees` / `GET /parent/fees` | Balance views | S P |

### 2.9 Transport (7)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /routes` · `POST` · `PATCH /routes/{id}` | Route mgmt | A |
| `PUT /routes/{id}/stops` | Replace ordered stops | A |
| `POST /students/{id}/transport` | Assign → **enqueues levy auto-invoice** (§0) | A R |
| `DELETE /students/{id}/transport` | End assignment (`ended_at`) | A R |
| `GET /routes/{id}/manifest` | Students per stop (driver sheet, PII-minimised) | A T(driver-staff) |

### 2.10 Calendar, announcements, notifications (15)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /events?scope=` · `POST` · `PATCH /events/{id}` · `DELETE /events/{id}` | Master calendar | A (write); all (scoped read) |
| `GET /announcements?scope=` · `POST` · `PATCH /announcements/{id}` · `POST /announcements/{id}/publish` | Board | A T (write) |
| `GET /notifications` · `POST /notifications/{id}/read` · `POST /notifications/read-all` | Bell | any |
| `GET /notification-preferences` · `PUT /notification-preferences` | Per kind × channel | any |
| `POST /push/subscribe` · `DELETE /push/subscribe/{id}` | Web Push keys | any |

### 2.11 Compliance & ops (8)
| Method & path | Purpose | Roles |
| --- | --- | --- |
| `GET /audit?entity=&actor=&from=&to=` | Hash-chained trail viewer | A AU SA |
| `GET /audit/verify` | Re-compute chain integrity | AU SA |
| `GET /role-permissions` | Matrix for admin UI | SA A |
| `PUT /role-permissions` | Edit capabilities (invalidates CASL cache) | SA |

≈ **149 endpoints**. OpenAPI generated from Nest decorators; the generated client is diffed against `packages/contracts` in CI (ADR-001).

---

## 3. Representative payloads

**Bulk attendance (offline-sync friendly):**
```jsonc
POST /api/v1/sections/0192s1/attendance   Idempotency-Key: 7f3c…
{ "date": "2026-10-01",
  "records": [ { "student_user_id": "0192u7", "status": "present" },
               { "student_user_id": "0192u9", "status": "absent", "note": "no excuse call" } ],
  "client_rev": 4 }                       // offline queue revision; server wins conflicts
→ 200 { "session_id": "0192a1", "status": "draft", "conflicts": [] }
```

**Gradebook bulk upsert:**
```jsonc
POST /api/v1/sections/0192s1/grades/bulk
{ "items": [ { "student_user_id": "0192u7", "source_type": "custom", "label": "CA Test 1",
               "points": "18.00", "max_points": "20.00", "weight_pct": "15.00" } ] }
→ 200 { "written": 1, "revisions": 1 }    // every overwrite produced a revision row
```

**Problem example (guard failure):**
```jsonc
403 { "type": "…/errors/forbidden", "code": "outside_section_scope",
      "detail": "User is not staff on section 0192s4", "trace_id": "0192t9" }
```

---

## 4. Realtime contract (Socket.IO)

- Handshake: same `__Host-sid` cookie; server resolves session → joins **personal room** `u:{id}` plus role rooms; parents additionally join `g:{studentId}` rooms for each verified child.
- Events are **triggers, not payloads**: `{ id, kind, entity, at }` only — clients refetch via REST. No PII crosses the socket (FERPA/NDPA posture, ADR-006).

| Event | Emitted on | Rooms |
| --- | --- | --- |
| `notification.created` | any notification row | `u:{target}` |
| `message.created` / `conversation.closed` | messaging writes | teacher + `g:{student}` (guardians) |
| `attendance.finalized` | finalize | `g:{student}` for absentees, section teacher |
| `grade.released` / `grade.changed` | release / correction | `u:{student}` + `g:{student}` |
| `fee.payment_received` | webhook success | `g:{student}` |
| `announcement.published` / `event.changed` | publish | role/audience rooms |
| `report_card.ready` | worker done | `g:{student}`, `u:{student}` |

Reconnect: exponential backoff + jitter; on reconnect client refetches `GET /notifications?since=` — sockets are an optimisation, REST is the source of truth.

---

## 5. Notification trigger matrix (worker)

| Trigger | Audience | Channels (respect prefs) |
| --- | --- | --- |
| Attendance finalized with `absent` | parents | email + push, immediate |
| Grade released / changed | student + parents | push; email digest 17:00 |
| Assignment due ≤24 h | student | push |
| Missing submission (due+24 h, none) | student + parents | email daily digest |
| Invoice issued / overdue | parents | email + push |
| Payment succeeded | parents | email receipt |
| Message from teacher | parents | push + email |
| Announcement / event published | scoped audience | push (+email if pinned) |
| Exam timetable published | students + parents | email + push |
| Report card ready | students + parents | email + push |

---

## 6. File upload & scan sequence

```
Student            Web (BFF)              API                 S3/R2            Worker(ClamAV)
  │ POST /files/presign {kind:submission,assignment} │                    │                 │
  ├──────────────────────────────────────────────▶│                    │                 │
  │                      │ policy: enrolled & not past-grace            │                 │
  │◀────────── { upload_url, file_id } ────────────┤                    │                 │
  │ PUT bytes ───────────────────────────────────────────────────────▶│                 │
  │ POST /assignments/{id}/submissions {file_ids}  │                    │                 │
  ├──────────────────────────────────────────────▶│ scan_status=pending│                 │
  │                      │ 422 if any file not clean yet ("processing")│                 │
  │                      │                          │ s3:ObjectCreated ────────────────▶│
  │                      │                          │                    │  scan → files.scan_status
  │                      │                          │◀── ws notification.created ───────┤ (clean → submission becomes submittable)
```

Downloads: `GET /files/{id}/download` → 302 to 15-min presigned GET, only if `scan_status=clean` and RLS read passes.

---

## 7. Payment webhooks (Paystack primary)

```
POST /api/v1/webhooks/payments/paystack
Headers: x-paystack-signature = HMAC-SHA512(rawBody, secret)
1. constant-time signature verify (403 on mismatch, no body parse first)
2. enqueue job; respond 200 within 2 s (provider retries otherwise)
3. worker: call Paystack `GET /transaction/{ref}` (never trust webhook body alone)
4. idempotency: payments.gateway_ref unique → duplicate = 200 no-op
5. on success: create payment + allocations (FIFO to student's open invoices),
   flip invoice status, audit row, emit fee.payment_received + receipt email
```
Flutterwave identical shape (`flw-signature`, verify endpoint). Manual payments bypass webhooks via `POST /payments/record`.

---

## 8. Dashboard aggregates (ETagged)

| Route | Composition | Freshness |
| --- | --- | --- |
| `GET /dashboards/admin` | enrollment counts, attendance-today %, fee collection %, pending approvals | 60 s |
| `GET /dashboards/teacher` | today's periods, ungraded submissions, absentees to follow up | 30 s |
| `GET /dashboards/student` | today's classes, due-this-week, latest released grades, balance | 30 s |
| `GET /parent/dashboard` | per-child rollup from §2.6 | 30 s |

Backed by the Phase-2 views + Redis-cached counters; **never** ad-hoc joins under peak load.

---

## 9. Security & compliance checkpoints in the API layer

- Every route: `SessionGuard → CsrfGuard(mutations) → RolesGuard → PolicyGuard` then RLS.
- PII decryption happens **after** RLS select, in the service, per field-level policy (`medical_notes_enc` only for `C/A/nurse-staff`).
- `GET /users` & rosters filter `directory_opt_out` for non-staff roles.
- Under-13 students: responses strip optional profile fields for non-privileged roles; COPPA consent checked at account activation.
- Export endpoints stream from a worker (never inline 5k-row selects) and log `record_export` audit events with row counts.
- All error bodies are PII-free (no echoes of other users' data on 403/404 — 404 for hidden resources to avoid existence leaks).

---

## 10. Test contract

- **Contract tests**: OpenAPI spec ↔ generated client diff in CI (fails build on drift).
- **Policy tests**: for every endpoint × role: expected status (200/403/404) via Testcontainers-seeded fixtures, including the parent "no mutating verbs" sweep.
- **k6 scenarios** (CI nightly): attendance spike (200 teachers × 30 rows/5 min), report-night (`/parent/dashboard` 3k VUs), webhook burst.
- **ZAP baseline** on staging per release; auth fuzz (cookie tamper, CSRF absent, role-switch escalation attempts).
