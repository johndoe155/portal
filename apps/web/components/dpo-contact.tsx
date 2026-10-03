import type { PublicSchool } from "@/lib/session";

/**
 * The school's real data-protection contact.
 *
 * The legal pages used to say the DPO contact was "configured at deployment",
 * which is not an address anyone can write to — and the policy documents
 * shipped with a literal `admin@school.example` placeholder. A published
 * privacy policy whose contact route does not exist is a compliance failure
 * in itself, so the configured value is rendered here, and its absence is
 * stated plainly rather than papered over.
 */
export default function DpoContact({ school, purpose }: { school: PublicSchool; purpose: string }) {
  const dpo = school.dpo_email?.trim();
  const fallback = school.contact_email?.trim();

  if (dpo) {
    return (
      <p>
        {purpose} contact {school.name}&rsquo;s Data Protection Officer at{" "}
        <a href={`mailto:${dpo}`}>{dpo}</a>. We acknowledge within 7 days and respond within 30 days.
      </p>
    );
  }
  if (fallback) {
    return (
      <p>
        {purpose} contact {school.name} at <a href={`mailto:${fallback}`}>{fallback}</a>.{" "}
        <span className="muted">
          (A dedicated Data Protection Officer address has not been configured yet.)
        </span>
      </p>
    );
  }
  return (
    <p style={{ border: "1px solid #b45309", background: "#fffbeb", padding: 12, borderRadius: 6 }}>
      <strong>No data-protection contact has been configured.</strong>{" "}
      This portal cannot tell you where to send a request, which means the school is not yet able to
      honour the rights described on this page. An administrator must set a DPO email address under{" "}
      <strong>School → Contact</strong> before the portal is used with real pupil data.
    </p>
  );
}
