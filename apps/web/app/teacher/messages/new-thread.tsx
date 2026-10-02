"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

interface Section { id: string; name: string }
interface RosterRow { studentUserId: string; displayName: string; admissionNo: string }

export default function NewThread({ sections, rosters }: {
  sections: Section[]; rosters: Record<string, RosterRow[]>;
}) {
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? "");
  const [studentId, setStudentId] = useState("");
  const [subject, setSubject] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const roster = rosters[sectionId] ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const thread = await api<{ id: string }>("/threads", {
        method: "POST", body: JSON.stringify({ student_user_id: studentId, subject }),
      });
      router.push(`/teacher/messages/${thread.id}`);
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "outside_section_scope" ? "You do not teach this student." : e?.message ?? "Could not open thread");
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2 style={{ marginTop: 0 }}>New thread with a parent</h2>
      {err && <div className="alert err" role="alert">{err}</div>}
      <div className="grid cols3">
        <div>
          <label htmlFor="sec">Section</label>
          <select id="sec" value={sectionId} onChange={(e) => { setSectionId(e.target.value); setStudentId(""); }}>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="stu">Student</label>
          <select id="stu" value={studentId} onChange={(e) => setStudentId(e.target.value)} required>
            <option value="">Choose…</option>
            {roster.map((r) => <option key={r.studentUserId} value={r.studentUserId}>{r.displayName}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="subj">Subject</label>
          <input id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} />
        </div>
      </div>
      <button className="btn" style={{ marginTop: 12 }} disabled={busy || !studentId || !subject}>
        {busy ? "Opening…" : "Open thread"}
      </button>
    </form>
  );
}
