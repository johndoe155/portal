"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

interface Term { id: string; name: string }
interface UserRow { id: string; displayName: string; email: string }

export default function FeesAdmin({ terms, students }: { terms: Term[]; students: UserRow[] }) {
  const [studentId, setStudentId] = useState("");
  const [termId, setTermId] = useState(terms[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [naira, setNaira] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const kobo = Math.round(parseFloat(naira) * 100);
    if (!Number.isFinite(kobo) || kobo <= 0) { setErr("Enter a valid amount in Naira."); return; }
    setBusy(true); setErr(""); setInfo("");
    try {
      await api("/fees/invoices", {
        method: "POST",
        body: JSON.stringify({
          student_user_id: studentId, term_id: termId, label,
          amount_kobo: kobo, ...(dueDate ? { due_date: dueDate } : {}),
        }),
      });
      setInfo(`Invoice "${label}" created for ₦${(kobo / 100).toLocaleString("en-NG")}.`);
      setLabel(""); setNaira(""); setDueDate("");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "invoice_exists" ? "That invoice (student+term+label) already exists."
        : e?.message ?? "Could not create invoice");
    }
    setBusy(false);
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2 style={{ marginTop: 0 }}>New invoice</h2>
      {err && <div className="alert err" role="alert">{err}</div>}
      {info && <div className="alert ok" role="status">{info}</div>}
      <div className="grid cols2">
        <div>
          <label htmlFor="fstu">Student</label>
          <select id="fstu" value={studentId} onChange={(e) => setStudentId(e.target.value)} required>
            <option value="">Choose…</option>
            {students.map((s) => <option key={s.id} value={s.id}>{s.displayName} ({s.email})</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="fterm">Term</label>
          <select id="fterm" value={termId} onChange={(e) => setTermId(e.target.value)}>
            {terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="flabel">Label</label>
          <input id="flabel" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={120} placeholder="First Term Tuition" />
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="famt">Amount (₦)</label>
            <input id="famt" inputMode="decimal" value={naira} onChange={(e) => setNaira(e.target.value)} required placeholder="150000" />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="fdue">Due date</label>
            <input id="fdue" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>
      </div>
      <button className="btn" style={{ marginTop: 12 }} disabled={busy || !studentId}>Create invoice</button>
    </form>
  );
}
