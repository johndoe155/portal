import type { Metadata } from "next";

/** review-4 #1: per-request CSP nonce requires per-request rendering —
 * a statically cached page would bake in the build-time nonce and every
 * hydration script would be blocked by the live CSP header. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Data Retention Policy — School Portal" };

export default function DataRetention() {
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
            ["Notifications (outbox)", "90 days after delivery", "Operational (delivery confirmation)"],
            ["Audit log", "7 years", "NDPA accountability, legal obligation"],
            ["Session records", "30 days after expiry/revocation", "Security (incident investigation)"],
            ["MFA secrets and recovery codes", "Until MFA reset or account deletion", "Security (authentication)"],
            ["Password reset tokens", "1 hour (single-use, then marked consumed)", "Security (minimise exposure window)"],
            ["Invites", "7 days (single-use, then marked accepted/expired)", "Operational (onboarding)"],
            ["Push subscriptions", "Until unsubscribed or account deletion", "Consent"],
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

      <h2>Deletion</h2>
      <p>When a retention period expires, data is either deleted or irreversibly anonymised. Deletion requests from data subjects are honoured within 30 days unless a legal obligation requires retention (NDPA §34(4)).</p>

      <h2>Backups</h2>
      <p>Database backups are retained for 14 days (rolling). Deleted data may persist in backups until the backup expires. Backups are encrypted at rest and access-controlled.</p>

      <h2>Cross-Border Transfers</h2>
      <p>If hosted outside Nigeria, data transfers rely on Standard Contractual Clauses (SCCs). A Data Protection Impact Assessment (DPIA) is filed with the NDPC. See our <a href="/legal/privacy">Privacy Policy §5</a>.</p>

      <h2>Children&apos;s Data (COPPA / NDPA §28)</h2>
      <p>Student data for children under 13 is processed only with verified parental consent obtained at enrollment. Parents may request deletion of their child&apos;s data at any time, subject to statutory retention obligations for academic records.</p>

      <h2>Contact</h2>
      <p>To request deletion or ask about retention, contact your school&apos;s Data Protection Officer (DPO contact configured at deployment).</p>

      <hr style={{ margin: "2rem 0" }} />
      <p><a href="/login">← Back to login</a></p>
    </main>
  );
}
