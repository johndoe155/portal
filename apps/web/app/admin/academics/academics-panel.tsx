"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

interface Year { id: string; name: string; startDate: string; endDate: string; isCurrent: boolean }
interface Term { id: string; academicYearId: string; termNo: number; name: string }
interface Section { id: string; name: string; code?: string }

export default function AcademicsPanel({ years, terms, sections }:
  { years: Year[]; terms: Term[]; sections: Section[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  const [yearF, setYearF] = useState({ name: "", start_date: "", end_date: "" });
  const [termF, setTermF] = useState({ academic_year_id: years[0]?.id ?? "", term_no: "1", name: "" });
  const [staffF, setStaffF] = useState({ section: sections[0]?.id ?? "", user_email: "", role: "teacher" });

  const run = async (fn: () => Promise<unknown>, okText: string) => {
    setMsg("");
    try { await fn(); setMsg(okText); router.refresh(); }
    catch (e: any) { setMsg(e?.message ?? "Failed"); }
  };

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Academic year</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input placeholder="e.g. 2026/2027" value={yearF.name} onChange={(e) => setYearF({ ...yearF, name: e.target.value })} />
          <input type="date" value={yearF.start_date} onChange={(e) => setYearF({ ...yearF, start_date: e.target.value })} />
          <input type="date" value={yearF.end_date} onChange={(e) => setYearF({ ...yearF, end_date: e.target.value })} />
          <button className="btn" onClick={() => run(() => api("/academic-years", {
            method: "POST", body: JSON.stringify({ ...yearF, make_current: !years.some((y) => y.isCurrent) }),
          }), "Year created.")}>Create year</button>
        </div>
        <ul>
          {years.map((y) => (
            <li key={y.id}>{y.name} ({y.startDate} → {y.endDate}) {y.isCurrent ? "· CURRENT" : (
              <button className="btn ghost" onClick={() => run(() => api(`/academic-years/${y.id}/set-current`, { method: "POST" }), "Switched.")}>make current</button>
            )}</li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Term</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={termF.academic_year_id} onChange={(e) => setTermF({ ...termF, academic_year_id: e.target.value })}>
            {years.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
          </select>
          <input type="number" min={1} max={4} style={{ width: 90 }} value={termF.term_no}
            onChange={(e) => setTermF({ ...termF, term_no: e.target.value })} />
          <input placeholder="e.g. First Term" value={termF.name} onChange={(e) => setTermF({ ...termF, name: e.target.value })} />
          <button className="btn" onClick={() => run(() => api("/terms", {
            method: "POST", body: JSON.stringify({ ...termF, term_no: Number(termF.term_no) }),
          }), "Term created.")}>Create term</button>
        </div>
        <ul>{terms.map((t) => <li key={t.id}>{t.name} · #{t.termNo} · {years.find((y) => y.id === t.academicYearId)?.name ?? ""}</li>)}</ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Assign a teacher to a section</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={staffF.section} onChange={(e) => setStaffF({ ...staffF, section: e.target.value })}>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.code ? `${s.code} — ` : ""}{s.name}</option>)}
          </select>
          <input placeholder="Teacher user id" value={staffF.user_email}
            onChange={(e) => setStaffF({ ...staffF, user_email: e.target.value })} />
          <select value={staffF.role} onChange={(e) => setStaffF({ ...staffF, role: e.target.value })}>
            <option value="teacher">teacher</option>
            <option value="teacher_assistant">teacher assistant</option>
          </select>
          <button className="btn" onClick={() => run(() => api(`/sections/${staffF.section}/staff`, {
            method: "POST", body: JSON.stringify({ user_id: staffF.user_email.trim(), role: staffF.role }),
          }), "Assigned.")}>Assign</button>
        </div>
        <p className="muted">Assignment unlocks attendance, gradebook, exams and messaging for that teacher. Find user ids on the Users page.</p>
      </div>
      {msg ? <p className="muted">{msg}</p> : null}
    </>
  );
}
