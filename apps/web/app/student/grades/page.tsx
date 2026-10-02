import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";

interface GradeRow {
  id: string; label: string; points: string; maxPoints: string;
  sourceType: string; feedbackText: string | null; releasedAt: string;
}

interface ReportCard { id: string; snapshot: { term: string; generatedAt: string;
  sections: { section: string; course: string; grades: { label: string; points: string; maxPoints: string }[];
    exam_pct?: number | null; coursework_pct?: number | null; weighted_pct?: number | null;
    letter?: string | null; point?: number | null;
    attendance: Record<string, number> }[];
  overall?: { average_pct: number | null; gpa: number | null; letter: string | null } } }

export default async function StudentGrades() {
  const session = await requireRole("student");
  const [g, rc] = await Promise.all([
    apiGet<{ data: GradeRow[] }>("/student/grades"),
    apiGet<{ data: ReportCard[] }>(`/students/${session.userId}/report-card`),
  ]);
  const grades = [...(g?.data ?? [])].sort((x, y) => (y.releasedAt ?? "").localeCompare(x.releasedAt ?? ""));
  const card = rc?.data[0];
  return (
    <Shell session={session}>
      <h1>My grades</h1>
      <p className="muted">Only grades your teacher has released are shown here.</p>
      <div className="card">
        {grades.length === 0 ? <div className="muted">No released grades yet.</div> : (
          <table>
            <thead><tr><th>Label</th><th>Type</th><th>Points</th><th>%</th><th>Feedback</th></tr></thead>
            <tbody>
              {grades.map((gr) => (
                <tr key={gr.id}>
                  <td>{gr.label}</td>
                  <td>{gr.sourceType}</td>
                  <td>{gr.points} / {gr.maxPoints}</td>
                  <td>{Math.round((Number(gr.points) / Number(gr.maxPoints)) * 100)}%</td>
                  <td className="muted">{gr.feedbackText ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Report card</h2>
        {!card ? <div className="muted">No report-card snapshot has been generated yet.</div> : (
          <>
            <div className="muted">{card.snapshot.term} · generated {card.snapshot.generatedAt.slice(0, 10)}</div>
            {card.snapshot.overall ? (
              <p style={{ fontSize: 18, margin: "8px 0" }}>
                <strong>{card.snapshot.overall.letter ?? "—"}</strong>
                <span className="muted"> · average {card.snapshot.overall.average_pct ?? "—"}%{card.snapshot.overall.gpa != null ? ` · GPA ${card.snapshot.overall.gpa}` : ""}</span>
              </p>
            ) : null}
            {card.snapshot.sections.map((sec) => (
              <div key={sec.section} style={{ marginTop: 10 }}>
                <strong>{sec.section}</strong> <span className="muted">({sec.course})</span>
                {sec.letter ? <span style={{ marginLeft: 8 }}><strong>{sec.letter}</strong> <span className="muted">({sec.weighted_pct}%)</span></span> : null}
                <table>
                  <tbody>
                    {sec.grades.map((gr) => (
                      <tr key={gr.label}><td>{gr.label}</td><td>{gr.points} / {gr.maxPoints}</td></tr>
                    ))}
                    {sec.exam_pct != null || sec.coursework_pct != null ? (
                      <tr><td className="muted">Exam {sec.exam_pct ?? "—"}% · Coursework {sec.coursework_pct ?? "—"}%</td>
                        <td className="muted">weighted {sec.weighted_pct ?? "—"}%</td></tr>
                    ) : null}
                    <tr><td className="muted">Attendance</td>
                      <td className="muted">{Object.entries(sec.attendance).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}</td></tr>
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}
      </div>
    </Shell>
  );
}
