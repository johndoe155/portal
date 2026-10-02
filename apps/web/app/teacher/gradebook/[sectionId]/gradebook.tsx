"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

interface RosterRow { studentUserId: string; admissionNo: string; displayName: string }
interface GradeRow {
  id: string; studentUserId: string; label: string; sourceType: string;
  points: string; maxPoints: string; releasedAt: string | null; feedbackText: string | null;
}
interface ExamRow { id: string; title: string; examDate: string; maxScore: string; weightPct: string | null }

export default function Gradebook({ sectionId, roster, grades, exams }: {
  sectionId: string; roster: RosterRow[]; grades: GradeRow[]; exams: ExamRow[];
}) {
  const [studentId, setStudentId] = useState(roster[0]?.studentUserId ?? "");
  const [label, setLabel] = useState("");
  const [sourceType, setSourceType] = useState<"custom" | "assignment" | "exam">("custom");
  const [examId, setExamId] = useState("");
  const [points, setPoints] = useState("");
  const [maxPoints, setMaxPoints] = useState("100");
  const [feedback, setFeedback] = useState("");
  // exam scheduling
  const [examTitle, setExamTitle] = useState("");
  const [examDate, setExamDate] = useState("");
  const [examMax, setExamMax] = useState("100");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const name = (id: string) => roster.find((r) => r.studentUserId === id)?.displayName ?? id.slice(0, 8);
  const unreleased = grades.filter((g) => !g.releasedAt).length;

  async function addGrade(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setInfo("");
    try {
      const out = await api<{ written: number; revisions: number }>(`/sections/${sectionId}/grades/bulk`, {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        body: JSON.stringify({
          items: [{
            student_user_id: studentId, source_type: sourceType, label,
            points, max_points: maxPoints,
            ...(sourceType === "exam" && examId ? { source_id: examId } : {}),
            ...(feedback ? { feedback_text: feedback } : {}),
          }],
        }),
      });
      setInfo(`Grade recorded (${out.revisions} revision row(s)). ${unreleased >= 0 ? "Release it so the student and parent can see it." : ""}`);
      setLabel(""); setPoints(""); setFeedback("");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "grade_exceeds_max" ? "Points cannot exceed max points." : e?.message ?? "Could not save grade");
    }
    setBusy(false);
  }

  async function scheduleExam(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setInfo("");
    try {
      await api(`/sections/${sectionId}/exams`, {
        method: "POST",
        body: JSON.stringify({ title: examTitle, exam_date: examDate, max_score: examMax }),
      });
      setInfo(`Exam "${examTitle}" scheduled.`);
      setExamTitle(""); setExamDate(""); setExamMax("100");
      router.refresh();
    } catch (e: any) { setErr(e?.message ?? "Could not schedule exam"); }
    setBusy(false);
  }

  async function release() {
    setBusy(true); setErr("");
    try {
      const out = await api<{ released: number }>(`/sections/${sectionId}/grades/release`, { method: "POST" });
      setInfo(out.released > 0 ? `Released ${out.released} grade(s) to students and parents.` : "Nothing new to release.");
      router.refresh();
    } catch (e: any) { setErr(e?.message ?? "Release failed"); }
    setBusy(false);
  }

  return (
    <>
      <h1>Gradebook</h1>
      {err && <div className="alert err" role="alert">{err}</div>}
      {info && <div className="alert ok" role="status">{info}</div>}

      <form className="card" onSubmit={addGrade}>
        <h2 style={{ marginTop: 0 }}>Record a grade</h2>
        <div className="grid cols2">
          <div>
            <label htmlFor="student">Student</label>
            <select id="student" value={studentId} onChange={(e) => setStudentId(e.target.value)} required>
              {roster.map((r) => <option key={r.studentUserId} value={r.studentUserId}>{r.displayName} ({r.admissionNo})</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="source">Source</label>
            <select id="source" value={sourceType} onChange={(e) => setSourceType(e.target.value as any)}>
              <option value="custom">Classwork / custom</option>
              <option value="assignment">Assignment</option>
              <option value="exam">Exam</option>
            </select>
          </div>
          {sourceType === "exam" && exams.length > 0 && (
            <div>
              <label htmlFor="examPick">Exam</label>
              <select id="examPick" value={examId} onChange={(e) => setExamId(e.target.value)}>
                <option value="">— no specific exam —</option>
                {exams.map((x) => <option key={x.id} value={x.id}>{x.title} ({x.examDate})</option>)}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="label">Label</label>
            <input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Quiz 3" required maxLength={120} />
          </div>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label htmlFor="points">Points</label>
              <input id="points" inputMode="decimal" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="87" required />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="maxPoints">Max</label>
              <input id="maxPoints" inputMode="decimal" value={maxPoints} onChange={(e) => setMaxPoints(e.target.value)} required />
            </div>
          </div>
        </div>
        <label htmlFor="feedback">Feedback (optional)</label>
        <input id="feedback" value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={2000} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={busy || !studentId}>Save grade</button>
          <button type="button" className="btn ghost" onClick={release} disabled={busy}>Release all to students &amp; parents</button>
        </div>
        {unreleased > 0 && <div className="muted" style={{ marginTop: 8 }}>{unreleased} grade(s) not yet released.</div>}
      </form>

      <form className="card" onSubmit={scheduleExam}>
        <h2 style={{ marginTop: 0 }}>Schedule an exam</h2>
        <div className="grid cols3">
          <div>
            <label htmlFor="examTitle">Title</label>
            <input id="examTitle" value={examTitle} onChange={(e) => setExamTitle(e.target.value)} required maxLength={160} placeholder="First Term Examination" />
          </div>
          <div>
            <label htmlFor="examDate">Date</label>
            <input id="examDate" type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="examMax">Max score</label>
            <input id="examMax" inputMode="decimal" value={examMax} onChange={(e) => setExamMax(e.target.value)} required />
          </div>
        </div>
        {exams.length > 0 && (
          <div className="row muted" style={{ marginTop: 8 }}>
            Scheduled: {exams.map((x) => `${x.title} (${x.examDate})`).join(" · ")}
          </div>
        )}
        <button className="btn" style={{ marginTop: 12 }} disabled={busy || !examTitle || !examDate}>Schedule exam</button>
      </form>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>All grades</h2>
        {grades.length === 0 ? <div className="muted">No grades yet.</div> : (
          <table>
            <thead><tr><th>Student</th><th>Label</th><th>Type</th><th>Points</th><th>Visible to family</th></tr></thead>
            <tbody>
              {grades.map((g) => (
                <tr key={g.id}>
                  <td>{name(g.studentUserId)}</td>
                  <td>{g.label}{g.feedbackText ? <div className="muted">{g.feedbackText}</div> : null}</td>
                  <td>{g.sourceType}</td>
                  <td>{g.points} / {g.maxPoints}</td>
                  <td>{g.releasedAt ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
