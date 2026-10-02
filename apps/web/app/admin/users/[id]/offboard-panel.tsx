"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Preview {
  user: { id: string; email: string; displayName: string; status: string; roles: string[] };
  isStudent: boolean;
  activeSessions: number;
  sectionsTaught: { id: string; name: string; courseCode: string; courseTitle: string; role: string; students: number }[];
  childrenLinked: { id: string; displayName: string; relationship: string }[];
  guardiansLinked: { id: string; displayName: string; relationship: string }[];
  threadsOwned: number;
  enrollmentsActive: number;
  unpaidInvoices: { count: number; totalMinor: number };
  blockers: string[];
  warnings: string[];
}

/**
 * Offboarding, with the consequences shown before the button is pressed.
 *
 * A registrar deactivating a teacher mid-term needs to see that four classes
 * are about to be left with nobody able to take the register. The preview is
 * loaded first and the confirmation requires typing the person's name, because
 * this revokes every session and role the moment it runs.
 */
export default function OffboardPanel({ userId }: { userId: string }) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"left" | "suspended">("left");
  const [endLinks, setEndLinks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>("");

  const load = useCallback(async () => {
    setErr("");
    try { setP(await api<Preview>(`/users/${userId}/offboard-preview`)); }
    catch (e: any) { setErr(e?.message ?? "Could not load the offboarding summary"); }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  async function deactivate() {
    setBusy(true); setErr(""); setDone("");
    try {
      const res = await api<{ status: string; effects: Record<string, unknown> }>(
        `/users/${userId}/deactivate`,
        { method: "POST", body: JSON.stringify({ reason, mode, end_guardian_links: endLinks }) });
      const e = res.effects as any;
      setDone(`Account ${res.status === "suspended" ? "suspended" : "offboarded"}. ` +
        `${e.sessionsRevoked} session(s) ended, ${e.rolesRevoked?.length ?? 0} role(s) revoked` +
        `${e.invitesCancelled ? `, ${e.invitesCancelled} invite(s) cancelled` : ""}` +
        `${e.resetTokensVoided ? `, ${e.resetTokensVoided} reset link(s) voided` : ""}.`);
      setOpen(false); setConfirm("");
      await load();
    } catch (e: any) {
      setErr(e?.detail ?? e?.message ?? "Could not deactivate this account");
    } finally { setBusy(false); }
  }

  async function reactivate() {
    setBusy(true); setErr(""); setDone("");
    try {
      const res = await api<{ rolesRestored: string[] }>(`/users/${userId}/reactivate`,
        { method: "POST", body: JSON.stringify({}) });
      setDone(res.rolesRestored.length
        ? `Account restored with role(s): ${res.rolesRestored.join(", ")}.`
        : "Account restored. It had no roles to put back — grant one below.");
      await load();
    } catch (e: any) {
      setErr(e?.detail ?? e?.message ?? "Could not reactivate this account");
    } finally { setBusy(false); }
  }

  if (!p) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Account access</h2>
        <div className="muted">{err || "Loading…"}</div>
      </div>
    );
  }

  const inactive = p.user.status !== "active";
  const canConfirm = confirm.trim().toLowerCase() === p.user.displayName.trim().toLowerCase();

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Account access</h2>
      <p>
        <strong>{p.user.displayName}</strong>{" "}
        <span className="muted">{p.user.email}</span>{" "}
        <span className="badge" style={{
          background: inactive ? "#fde2e1" : "#dcfae6",
          color: inactive ? "#912018" : "#074d31",
          padding: "2px 8px", borderRadius: 10, fontSize: ".8rem",
        }}>
          {p.user.status}
        </span>
      </p>

      {done && <p style={{ color: "var(--ok, #067647)" }}>{done}</p>}
      {err && <p style={{ color: "var(--danger, #b42318)" }}>{err}</p>}

      {inactive ? (
        <>
          <p className="muted">
            This account cannot sign in. Its records — marks, attendance, messages — are
            kept. Reactivating restores exactly the roles that were revoked.
          </p>
          <button className="btn" onClick={reactivate} disabled={busy}>
            {busy ? "Working…" : "Reactivate account"}
          </button>
        </>
      ) : (
        <>
          {/* What this will affect — the part that prevents a bad Monday. */}
          <div style={{ margin: "12px 0" }}>
            <h3 style={{ fontSize: ".95rem", margin: "0 0 6px" }}>Before you offboard</h3>
            <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: ".9rem" }}>
              <li>{p.activeSessions} active session(s) will end immediately.</li>
              <li>{p.user.roles.length ? `Role(s) revoked: ${p.user.roles.join(", ")}.` : "No roles to revoke."}</li>
              {p.sectionsTaught.length > 0 && (
                <li style={{ color: "var(--danger, #b42318)" }}>
                  Teaching {p.sectionsTaught.length} section(s) —{" "}
                  {p.sectionsTaught.map((s) => `${s.name} (${s.courseCode}, ${s.students} pupils)`).join("; ")}.
                  <strong> Assign a replacement first</strong>, or nobody can mark those registers.
                </li>
              )}
              {p.childrenLinked.length > 0 && (
                <li>
                  Guardian for {p.childrenLinked.map((c) => c.displayName).join(", ")} — their
                  access to those children ends.
                </li>
              )}
              {p.enrollmentsActive > 0 && <li>Enrolled in {p.enrollmentsActive} section(s).</li>}
              {p.unpaidInvoices.count > 0 && (
                <li>
                  {p.unpaidInvoices.count} unpaid invoice(s) worth{" "}
                  {(p.unpaidInvoices.totalMinor / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}.
                  Fees are not cancelled by offboarding.
                </li>
              )}
              <li className="muted">Marks, attendance and messages are retained.</li>
            </ul>
          </div>

          {p.blockers.length > 0 && (
            <div style={{ border: "1px solid var(--danger, #b42318)", borderRadius: 6, padding: 10, marginBottom: 10 }}>
              {p.blockers.map((b) => <p key={b} style={{ margin: 0 }}>{b}</p>)}
            </div>
          )}

          {!open ? (
            <button className="btn danger" onClick={() => setOpen(true)} disabled={p.blockers.length > 0}>
              Offboard this account…
            </button>
          ) : (
            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <label style={{ display: "block", marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: ".85rem" }}>Why is access being removed?</span><br />
                <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
                  <option value="left">They have left the school (permanent)</option>
                  <option value="suspended">Suspended (temporary)</option>
                </select>
              </label>
              <label style={{ display: "block", marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: ".85rem" }}>Reason (recorded in the audit log)</span><br />
                <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "100%" }}
                  placeholder="e.g. Resigned, last day 20 December" />
              </label>
              {(p.childrenLinked.length > 0 || p.guardiansLinked.length > 0) && (
                <label style={{ display: "block", marginBottom: 8, fontSize: ".9rem" }}>
                  <input type="checkbox" checked={endLinks} onChange={(e) => setEndLinks(e.target.checked)} />{" "}
                  Also end their guardian links ({p.childrenLinked.length + p.guardiansLinked.length})
                </label>
              )}
              <label style={{ display: "block", marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: ".85rem" }}>
                  Type <strong>{p.user.displayName}</strong> to confirm
                </span><br />
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ width: "100%" }} />
              </label>
              <div className="row">
                <button className="btn danger" onClick={deactivate} disabled={!canConfirm || busy}>
                  {busy ? "Offboarding…" : "Confirm offboarding"}
                </button>
                <button className="btn ghost" onClick={() => { setOpen(false); setConfirm(""); }} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
