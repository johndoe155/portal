import { requireRole } from "@/lib/session";
import Shell from "@/components/shell";
import StudentsPanel from "./students-panel";

export default async function AdminStudents() {
  const session = await requireRole("super_admin", "school_admin", "registrar");
  return (
    <Shell session={session}>
      <h1>Students</h1>
      <p className="muted">Student records: admission numbers, grade levels and guardian links. Creating a student here also creates their login.</p>
      <StudentsPanel />
    </Shell>
  );
}
