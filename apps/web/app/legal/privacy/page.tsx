import type { Metadata } from "next";

/** review-4 #1: per-request CSP nonce requires per-request rendering —
 * a statically cached page would bake in the build-time nonce and every
 * hydration script would be blocked by the live CSP header. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Privacy Policy — School Portal" };

export default function PrivacyPolicy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem", lineHeight: 1.7 }}>
      <h1>Privacy Policy</h1>
      <p className="muted">Last updated: 2026-10-01 · <strong>Template — requires legal review before production use</strong></p>

      <h2>1. Data Controller</h2>
      <p>The school operating this portal is the data controller. Contact your school&apos;s Data Protection Officer (DPO) for privacy questions. The DPO contact is configured at deployment.</p>

      <h2>2. Data We Collect</h2>
      <ul>
        <li><strong>Account data:</strong> name, email, role, authentication credentials (hashed).</li>
        <li><strong>Academic records:</strong> enrollment, grades, attendance, exam schedules.</li>
        <li><strong>Financial records:</strong> fee invoices, payment references (no card data stored — payments are processed by Paystack).</li>
        <li><strong>Communication:</strong> messages between teachers and parents, notifications.</li>
        <li><strong>Transport:</strong> bus route assignments.</li>
        <li><strong>Security:</strong> session metadata (IP, user-agent), audit log, MFA secrets (AES-256 encrypted).</li>
      </ul>

      <h2>3. Legal Basis (NDPA 2023 / GDPR)</h2>
      <ul>
        <li><strong>Contract:</strong> processing necessary to deliver educational services.</li>
        <li><strong>Legal obligation:</strong> statutory record-keeping (FERPA, NDPA).</li>
        <li><strong>Legitimate interest:</strong> security, fraud prevention, service improvement.</li>
        <li><strong>Consent:</strong> optional features (push notifications, directory listing).</li>
      </ul>

      <h2>4. Data Sharing</h2>
      <p>We do not sell personal data. We share data only with: (a) authorised school staff on a need-to-know basis; (b) payment processors (Paystack) for fee collection; (c) email/push delivery services for notifications; (d) regulators when legally required.</p>

      <h2>5. Cross-Border Transfers</h2>
      <p>If the portal is hosted outside Nigeria, we rely on Standard Contractual Clauses (SCCs) and a filed Data Protection Impact Assessment (DPIA) with the Nigeria Data Protection Commission (NDPC).</p>

      <h2>6. Retention</h2>
      <p>See our <a href="/legal/retention">Data Retention Policy</a>.</p>

      <h2>7. Your Rights (NDPA §34 / FERPA)</h2>
      <ul>
        <li>Access: request a copy of your data (admin can generate an export).</li>
        <li>Correction: request correction of inaccurate data.</li>
        <li>Deletion: request deletion where no legal obligation requires retention.</li>
        <li>Objection: object to processing based on legitimate interest.</li>
        <li>Portability: receive your data in a structured, machine-readable format.</li>
      </ul>
      <p>To exercise any right, contact your school&apos;s DPO.</p>

      <h2>8. Children&apos;s Privacy (COPPA / NDPA §28)</h2>
      <p>Student accounts are created by the school, not self-registered. Parental consent is obtained at enrollment. Students under 13 are not permitted to create accounts independently.</p>

      <h2>9. Security</h2>
      <p>TLS in transit, AES-256 encryption for MFA secrets at rest, bcrypt password hashing, role-based access control, row-level security in the database, audit logging.</p>

      <h2>10. Changes</h2>
      <p>We will notify users of material changes via the portal notification system.</p>

      <hr style={{ margin: "2rem 0" }} />
      <p><a href="/login">← Back to login</a></p>
    </main>
  );
}
