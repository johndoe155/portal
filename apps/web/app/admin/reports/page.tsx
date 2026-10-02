import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";

interface Recon {
  sections: { id: string; name: string; course: string; head_count: number }[];
  parents_without_children: { id: string; email: string; displayName: string }[];
  students_without_guardians: { userId: string; admissionNo: string; displayName: string }[];
  students_without_enrollments: { userId: string; admissionNo: string }[];
  pending_guardian_links: number;
}

export default async function AdminReports() {
  const session = await requireRole("super_admin", "school_admin");
  const rep = await apiGet<Recon>("/reports/reconciliation");
  return (
    <Shell session={session}>
      <h1>Reconciliation</h1>
      <p className="muted">Run this before go-live: every class should have its head-count, every child a guardian, every parent a child.</p>
      {!rep ? <p className="muted">Report unavailable.</p> : (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Class head-counts</h2>
            <table>
              <thead><tr><th>Course</th><th>Section</th><th>Enrolled</th></tr></thead>
              <tbody>
                {rep.sections.map((s) => <tr key={s.id}><td>{s.course}</td><td>{s.name}</td><td>{s.head_count}</td></tr>)}
                {rep.sections.length === 0 ? <tr><td colSpan={3} className="muted">No sections yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Parents with no child linked ({rep.parents_without_children.length})</h2>
            <ul>{rep.parents_without_children.map((p) => <li key={p.id}>{p.displayName} · {p.email}</li>)}</ul>
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Students with no verified guardian ({rep.students_without_guardians.length})</h2>
            <ul>{rep.students_without_guardians.map((s) => <li key={s.userId}>{s.admissionNo} · {s.displayName}</li>)}</ul>
            <h2>Students with no enrolment ({rep.students_without_enrollments.length})</h2>
            <ul>{rep.students_without_enrollments.map((s) => <li key={s.userId}>{s.admissionNo}</li>)}</ul>
            <h2>Pending guardian links</h2>
            <p>{rep.pending_guardian_links} awaiting verification</p>
          </div>
        </>
      )}
    </Shell>
  );
}
