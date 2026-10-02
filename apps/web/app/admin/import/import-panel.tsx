"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/client";

const KINDS = [
  { id: "students", label: "Students", header: "email,display_name,password*,admission_no,grade_level" },
  { id: "staff", label: "Staff", header: "email,display_name,password*,role" },
  { id: "guardians", label: "Parents + links", header: "student_admission_no,guardian_email,relationship,guardian_name" },
  { id: "sections", label: "Classes", header: "course_code,course_title,name,term_name" },
  { id: "enrollments", label: "Enrolments", header: "student_admission_no,course_code,section_name,term_name" },
] as const;

interface ImportResult {
  kind: string; dry_run: boolean; total: number; valid: number; duplicates: number; errors: number;
  created?: number; would_create?: number;
  /** every problem row (no cap); ok rows are omitted */
  rows: { row: number; status: string; errors?: string[]; set_password_url?: string }[];
}

export default function ImportPanel() {
  const [kind, setKind] = useState<string>("students");
  const [csv, setCsv] = useState("");
  const [res, setRes] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(dryRun: boolean) {
    setBusy(true); setErr(""); setRes(null);
    try {
      const out = await api<ImportResult>(`/import/${kind}`, {
        method: "POST", body: JSON.stringify({ csv, dry_run: dryRun }),
      });
      setRes(out);
    } catch (e: any) { setErr(e?.message ?? "Import failed"); }
    setBusy(false);
  }

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <select value={kind} onChange={(e) => { setKind(e.target.value); setRes(null); }}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <input ref={fileRef} type="file" accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setCsv(await f.text());
            }} />
        </div>
        <p className="muted">Expected header: <code>{KINDS.find((k) => k.id === kind)?.header}</code></p>
        <p className="muted">The <code>password</code> column is optional for students and staff — leave it blank and each person gets an emailed link to choose their own password (no plaintext in your CSV). A supplied password is temporary: the account is locked until they change it at first login.</p>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8}
          placeholder={"Paste CSV here, or choose a file above.\n" + (KINDS.find((k) => k.id === kind)?.header ?? "")}
          style={{ width: "100%", fontFamily: "monospace" }} />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn" disabled={busy || !csv.trim()} onClick={() => run(true)}>Dry run</button>
          <button className="btn ghost" disabled={busy || !csv.trim() || !res || res.dry_run === false || res.errors > 0}
            onClick={() => run(false)}>Commit import</button>
        </div>
        <p className="muted">Commit unlocks after a clean dry run (rows with errors are skipped and reported).</p>
      </div>

      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}
      {res ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>{res.dry_run ? "Dry run" : "Committed"} — {res.kind}</h2>
          <p>
            {res.total} row(s) · {res.dry_run ? `${res.would_create} would be created` : `${res.created} created`} ·
            {" "}{res.duplicates} duplicate(s) skipped · {res.errors} error(s)
          </p>
          {res.rows.some((r) => r.status !== "ok") ? (
            <>
              <p className="muted">
                {res.rows.filter((r) => r.status !== "ok").length} problem/duplicate row(s) — all listed{res.rows.filter((r) => r.status !== "ok").length > 100 ? `, showing the first 100` : ""}.
              </p>
              <table>
                <thead><tr><th>Row</th><th>Status</th><th>Problems</th></tr></thead>
                <tbody>
                  {res.rows.filter((r) => r.status !== "ok").slice(0, 100).map((r) => (
                    <tr key={r.row}>
                      <td>{r.row}</td><td>{r.status}</td><td>{(r.errors ?? []).join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : <p className="muted">Every row is valid.</p>}
          {res.rows.some((r) => r.set_password_url) ? (
            <div>
              <h3>Set-password links (shown once — no email server configured)</h3>
              <p className="muted">Hand each person their link; they choose their own password. With SMTP configured these are emailed instead and not shown here.</p>
              <ul style={{ fontSize: 12, wordBreak: "break-all" }}>
                {res.rows.filter((r) => r.set_password_url).map((r) => <li key={r.row}>row {r.row}: {r.set_password_url}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
