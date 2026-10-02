# School Portal — Data Retention & Export Process

**Effective:** 2026-10-01 · Owner: Registrar + DPO · Basis: NDPA 2023 §39(5)(d) (storage limitation), FERPA record-keeping, Nigerian statutory education requirements.

## 1. Retention schedule

| Data class | Retention | Trigger for deletion/anonymisation |
| --- | --- | --- |
| Identity & credentials (active) | Life of account | — |
| Identity (leavers) | 90 days after leaving, then anonymise (keep pseudonymous key) | leaver status set |
| Grades, exams, report cards (FERPA education records) | 5 years after graduation/exit, then anonymise scores to aggregates | statutory window expiry |
| Attendance | 3 years after exit | statutory window expiry |
| Enrolments / sections / schedules | 5 years (academic-record integrity) | window expiry |
| Fee invoices & payments | 7 years (tax/audit) | window expiry |
| Messages (teacher↔guardian) | 2 years after thread close, or on safeguarding hold | window expiry |
| Notifications outbox | 30 days after delivery/failure | rolling |
| Sessions | 24 h expiry; revoked rows purged after 90 days | rolling |
| Audit log | 7 years (tamper-evident; append-only) | window expiry |
| Password-reset / invite / enrollment tokens | 1 h / 7 d / 24 h TTL; used rows purged after 30 days | rolling |
| Push subscriptions | Until revoked or 90 days of delivery failure | rolling |
| Backups | 35 days daily, 12 monthly (provider PITR) | rolling |

## 2. Purge mechanism

Purges run as scheduled jobs against the retention windows above (worker cron in production; `scripts/` jobs). Anonymisation keeps aggregate statistics (class averages) while removing direct identifiers, preserving the school's statistical obligations without personal data.

## 3. Data-subject export (right of access / portability)

- **NDPA §34 / FERPA §99.10:** a data subject (or guardian of a minor) may request their data at any time.
- **In-product:** `GET /api/v1/users/:id/export` (capability `exports:write`) returns the complete personal-data bundle as JSON: profile, roles, identities, session metadata, guardian links, academic records, fees, transport, messaging, notifications, and the subject's audit trail. Credentials and secrets are excluded by design.
- **SLA:** acknowledge within 7 days; deliver within 30 days (NDPA §36). Exports are logged (`user.exported` audit action).
- **Format:** JSON; conversion to CSV/PDF available on request.

## 4. Erasure requests

Erasure is honoured except where a statutory retention window applies (education/tax records above); in that case processing is restricted and the data is isolated until the window expires. Requests: DPO (admin@school.example); response within 30 days.

## 5. Cross-border transfers

Hosting is eu-west-1 (Ireland). For Nigerian data subjects this is a cross-border transfer under NDPA: covered by the filed DPIA, Standard Contractual Clauses with each processor, and the transfer register (see ADR-010).
