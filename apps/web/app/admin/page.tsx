import Link from "next/link";
import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";

interface Section { id: string; name: string; courseCode: string; courseTitle: string }
interface UsersRes { meta: { total: number } }

export default async function AdminHome() {
  const session = await requireRole("super_admin", "school_admin", "registrar", "counselor", "auditor");
  const [sections, users] = await Promise.all([
    apiGet<{ data: Section[] }>("/sections"),
    apiGet<UsersRes>("/users?per=1"),
  ]);
  return (
    <Shell session={session}>
      <h1>Admin console</h1>
      <div className="grid cols3">
        <div className="stat"><div className="muted">People</div><div className="n">{users?.meta.total ?? "—"}</div></div>
        <div className="stat"><div className="muted">Course sections</div><div className="n">{sections?.data.length ?? "—"}</div></div>
        <div className="stat"><div className="muted">Your role</div><div className="n" style={{ fontSize: "1.1rem" }}>{session.activeRole.replace("_", " ")}</div></div>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Course sections</h2>
        {sections?.data.map((s) => (
          <div key={s.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
            <strong>{s.name}</strong><span className="muted">{s.courseCode} — {s.courseTitle}</span>
          </div>
        ))}
      </div>
      <div className="row">
        <Link className="btn" href="/admin/users">User directory</Link>
        <Link className="btn ghost" href="/admin/sections">All sections</Link>
      </div>
    </Shell>
  );
}
