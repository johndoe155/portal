"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Student {
  userId: string; admissionNo: string; gradeLevel: number; status: string;
  email: string; displayName: string;
}

/** phase 6: create students, edit records, manage guardian links. */
export default function StudentsPanel() {
  const [rows, setRows] = useState<Student[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [form, setForm] = useState({ email: "", display_name: "", password: "", admission_no: "", grade_level: "10" });
  const [linkFor, setLinkFor] = useState<Student | null>(null);
  const [linkForm, setLinkForm] = useState({ guardian_email: "", relationship: "mother" });
  const [links, setLinks] = useState<any[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await api<{ data: Student[] }>(`/students?per=100&q=${encodeURIComponent(q)}`);
      setRows(res.data);
    } catch (e: any) { setErr(e?.message ?? "Could not load students"); }
  }, [q]);
  useEffect(() => { load(); }, [load]);

  async function create() {
    setErr(""); setOkMsg("");
    try {
      await api("/users", { method: "POST", body: JSON.stringify({
        ...form, grade_level: Number(form.grade_level),
        admission_no: form.admission_no || undefined,
        roles: ["student"],
      }) });
      setForm({ email: "", display_name: "", password: "", admission_no: "", grade_level: "10" });
      setOkMsg("Student created.");
      await load();
    } catch (e: any) { setErr(e?.message ?? "Create failed"); }
  }

  async function loadLinks(s: Student) {
    setLinkFor(s); setErr("");
    try {
      // guardian links for this student are visible via the children admin view;
      // simplest: fetch reconciliation-free list through the students endpoint's guardian panel
      const res = await api<{ data: any[] }>(`/students/${s.userId}/guardians`);
      setLinks(res.data);
    } catch { setLinks([]); }
  }

  async function addLink() {
    if (!linkFor) return;
    setErr(""); setOkMsg("");
    try {
      const res = await api<any>(`/students/${linkFor.userId}/guardians`, {
        method: "POST", body: JSON.stringify(linkForm),
      });
      if (res.verifyUrl) window.prompt("Guardian verify link (shown once — send it to them):", res.verifyUrl);
      setOkMsg("Guardian link created — verification sent.");
      await loadLinks(linkFor);
    } catch (e: any) { setErr(e?.message ?? "Link failed"); }
  }

  async function linkAction(id: string, action: "confirm" | "revoke") {
    setErr(""); setBusy(id + action);
    try {
      await api(`/guardian-links/${id}/${action}`, { method: "POST" });
      if (linkFor) await loadLinks(linkFor);
    } catch (e: any) { setErr(e?.message ?? "Action failed"); }
    setBusy("");
  }

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>New student</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input placeholder="Full name" value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          <input placeholder="Email" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input placeholder="Temporary password (12+ chars)" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input placeholder="Admission no (blank = auto)" value={form.admission_no}
            onChange={(e) => setForm({ ...form, admission_no: e.target.value })} />
          <input placeholder="Grade level" type="number" min={1} max={13} value={form.grade_level}
            onChange={(e) => setForm({ ...form, grade_level: e.target.value })} />
          <button className="btn" onClick={create}>Create student</button>
        </div>
      </div>

      <div className="card">
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input placeholder="Search name or admission no" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        </div>
        <table>
          <thead><tr><th>Admission</th><th>Name</th><th>Grade</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.userId}>
                <td>{s.admissionNo}</td><td>{s.displayName}<div className="muted">{s.email}</div></td>
                <td>{s.gradeLevel}</td><td>{s.status}</td>
                <td><button className="btn ghost" onClick={() => loadLinks(s)}>Guardians</button></td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={5} className="muted">No students yet — create one above or use Import.</td></tr> : null}
          </tbody>
        </table>
      </div>

      {linkFor ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Guardians — {linkFor.displayName}</h2>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input placeholder="Guardian email (must have an account)" value={linkForm.guardian_email}
              onChange={(e) => setLinkForm({ ...linkForm, guardian_email: e.target.value })} />
            <select value={linkForm.relationship}
              onChange={(e) => setLinkForm({ ...linkForm, relationship: e.target.value })}>
              {["mother", "father", "guardian", "grandparent", "sibling"].map((r) => <option key={r}>{r}</option>)}
            </select>
            <button className="btn" onClick={addLink}>Link</button>
          </div>
          <table>
            <thead><tr><th>Relationship</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {links.map((l: any) => (
                <tr key={l.id}>
                  <td>{l.relationship}</td>
                  <td>{l.endedAt ? "revoked" : l.verifiedAt ? "verified" : "pending"}</td>
                  <td>
                    {!l.verifiedAt && !l.endedAt ? (
                      <button className="btn ghost" disabled={busy === l.id + "confirm"} onClick={() => linkAction(l.id, "confirm")}>
                        {busy === l.id + "confirm" ? "…" : "Confirm (office)"}
                      </button>
                    ) : null}
                    {!l.endedAt ? (
                      <button className="btn ghost" disabled={busy === l.id + "revoke"} onClick={() => linkAction(l.id, "revoke")}>
                        {busy === l.id + "revoke" ? "…" : "Revoke"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {links.length === 0 ? <tr><td colSpan={3} className="muted">No guardian links.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}
      {okMsg ? <p className="muted">{okMsg}</p> : null}
    </>
  );
}
