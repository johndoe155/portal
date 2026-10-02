import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import SectionAdmin from "./section-admin";

interface Section { id: string; name: string; courseCode: string; courseTitle: string; status: string }
interface Term { id: string; name: string; termNo: number }

export default async function AdminSections() {
  const session = await requireRole("super_admin", "school_admin", "registrar", "counselor");
  const [sections, terms] = await Promise.all([
    apiGet<{ data: Section[] }>("/sections"),
    apiGet<{ data: Term[] }>("/terms"),
  ]);
  const canWrite = ["super_admin", "school_admin", "registrar"].includes(session.activeRole);
  const rows = sections?.data ?? [];
  return (
    <Shell session={session}>
      <h1>Course sections</h1>
      {canWrite && <SectionAdmin terms={terms?.data ?? []} sectionOptions={rows.map((s) => ({ id: s.id, name: s.name }))} />}
      <div className="card">
        {rows.length === 0 ? <div className="muted">No sections yet.</div> : (
          <table>
            <thead><tr><th>Section</th><th>Course</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong></td>
                  <td>{s.courseCode} — {s.courseTitle}</td>
                  <td>{s.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
