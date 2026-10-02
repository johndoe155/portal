import Link from "next/link";
import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";

interface Thread { id: string; subject: string; status: string; createdAt: string; studentName: string }

export default async function ParentMessages() {
  const session = await requireRole("parent");
  const threads = await apiGet<{ data: Thread[] }>("/threads");
  return (
    <Shell session={session}>
      <h1>Messages</h1>
      <p className="muted">Threads from your children’s teachers. Parent accounts are read-only by design.</p>
      <div className="card">
        {(threads?.data ?? []).length === 0 ? <div className="muted">No messages yet.</div> : (
          <table>
            <thead><tr><th>Subject</th><th>Child</th><th>Status</th><th>Opened</th><th></th></tr></thead>
            <tbody>
              {(threads?.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td>{t.subject}</td><td>{t.studentName}</td>
                  <td>{t.status}</td><td>{t.createdAt.slice(0, 10)}</td>
                  <td><Link href={`/parent/messages/${t.id}`}>Read →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
