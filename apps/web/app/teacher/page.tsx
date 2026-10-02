import Link from "next/link";
import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import { todayIso } from "@/lib/dates";

interface Section { id: string; name: string; courseCode: string; courseTitle: string; status: string }

export default async function TeacherHome() {
  const session = await requireRole("teacher", "teacher_assistant");
  const res = await apiGet<{ data: Section[] }>("/sections");
  const sections = res?.data ?? [];
  const date = todayIso();
  return (
    <Shell session={session}>
      <h1>My sections</h1>
      {sections.length === 0 && <div className="card muted">No sections assigned yet.</div>}
      <div className="grid cols2">
        {sections.map((s) => (
          <div className="card" key={s.id}>
            <h2 style={{ marginTop: 0 }}>{s.name}</h2>
            <div className="muted">{s.courseCode} — {s.courseTitle}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <Link className="btn" href={`/teacher/attendance/${s.id}?date=${date}`}>Attendance</Link>
              <Link className="btn ghost" href={`/teacher/gradebook/${s.id}`}>Gradebook</Link>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
