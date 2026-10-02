import { requireRole } from "@/lib/session";
import Shell from "@/components/shell";
import ImportPanel from "./import-panel";

export default async function AdminImport() {
  const session = await requireRole("super_admin", "school_admin", "registrar");
  return (
    <Shell session={session}>
      <h1>Bulk import</h1>
      <p className="muted">
        CSV import from your SIS export or spreadsheets. Always <strong>Dry run</strong> first — it validates every row
        and writes nothing. Commits dedupe automatically (admission number / email / enrolment).
      </p>
      <ImportPanel />
    </Shell>
  );
}
