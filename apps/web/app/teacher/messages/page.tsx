import Link from "next/link";
import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import NewThread from "./new-thread";

interface Thread { id: string; subject: string; status: string; createdAt: string; studentName: string }
interface Section { id: string; name: string }
interface RosterRow { studentUserId: string; displayName: string; admissionNo: string }

export default async function TeacherMessages() {
  const session = await requireRole("teacher", "teacher_assistant");
  const [threads, sections] = await Promise.all([
    apiGet<{ data: Thread[] }>("/threads"),
    apiGet<{ data: Section[] }>("/sections"),
  ]);
  const rosters: Record<string, RosterRow[]> = {};
  for (const s of sections?.data ?? []) {
    const r = await apiGet<{ data: RosterRow[] }>(`/sections/${s.id}/roster`);
    rosters[s.id] = r?.data ?? [];
  }
  return (
    <Shell session={session}>
      <h1>Messages</h1>
      <p className="muted">Threads you author about your students. Parents read them; replies stay read-only on their side.</p>
      <NewThread sections={sections?.data ?? []} rosters={rosters} />
      <div className="card">
        {(threads?.data ?? []).length === 0 ? <div className="muted">No threads yet.</div> : (
          <table>
            <thead><tr><th>Subject</th><th>Student</th><th>Status</th><th>Opened</th><th></th></tr></thead>
            <tbody>
              {(threads?.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td>{t.subject}</td><td>{t.studentName}</td>
                  <td>{t.status}</td><td>{t.createdAt.slice(0, 10)}</td>
                  <td><Link href={`/teacher/messages/${t.id}`}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
