import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";

interface GradeRow { id: string; label: string; points: string; maxPoints: string; sourceType: string; releasedAt: string }
interface AttRow { date: string; status: string; sectionId: string; note: string | null }
interface ExamRow { id: string; title: string; examDate: string; maxScore: string }
interface Transport { assignment: { id: string }; route: { name: string; driverName: string | null }; stop: { name: string; pickupTime: string | null } | null }
interface Invoice { id: string; label: string; amountKobo: number; status: string; dueDate: string | null }

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

export default async function StudentHome() {
  const session = await requireRole("student");
  const [g, a, ex, tr, fees] = await Promise.all([
    apiGet<{ data: GradeRow[] }>("/student/grades"),
    apiGet<{ data: AttRow[] }>("/student/attendance"),
    apiGet<{ data: ExamRow[] }>("/student/exams"),
    apiGet<{ data: Transport | null }>("/student/transport"),
    apiGet<{ data: { invoices: Invoice[] } }>("/fees/my"),
  ]);
  const grades = g?.data ?? [];
  const att = a?.data ?? [];
  const exams = [...(ex?.data ?? [])].sort((x, y) => x.examDate.localeCompare(y.examDate));
  const transport = tr?.data;
  const invoices = fees?.data.invoices ?? [];
  const counts = ["present", "late", "absent", "excused"].map((st) => ({
    st, n: att.filter((r) => r.status === st).length,
  }));
  const latest = [...grades].sort((x, y) => (y.releasedAt ?? "").localeCompare(x.releasedAt ?? "")).slice(0, 5);

  return (
    <Shell session={session}>
      <h1>Hello, {session.displayName.split(" ")[0]}</h1>
      <div className="grid cols2">
        {counts.map(({ st, n }) => (
          <div className="stat" key={st}><div className="muted">{st}</div><div className="n">{n}</div></div>
        ))}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Latest released grades</h2>
        {latest.length === 0 ? <div className="muted">No grades released yet.</div> : (
          <table>
            <thead><tr><th>Label</th><th>Type</th><th>Points</th><th>Released</th></tr></thead>
            <tbody>
              {latest.map((gr) => (
                <tr key={gr.id}><td>{gr.label}</td><td>{gr.sourceType}</td>
                  <td>{gr.points} / {gr.maxPoints}</td><td>{gr.releasedAt.slice(0, 10)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Upcoming exams</h2>
        {exams.length === 0 ? <div className="muted">No exams scheduled.</div> : (
          <table>
            <thead><tr><th>Exam</th><th>Date</th><th>Max</th></tr></thead>
            <tbody>
              {exams.map((e) => (
                <tr key={e.id}><td>{e.title}</td><td>{e.examDate}</td><td>{e.maxScore}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>School transport</h2>
        {!transport ? <div className="muted">No transport assignment.</div> : (
          <div>
            <div><strong>{transport.route.name}</strong></div>
            <div className="muted">
              {transport.route.driverName ? `Driver: ${transport.route.driverName}` : ""}
              {transport.stop ? ` · Stop: ${transport.stop.name}${transport.stop.pickupTime ? ` at ${transport.stop.pickupTime}` : ""}` : ""}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Fees</h2>
        {invoices.length === 0 ? <div className="muted">No invoices.</div> : (
          <table>
            <thead><tr><th>Label</th><th>Amount</th><th>Status</th><th>Due</th></tr></thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.label}</td>
                  <td>{naira(inv.amountKobo)}</td>
                  <td><span className={`chip ${inv.status === "paid" ? "on-present" : inv.status === "partial" ? "on-late" : "on-absent"}`} style={{ cursor: "default" }}>{inv.status}</span></td>
                  <td>{inv.dueDate ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recent attendance</h2>
        {att.length === 0 ? <div className="muted">No attendance recorded yet.</div> : (
          <table>
            <thead><tr><th>Date</th><th>Status</th><th>Note</th></tr></thead>
            <tbody>
              {[...att].sort((x, y) => y.date.localeCompare(x.date)).slice(0, 7).map((r, i) => (
                <tr key={`${r.date}-${i}`}><td>{r.date}</td>
                  <td><span className={`chip on-${r.status}`} style={{ cursor: "default" }}>{r.status}</span></td>
                  <td className="muted">{r.note ?? ""}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
