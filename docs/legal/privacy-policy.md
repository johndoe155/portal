# School Portal — Privacy Policy

**Effective:** 2026-10-01 · **Owner:** School Portal Data Protection Officer (admin@school.example)
**Applies to:** the High School Portal web application (students, parents/guardians, teachers, administrators).

## 1. Who we are / legal bases

The school is the data controller for all personal data processed by the Portal. Processing relies on:

- **FERPA (34 CFR Part 99)** — education records of enrolled students; the school is the educational agency/institution; Portal vendors are "school officials" with a legitimate educational interest under the school's direct control.
- **COPPA** — students under 13 are provisioned only by the school; accounts carry no public profile, no advertising, no third-party behavioral tracking, and messaging is limited to school↔guardian threads. Guardian consent is obtained at enrollment (offline consent form on file).
- **Nigeria Data Protection Act 2023 (NDPA) + NDPC GAID 2025** — lawful basis: performance of an educational contract and legal obligation; a Data Protection Impact Assessment (DPIA) covers the eu-west-1 managed-PaaS hosting (ADR-010), with Standard Contractual Clauses and a transfer register for cross-border transfers.

## 2. What we collect

| Category | Fields | Source |
| --- | --- | --- |
| Identity | name, school email, role(s) | enrollment / admin provisioning |
| Credentials | password hash (scrypt), TOTP secret (AES-256 encrypted), session metadata | you / MFA enrollment |
| Education records (FERPA) | enrollment, sections, grades, attendance, exams, report cards | teachers |
| Family links | guardian↔student relationships | registrar (verified) |
| Fees | invoices, payments (kobo), gateway references | bursary / Paystack |
| Transport | route/stop assignment | admin |
| Communications | teacher↔guardian message threads | users |
| Technical | IP, user agent, session timestamps, audit log | automatic |

We do **not** collect biometric data, location data, or advertising identifiers.

## 3. Why and how we process

Authentication and access control (RBAC + row-level security), instruction and grading, attendance, safeguarding communications, fee administration, transport logistics, notifications (email/push you enable), statutory record-keeping, and security auditing. Every privileged action is written to a tamper-evident audit log.

## 4. Sharing

We sell nothing and run no advertising. Data is shared only with: (a) the gateway (Paystack) for payment processing — reference and amount only; (b) the email/push providers for delivery; (c) authorities where legally compelled. All processors are under written contracts (NDPA §29) and listed in the transfer register.

## 5. Storage, encryption, retention

Data is stored in the eu-west-1 region on managed Postgres with TLS in transit and AES-256 encryption for secrets at rest; backups are encrypted. Retention follows `docs/legal/data-retention.md`.

## 6. Your rights (NDPA §34–37; FERPA §99.7)

Access, rectification, restriction, objection, deletion (subject to statutory education-record retention), and portability. Exercising them:

- **In-app export:** an administrator with the `exports:write` capability generates a full personal-data bundle per user (`GET /api/v1/users/:id/export`).
- **Requests:** email the DPO (admin@school.example). We acknowledge within 7 days and resolve within 30 days.
- **Complaints:** you may complain to the Nigeria Data Protection Commission (ndpc.gov.ng) or your local education authority.

Students' FERPA rights are exercised through their parent/guardian until age 18 (or by eligible students directly).

## 7. Security

TLS everywhere, hashed+salted passwords, mandatory 2FA for staff/admin, CSRF double-submit, HMAC-verified payment webhooks, per-transaction privilege dropping (Postgres RLS), rate limiting and account lockout, tamper-evident audit logging, and least-privilege database roles.

## 8. Children

Accounts for under-13 students are created only by the school from verified enrollment records; the guardian consent form is kept on file by the registrar. Under-13 accounts cannot be created through invites or SSO self-provisioning.

## 9. Changes

Material changes are announced in-portal and by email at least 14 days before effect.
