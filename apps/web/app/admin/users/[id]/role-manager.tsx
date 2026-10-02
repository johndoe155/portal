"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

const ROLES = ["student", "parent", "teacher", "teacher_assistant", "registrar", "counselor", "school_admin", "auditor"];

export default function RoleManager({ userId, canWrite, active }: {
  userId: string; canWrite: boolean; active: string[];
}) {
  const [role, setRole] = useState(ROLES.find((r) => !active.includes(r)) ?? "student");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function grant() {
    setBusy(true); setErr(""); setInfo("");
    try {
      await api(`/users/${userId}/roles`, { method: "POST", body: JSON.stringify({ role_code: role }) });
      setInfo(`Granted ${role}.`);
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "role_already_granted" ? "Role already active." : e?.message ?? "Grant failed");
    }
    setBusy(false);
  }

  async function revoke(r: string) {
    if (!confirm(`Revoke ${r}?`)) return;
    setBusy(true); setErr(""); setInfo("");
    try {
      await api(`/users/${userId}/roles/${r}`, { method: "DELETE" });
      setInfo(`Revoked ${r}.`);
      router.refresh();
    } catch (e: any) { setErr(e?.message ?? "Revoke failed"); }
    setBusy(false);
  }

  if (!canWrite) {
    return <p className="muted">Only a super admin can change roles (roles:write).</p>;
  }
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Manage roles</h2>
      {err && <div className="alert err" role="alert">{err}</div>}
      {info && <div className="alert ok" role="status">{info}</div>}
      <div className="row">
        <select value={role} onChange={(e) => setRole(e.target.value)} style={{ maxWidth: 220 }}>
          {ROLES.map((r) => <option key={r} value={r}>{r}{active.includes(r) ? " (active)" : ""}</option>)}
        </select>
        <button className="btn" onClick={grant} disabled={busy}>Grant</button>
      </div>
      {active.length > 0 && (
        <div className="row" style={{ marginTop: 10 }}>
          {active.map((r) => (
            <button key={r} className="chip" onClick={() => revoke(r)} disabled={busy}
              aria-label={`Revoke ${r}`}>
              {r} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
