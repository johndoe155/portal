import type { Metadata } from "next";
import { publicSchool } from "@/lib/session";
import DpoContact from "@/components/dpo-contact";
import DpiaStatement from "@/components/dpia-statement";

/** review-4 #1: per-request CSP nonce requires per-request rendering —
 * a statically cached page would bake in the build-time nonce and every
 * hydration script would be blocked by the live CSP header. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Privacy Policy — School Portal" };

export default async function PrivacyPolicy() {
  const school = await publicSchool();
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem", lineHeight: 1.7 }}>
      <h1>Privacy Policy</h1>
      <p className="muted">Last updated: 2026-10-01 · <strong>Template — requires legal review before production use</strong></p>

      <h2>1. Data Controller</h2>
      <p>{school.name} is the data controller for the personal data held in this portal.</p>
      <DpoContact school={school} purpose="For any privacy question," />

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
        <li><strong>Consent:</strong> optional email, such as absence alerts, marks notices and the daily summary, which you can switch off at any time under <a href="/account/notifications">Email preferences</a>.</li>
      </ul>

      <h2>4. Data Sharing</h2>
      <p>We do not sell personal data. We share data only with: (a) authorised school staff on a need-to-know basis; (b) payment processors (Paystack) for fee collection; (c) the school's email provider, which carries notification messages; (d) regulators when legally required.</p>

      <h2>5. Impact Assessment and Cross-Border Transfers</h2>
      <DpiaStatement school={school} />

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
      <DpoContact school={school} purpose="To exercise any of these rights," />
      <p>
        Erasure is carried out as irreversible anonymisation: identifying details are removed, while
        records the school is legally required to keep — marks, attendance, fee records and the audit
        trail — are retained without a named subject until their statutory window expires. The portal
        will show the requester exactly which records fall into each category before anything is done.
      </p>

      <h2>8. Children&apos;s Privacy (COPPA / NDPA §28)</h2>
      <p>Student accounts are created by the school, not self-registered; no pupil can open an account independently. A parent or guardian only gains access to a child&apos;s record through a link created by the school and confirmed by the guardian from their own email address, and the school can end that link at any time.</p>
      <p>
        <strong>What this portal does not do:</strong> it does not record the parental consent
        obtained at enrolment, and it does not hold pupils&apos; dates of birth, so it cannot
        identify which pupils are under 13. Consent is handled by the school&apos;s own admissions
        process, outside this system. Where a regulator requires evidence of consent for a
        particular pupil, that evidence comes from the school&apos;s enrolment records, not from
        here.
      </p>

      <h2>9. Security</h2>
      <p>TLS in transit, AES-256-GCM encryption for two-factor secrets at rest, scrypt password hashing with a per-password salt, role-based access control, row-level security enforced in the database itself, and an append-only, hash-chained audit log.</p>

      <h2>10. Changes</h2>
      <p>We will notify users of material changes via the portal notification system.</p>

      <hr style={{ margin: "2rem 0" }} />
      <p><a href="/login">← Back to login</a></p>
    </main>
  );
}
