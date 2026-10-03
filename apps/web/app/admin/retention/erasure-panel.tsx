"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

interface DirUser { id: string; email: string; displayName: string; status: string }
interface Preview {
  user: { id: string; email: string; displayName: string; status: string; anonymizedAt: string | null };
  erases: { what: string; count: number }[];
  retains: { what: string; count: number; basis: string }[];
  blockers: string[];
  warnings: string[];
}
interface Erasure {
  id: string; anonymizedAt: string; note: string | null; restricted: boolean;
}

/**
 * Right-to-erasure, carried out honestly.
 *
 * The privacy policy promised erasure with a statutory carve-out, and there
 * was no way to exercise either half. The carve-out is the difficult part: a
 * pupil's marks and a parent's invoices cannot lawfully be deleted, so this
 * shows both lists — what goes and what the school must keep — before anyone
 * commits to something irreversible.
 */
export default function ErasurePanel() {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<DirUser[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>("");
  const [history, setHistory] = useState<Erasure[]>([]);

  useEffect(() => {
    api<{ data: Erasure[] }>("/admin/erasures")
      .then((r) => setHistory(r.data)).catch(() => {});
  }, [done]);

  async function search() {
    setErr(""); setPreview(null);
    try {
      const res = await api<{ data: DirUser[] }>(`/users?q=${encodeURIComponent(q)}&per=10`);
      setUsers(res.data ?? []);
    } catch (e: any) { setErr(e?.detail ?? e?.message ?? "Search failed"); }
  }

  async function load(id: string) {
    setErr(""); setConfirm(""); setDone("");
    try { setPreview(await api<Preview>(`/users/${id}/erasure-preview`)); }
    catch (e: any) { setErr(e?.detail ?? e?.message ?? "Could not load the preview"); }
  }

  async function erase() {
    if (!preview) return;
    setBusy(true); setErr("");
    try {
      const res = await api<{ tombstone: string; detail: string }>(
        `/users/${preview.user.id}/erasure`, {
          method: "POST",
          body: JSON.stringify({ confirm_email: confirm, reason: reason || undefined }),
        });
      setDone(res.detail);
      setPreview(null); setConfirm(""); setReason(""); setUsers([]);
    } catch (e: any) {
      setErr(e?.detail ?? e?.message ?? "The erasure could not be completed");
    } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Erasure requests</h2>
      <p className="muted">
        Removes everything that identifies a person. Records the school is legally required to keep
        are retained without a named subject and marked restricted. This cannot be undone.
      </p>

      {err && <p className="error" role="alert">{err}</p>}
      {done && <p style={{ border: "1px solid #0a0", padding: 12, borderRadius: 6 }}>{done}</p>}

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <label style={{ flex: 1 }}>
          <span>Find the person</span>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") search(); }}
            placeholder="Name or email address" />
        </label>
        <button className="btn ghost" onClick={search}>Search</button>
      </div>

      {users.length > 0 && !preview && (
        <table className="table" style={{ marginTop: 12 }}>
          <thead><tr><th>Name</th><th>Email</th><th>Status</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td className="muted">{u.email}</td>
                <td>{u.status}</td>
                <td><button className="btn ghost" onClick={() => load(u.id)}>Review erasure</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {preview && (
        <div style={{ marginTop: 16, borderTop: "1px solid #ddd", paddingTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>{preview.user.displayName} — {preview.user.email}</h3>

          {preview.blockers.map((b, i) => (
            <p key={i} className="error" style={{ fontWeight: 600 }}>{b}</p>
          ))}
          {preview.warnings.map((wn, i) => (
            <p key={i} className="muted">⚠ {wn}</p>
          ))}

          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
            <div>
              <h4>Removed permanently</h4>
              <ul>
                {preview.erases.filter((e) => e.count > 0).map((e) => (
                  <li key={e.what}>{e.what} <span className="muted">({e.count})</span></li>
                ))}
              </ul>
            </div>
            <div>
              <h4>Kept, without a named subject</h4>
              {preview.retains.length === 0
                ? <p className="muted">Nothing is held under a statutory window.</p>
                : (
                  <ul>
                    {preview.retains.map((r) => (
                      <li key={r.what}>
                        {r.what} <span className="muted">({r.count})</span>
                        <div className="muted" style={{ fontSize: 12 }}>{r.basis}</div>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </div>

          {preview.blockers.length === 0 && (
            <div style={{ marginTop: 12, borderTop: "1px dashed #ccc", paddingTop: 12 }}>
              <label>
                <span>Reason (recorded in the audit log)</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Parent erasure request, 3 October 2026" />
              </label>
              <label>
                <span>Type <strong>{preview.user.email}</strong> to confirm</span>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  placeholder={preview.user.email} />
              </label>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn danger" onClick={erase}
                  disabled={busy || confirm.trim().toLowerCase() !== preview.user.email.toLowerCase()}>
                  {busy ? "Erasing…" : "Erase permanently"}
                </button>
                <button className="btn ghost" onClick={() => setPreview(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: 20, borderTop: "1px solid #ddd", paddingTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Completed erasures</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            Kept as evidence that requests were honoured. The prior identity lives only in the
            append-only audit log.
          </p>
          <table className="table">
            <thead><tr><th>When</th><th>Reason</th><th>Processing</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{new Date(h.anonymizedAt).toLocaleString()}</td>
                  <td>{h.note ?? <span className="muted">—</span>}</td>
                  <td>{h.restricted ? "restricted" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
