import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import SchoolForm from "./school-form";

export default async function AdminSchool() {
  const session = await requireRole("super_admin", "school_admin");
  const school = await apiGet<Record<string, unknown>>("/school");
  return (
    <Shell session={session}>
      <h1>School settings</h1>
      <p className="muted">Identity used across the portal: login page, navigation, emails and legal pages.</p>
      <SchoolForm initial={school ?? {}} />
    </Shell>
  );
}
