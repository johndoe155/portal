# School Portal — Data Retention & Export Process

**Effective:** 2026-10-01 · Owner: Registrar + DPO · Basis: NDPA 2023 §39(5)(d) (storage limitation), FERPA record-keeping, Nigerian statutory education requirements.

## 1. Retention schedule

| Data class | Retention | Trigger for deletion/anonymisation |
| --- | --- | --- |
| Identity & credentials (active) | Life of account | — |
| Identity (leavers) | **Not automatic.** Anonymisation of leavers is disabled unless the school sets `RETENTION_LEAVER_ANONYMISE_DAYS` | leaver status set |
| Grades, exams, report cards (FERPA education records) | 5 years after graduation/exit, then anonymise scores to aggregates | statutory window expiry |
| Attendance | 3 years after exit | statutory window expiry |
| Enrolments / sections / schedules | 5 years (academic-record integrity) | window expiry |
| Fee invoices & payments | 7 years (tax/audit) | window expiry |
| Messages (teacher↔guardian) | 2 years after thread close, or on safeguarding hold | window expiry |
| Notifications outbox | 90 days after delivery/final failure | rolling |
| Sessions | 24 h expiry; expired/revoked rows purged after 30 days | rolling |
| Audit log | 7 years (tamper-evident; append-only) | window expiry |
| Password-reset / invite / enrollment tokens | 1 h / 7 d / 7 d TTL; spent rows purged after 30 days | rolling |
| Uploaded roster files & import jobs | 30 days after the job finishes (file deleted from disk too) | rolling |
| Replay-protection (idempotency) keys | 7 days | rolling |
| Email preferences | Held with the account; cleared on erasure | with account |
| Backups | 35 days daily, encrypted, weekly restore test (provider PITR beyond that) | rolling |

## 2. Purge mechanism

The purge runs daily in the worker (`startRetentionLoop`, `apps/api/src/retention/retention.service.ts`). Each run writes a `retention_runs` row and a `retention.purge` audit entry with per-table counts, so the schedule above is demonstrable rather than aspirational. Administrators can preview or trigger a run at **/admin/retention**; `POST /api/v1/admin/retention/run` defaults to a dry run.

Windows are overridable per deployment: `RETENTION_NOTIFICATIONS_DAYS`, `RETENTION_SESSIONS_DAYS`, `RETENTION_TOKENS_DAYS`, `RETENTION_IDEMPOTENCY_DAYS`, `RETENTION_IMPORT_JOBS_DAYS`, `RETENTION_LEAVER_ANONYMISE_DAYS`.

Live data is never purged regardless of age: a notification still queued for delivery, an unexpired session, an unused invitation and an import job still running are all excluded. Statutory records (marks, attendance, enrolments, fees, report cards, audit log) are outside the job entirely.

Anonymisation keeps aggregate statistics (class averages) while removing direct identifiers, preserving the school's statistical obligations without personal data.

### Open item for the school to confirm

Leaver anonymisation is **off by default**. This document previously said leaver identities are anonymised 90 days after leaving, while the in-product policy page said student accounts are kept for enrolment + 5 years. Those cannot both be true, and a school still needs to issue transcripts for former pupils. The window is therefore a deliberate configuration decision: set `RETENTION_LEAVER_ANONYMISE_DAYS` once the school has confirmed how long former pupils' identities must be kept.

## 3. Data-subject export (right of access / portability)

- **NDPA §34 / FERPA §99.10:** a data subject (or guardian of a minor) may request their data at any time.
- **In-product:** `GET /api/v1/users/:id/export` (capability `exports:write`) returns the complete personal-data bundle as JSON: profile, roles, identities, session metadata, guardian links, academic records, fees, transport, messaging, notifications, and the subject's audit trail. Credentials and secrets are excluded by design.
- **SLA:** acknowledge within 7 days; deliver within 30 days (NDPA §36). Exports are logged (`user.exported` audit action).
- **Format:** JSON; conversion to CSV/PDF available on request.

## 4. Erasure requests

Erasure is honoured except where a statutory retention window applies (education/tax records above); in that case processing is restricted and the data is kept without a named subject until the window expires.

- **Preview:** `GET /api/v1/users/:id/erasure-preview` lists exactly what will be removed and what must be retained, with the basis for each. Shown to the administrator before anything is done.
- **Execute:** `POST /api/v1/users/:id/erasure` (capability `directory:write`, requires the account's email address typed back as confirmation). Irreversible.
- **What happens:** sign-in identities, credentials, MFA secrets and recovery codes, pending tokens and queued notifications are deleted; sessions and roles are revoked; name and email are overwritten with a non-reversible tombstone (`erased-xxxxxxxx@erased.invalid`). The user row survives as a pseudonymous key so class statistics and statutory records remain intact, and is flagged `processing_restricted`.
- **Record:** audited as `user.erased`, including the prior identity — the audit log is append-only and under its own 7-year window, and an unattributable erasure would defeat the point of keeping a log. Listed at `GET /api/v1/admin/erasures`.
- **Response time:** 30 days. Requests go to the school's Data Protection Officer, whose address is configured in **School settings → DPO email** and rendered on the public `/legal/*` pages. There is no default: the go-live check fails until the school sets a real one.

## 5. Cross-border transfers

Hosting is eu-west-1 (Ireland). For Nigerian data subjects this is a cross-border transfer under NDPA: covered by Standard Contractual Clauses with each processor and the transfer register (see ADR-010).

**DPIA.** This document used to state that a DPIA was "filed". Nothing in the portal recorded one, and nothing in the portal could have known. The school records its DPIA reference under **School → Compliance**; `/legal/privacy` and `/legal/retention` render whatever is there and say plainly when nothing is, and `/reports/go-live` warns while the field is empty. A DPIA completed outside this system is still a DPIA — it just has to be recorded here before the published policy will claim it.
