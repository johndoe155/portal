import type { Metadata } from "next";

/** review-4 #1: per-request CSP nonce requires per-request rendering —
 * a statically cached page would bake in the build-time nonce and every
 * hydration script would be blocked by the live CSP header. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Terms of Service — School Portal" };

export default function TermsOfService() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem", lineHeight: 1.7 }}>
      <h1>Terms of Service</h1>
      <p className="muted">Last updated: 2026-10-01 · <strong>Template — requires legal review before production use</strong></p>

      <h2>1. Acceptance</h2>
      <p>By accessing or using this School Portal (&quot;the Service&quot;), you agree to these Terms. If you do not agree, do not use the Service.</p>

      <h2>2. Accounts</h2>
      <ul>
        <li>Accounts are created by school administrators or via invite link. You may not self-register.</li>
        <li>You are responsible for safeguarding your credentials. Report suspected compromise immediately.</li>
        <li>Staff accounts require multi-factor authentication (MFA).</li>
      </ul>

      <h2>3. Acceptable Use</h2>
      <p>You agree not to: (a) access data belonging to other users without authorisation; (b) upload malicious code; (c) attempt to bypass security controls; (d) use the Service for unlawful purposes; (e) impersonate another person.</p>

      <h2>4. Parent/Guardian Access</h2>
      <p>Parent accounts are read-only by design. Parents may view their linked children&apos;s academic records, messages, fees, exams, and transport. Parents may initiate fee payments for their linked children. Parents may not modify academic records, send messages on behalf of teachers, or access other families&apos; data.</p>

      <h2>5. Fees and Payments</h2>
      <p>Fee amounts are set by the school. Payments are processed by Paystack (a third-party payment processor). The portal does not store card details. Refund policies are determined by the school.</p>

      <h2>6. Data and Privacy</h2>
      <p>Your use of the Service is also governed by our <a href="/legal/privacy">Privacy Policy</a> and <a href="/legal/retention">Data Retention Policy</a>.</p>

      <h2>7. Availability</h2>
      <p>We strive for high availability but do not guarantee uninterrupted service. Maintenance windows will be communicated via the portal notification system where practicable.</p>

      <h2>8. Termination</h2>
      <p>The school may suspend or terminate your access at any time for violation of these Terms, security concerns, or when your relationship with the school ends (e.g., graduation, staff departure).</p>

      <h2>9. Limitation of Liability</h2>
      <p>To the maximum extent permitted by law, the school and its technology providers shall not be liable for indirect, incidental, or consequential damages arising from use of the Service.</p>

      <h2>10. Governing Law</h2>
      <p>These Terms are governed by the laws of the Federal Republic of Nigeria, including the Nigeria Data Protection Act 2023.</p>

      <h2>11. Changes</h2>
      <p>We may update these Terms. Material changes will be notified via the portal. Continued use after notification constitutes acceptance.</p>

      <hr style={{ margin: "2rem 0" }} />
      <p><a href="/login">← Back to login</a></p>
    </main>
  );
}
