import { requireRole } from "@/lib/session";
import Shell from "@/components/shell";
import RetentionPanel from "./retention-panel";
import ErasurePanel from "./erasure-panel";

export default async function AdminRetention() {
  const session = await requireRole("super_admin", "school_admin");
  return (
    <Shell session={session}>
      <h1>Data retention</h1>
      <p className="muted">
        The portal publishes a retention policy and promises erasure on request. This is where both
        are actually carried out — and where you can show they are.
      </p>
      <RetentionPanel />
      <ErasurePanel />
    </Shell>
  );
}
