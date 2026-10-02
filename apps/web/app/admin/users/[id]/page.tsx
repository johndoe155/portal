import Link from "next/link";
import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import RoleManager from "./role-manager";
import MfaManager from "./mfa-manager";
import OffboardPanel from "./offboard-panel";

interface RoleRow { id: string; roleCode: string; grantedAt: string; revokedAt: string | null }

export default async function UserRolesPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole("super_admin", "school_admin");
  const { id } = await params;
  const res = await apiGet<{ data: RoleRow[] }>(`/users/${id}/roles`);
  const rows = res?.data ?? [];
  return (
    <Shell session={session}>
      <Link href="/admin/users" className="muted">← Directory</Link>
      <h1>Account</h1>
      <OffboardPanel userId={id} />
      <div className="card">
        {rows.length === 0 ? <div className="muted">No roles found.</div> : (
          <table>
            <thead><tr><th>Role</th><th>Granted</th><th>Revoked</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.roleCode}</strong></td>
                  <td>{r.grantedAt?.slice(0, 10) ?? ""}</td>
                  <td>{r.revokedAt ? r.revokedAt.slice(0, 10) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <RoleManager userId={id} canWrite={session.activeRole === "super_admin"}
        active={rows.filter((r) => !r.revokedAt).map((r) => r.roleCode)} />
      <MfaManager userId={id} />
    </Shell>
  );
}
