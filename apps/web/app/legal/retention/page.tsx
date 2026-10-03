import type { Metadata } from "next";
import { publicSchool } from "@/lib/session";
import DpoContact from "@/components/dpo-contact";

/** review-4 #1: per-request CSP nonce requires per-request rendering —
 * a statically cached page would bake in the build-time nonce and every
 * hydration script would be blocked by the live CSP header. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Data Retention Policy — School Portal" };

export default async function DataRetention() {
  const school = await publicSchool();
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem", lineHeight: 1.7 }}>
      <h1>Data Retention Policy</h1>
      <p className="muted">Last updated: 2026-10-01 · <strong>Template — requires legal review before production use</strong></p>

      <h2>Purpose</h2>
      <p>This policy describes how long the School Portal retains personal data and the basis for each retention period. It supports compliance with the Nigeria Data Protection Act 2023 (NDPA), FERPA (34 CFR 99), and COPPA.</p>

      <h2>Retention Schedule</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #ccc", textAlign: "left" }}>
            <th style={{ padding: 8 }}>Data Category</th>
            <th style={{ padding: 8 }}>Retention Period</th>
            <th style={{ padding: 8 }}>Legal Basis</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Student academic records (grades, attendance, exams)", "5 years after graduation/withdrawal", "NDPA §28, FERPA, statutory education records"],
            ["Fee invoices and payment records", "7 years (tax/accounting)", "Companies and Allied Matters Act, FIRS requirements"],
            ["User accounts (staff)", "Duration of employment + 2 years", "Contract, legitimate interest (security)"],
            ["User accounts (students/parents)", "Duration of enrollment + 5 years", "Contract, statutory education records"],
            ["Messages (teacher ↔ parent)", "3 years after academic year ends", "Legitimate interest (communication history)"],
            ["Notifications (email outbox)", "90 days after delivery or final failure", "Operational (delivery evidence)"],
            ["Audit log", "7 years (append-only, tamper-evident)", "NDPA accountability, legal obligation"],
            ["Session records", "30 days after expiry or revocation", "Security (incident investigation)"],
            ["MFA secrets and recovery codes", "Until MFA reset, or erased with the account", "Security (authentication)"],
            ["Password reset tokens", "1 hour TTL; the spent record is purged after 30 days", "Security (minimise exposure window)"],
            ["Invitations and enrolment tokens", "7 days TTL; the spent record is purged after 30 days", "Operational (onboarding)"],
            ["Uploaded roster files and import jobs", "30 days after the import finishes", "Operational (minimise bulk personal data at rest)"],
            ["Push subscriptions", "Retired after 90 days of continuous delivery failure, or on unsubscribe", "Consent"],
            ["Replay-protection keys", "7 days", "Operational (security)"],
            ["Transport assignments", "Duration of academic year + 1 year", "Contract, operational"],
          ].map(([cat, period, basis]) => (
            <tr key={cat} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: 8 }}>{cat}</td>
              <td style={{ padding: 8 }}>{period}</td>
              <td style={{ padding: 8 }}>{basis}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>How the schedule is enforced</h2>
      <p>
        A purge job runs daily against the operational windows above and removes the matching
        records. Every run is recorded and entered in the audit log with per-table counts, so the
        school can demonstrate that this page describes what actually happens rather than an
        intention. Records still in use are never purged: an undelivered notification, a live
        session or an import still running is left alone however old it is.
      </p>
      <p>
        Statutory records — marks, attendance, enrolments, fee records, report cards and the audit
        log — are outside the purge. They are retained for the periods in the table above and
        removed or anonymised only when that period expires.
      </p>

      <h2>Deletion and erasure requests</h2>
      <p>
        Erasure requests are honoured within 30 days. Where a legal obligation requires a record to
        be kept (NDPA §34(4)), it is not deleted: the subject&rsquo;s identifying details are
        irreversibly removed and the remaining record is marked as restricted and kept without a
        named subject until its statutory window expires. Before any erasure is carried out, the
        school is shown exactly which records will be removed and which must be retained, and why.
      </p>

      <h2>Backups</h2>
      <p>
        Database backups are encrypted (AES-256) and retained for 35 rolling days, with the newest
        copy restore-tested weekly. Data deleted under this schedule may persist in a backup until
        that copy expires.
      </p>

      <h2>Cross-Border Transfers</h2>
      <p>If hosted outside Nigeria, data transfers rely on Standard Contractual Clauses (SCCs). A Data Protection Impact Assessment (DPIA) is filed with the NDPC. See our <a href="/legal/privacy">Privacy Policy §5</a>.</p>

      <h2>Children&apos;s Data (COPPA / NDPA §28)</h2>
      <p>Student data for children under 13 is processed only with verified parental consent obtained at enrollment. Parents may request deletion of their child&apos;s data at any time, subject to statutory retention obligations for academic records.</p>

      <h2>Contact</h2>
      <DpoContact school={school} purpose="To request deletion or ask about retention," />

      <hr style={{ margin: "2rem 0" }} />
      <p><a href="/login">← Back to login</a></p>
    </main>
  );
}
