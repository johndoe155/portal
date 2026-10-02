"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Template { id: string; name: string; amountKobo: number; gradeLevel: number | null; active: boolean }
interface Term { id: string; name: string }

/** phase 6: define fee lines once, generate the term's invoices for a whole grade. */
export default function TemplatesPanel() {
  const [rows, setRows] = useState<Template[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [f, setF] = useState({ name: "", amount: "", grade_level: "10", due_days: "21" });
  const [genFor, setGenFor] = useState<Template | null>(null);
  const [termFor, setTermFor] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => {
    api<{ data: Template[] }>("/fees/templates").then((r) => setRows(r.data)).catch(() => {});
    api<{ data: Term[] }>("/terms").then((r) => { setTerms(r.data); setTermFor(r.data[0]?.id ?? ""); }).catch(() => {});
  };
  useEffect(load, []);

  async function create() {
    setMsg("");
    try {
      await api("/fees/templates", { method: "POST", body: JSON.stringify({
        name: f.name, amount_kobo: Math.round(Number(f.amount || 0) * 100),
        grade_level: f.grade_level ? Number(f.grade_level) : null,
        due_days: Number(f.due_days || 21),
      }) });
      setF({ name: "", amount: "", grade_level: "10", due_days: "21" });
      setMsg("Template created."); load();
    } catch (e: any) { setMsg(e?.message ?? "Failed"); }
  }
  async function generate() {
    if (!genFor || !termFor) return;
    setMsg("");
    try {
      const r = await api<any>(`/fees/templates/${genFor.id}/generate`, {
        method: "POST", body: JSON.stringify({ term_id: termFor }),
      });
      setMsg(`Generated ${r.created} invoice(s), ${r.skipped} skipped (already invoiced).`);
      setGenFor(null); load();
    } catch (e: any) { setMsg(e?.message ?? "Generate failed"); }
  }
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Fee templates</h2>
      <p className="muted">One template = one fee line for a grade (e.g. “First Term Tuition — grade 10”). Generating invoices for a term never double-charges: existing (student, term, label) pairs are skipped.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <input placeholder="Name, e.g. First Term Tuition" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input placeholder="Amount ₦" type="number" min={0} style={{ width: 110 }} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <input placeholder="Grade (blank = all)" type="number" min={1} max={13} style={{ width: 130 }} value={f.grade_level} onChange={(e) => setF({ ...f, grade_level: e.target.value })} />
        <input placeholder="Due in days" type="number" min={1} style={{ width: 110 }} value={f.due_days} onChange={(e) => setF({ ...f, due_days: e.target.value })} />
        <button className="btn" onClick={create}>Add template</button>
      </div>
      {genFor ? (
        <p>
          Generate “{genFor.name}” for{" "}
          <select value={termFor} onChange={(e) => setTermFor(e.target.value)}>
            {terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>{" "}
          <button className="btn" onClick={generate}>Generate</button>{" "}
          <button className="btn ghost" onClick={() => setGenFor(null)}>cancel</button>
        </p>
      ) : null}
      <table>
        <thead><tr><th>Name</th><th>Amount</th><th>Grade</th><th>Active</th><th></th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td><td>₦{(t.amountKobo / 100).toLocaleString()}</td>
              <td>{t.gradeLevel ?? "all"}</td><td>{String(t.active)}</td>
              <td><button className="btn ghost" onClick={() => setGenFor(t)}>Generate…</button></td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td colSpan={5} className="muted">No templates yet.</td></tr> : null}
        </tbody>
      </table>
      {msg ? <p className="muted">{msg}</p> : null}
    </div>
  );
}
