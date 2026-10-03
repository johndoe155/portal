import Link from "next/link";
import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import NewUser from "./new-user";
import InvitesPanel from "./invites-panel";
import MfaRollout from "./mfa-rollout";

interface UserRow { id: string; email: string; displayName: string; status: string }
interface UsersRes { data: UserRow[]; meta: { page: number; per: number; total: number } }

export default async function AdminUsers({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requireRole("super_admin", "school_admin", "registrar", "counselor");
  const sp = await searchParams;
  const page = Math.max(Number(sp.page) || 1, 1);
  const res = await apiGet<UsersRes>(`/users?page=${page}&per=25`);
  const rows = res?.data ?? [];
  const total = res?.meta.total ?? 0;
  const pages = Math.max(Math.ceil(total / 25), 1);
  return (
    <Shell session={session}>
      <h1>User directory</h1>
      <p className="muted">{total} account(s) · page {page} of {pages}</p>
      <NewUser />
      <MfaRollout />
      <InvitesPanel />
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td><td>{u.email}</td>
                <td>
                  <span style={{
                    padding: "2px 8px", borderRadius: 10, fontSize: ".8rem",
                    background: u.status === "active" ? "#dcfae6" : "#fde2e1",
                    color: u.status === "active" ? "#074d31" : "#912018",
                  }}>{u.status}</span>
                </td>
                <td><Link href={`/admin/users/${u.id}`}>Manage →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        {page > 1 && <Link className="btn ghost" href={`/admin/users?page=${page - 1}`}>← Prev</Link>}
        {page < pages && <Link className="btn ghost" href={`/admin/users?page=${page + 1}`}>Next →</Link>}
      </div>
    </Shell>
  );
}
