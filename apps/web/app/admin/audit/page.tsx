import { requireRole } from "@/lib/session";
import Shell from "@/components/shell";
import AuditBrowser from "./audit-browser";

export default async function AuditPage() {
  const session = await requireRole("super_admin", "school_admin", "auditor");
  return (
    <Shell session={session}>
      <h1>Activity log</h1>
      <p className="muted">
        Every privileged action in the portal, newest first. Entries cannot be edited or
        deleted — the database rejects both — and each one carries a fingerprint so
        tampering can be detected.
      </p>
      <AuditBrowser />
    </Shell>
  );
}
