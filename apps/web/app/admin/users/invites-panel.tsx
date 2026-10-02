"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Invite {
  id: string; email: string; displayName: string; roles: string[];
  createdAt: string; expiresAt: string;
}

/**
 * review-4 #5: pending invites are visible and actionable — resend (rotates
 * the token and re-emails) or revoke. No more dead-end `invite_exists`.
 */
export default function InvitesPanel() {
  const [rows, setRows] = useState<Invite[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api<{ data: Invite[] }>("/invites");
      setRows(res.data);
    } catch (e: any) { setErr(e?.message ?? "Could not load invites"); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(id: string, action: "resend" | "revoke") {
    setBusy(id + action); setErr("");
    try {
      const res = await api<{ acceptUrl?: string; delivery?: string; ok?: boolean }>(
        `/invites/${id}/${action}`, { method: "POST" });
      if (action === "resend" && res.acceptUrl) {
        // dev-only (no SMTP): surface the rotated link once
        window.prompt("New invite link (copy it — shown once):", res.acceptUrl);
      }
      await load();
    } catch (e: any) {
      setErr(e?.code === "role_above_your_tier" ? "You cannot manage that invite (roles above your tier)."
        : e?.message ?? "Action failed");
    }
    setBusy("");
  }

  if (!rows) return null;
  if (rows.length === 0) return null; // no pending invites — stay out of the way
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Pending invites</h2>
      {err && <div className="alert err" role="alert">{err}</div>}
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role(s)</th><th>Expires</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.displayName}</td>
              <td>{r.email}</td>
              <td>{r.roles.join(", ")}</td>
              <td>{r.expiresAt.slice(0, 10)}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }}
                  disabled={busy === r.id + "resend"} onClick={() => act(r.id, "resend")}>
                  {busy === r.id + "resend" ? "…" : "Resend"}
                </button>{" "}
                <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }}
                  disabled={busy === r.id + "revoke"} onClick={() => act(r.id, "revoke")}>
                  {busy === r.id + "revoke" ? "…" : "Revoke"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ marginBottom: 0 }}>
        Resend rotates the invite link and emails it again; revoke kills a pending invite.
      </p>
    </div>
  );
}
