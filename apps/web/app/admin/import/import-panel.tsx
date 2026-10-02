"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

const KINDS = [
  { id: "students", label: "1 · Students", header: "email,display_name,password*,admission_no,grade_level" },
  { id: "staff", label: "2 · Staff", header: "email,display_name,password*,role" },
  { id: "sections", label: "3 · Classes", header: "course_code,course_title,name,term_name" },
  { id: "enrollments", label: "4 · Enrolments", header: "student_admission_no,course_code,section_name,term_name" },
  { id: "guardians", label: "5 · Parents + links", header: "student_admission_no,guardian_email,relationship,guardian_name" },
] as const;

interface JobView {
  id: string; kind: string; dryRun: boolean; state: string;
  filename: string | null; totalRows: number; processedRows: number;
  createdCount: number; duplicateCount: number; errorCount: number;
  problems: { row: number; status: string; errors?: string[] }[];
  secretCount: number; errorMessage: string | null; percent: number;
}

function csrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export default function ImportPanel() {
  const [kind, setKind] = useState<string>("students");
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll while the job is in flight; stop the moment it settles.
  useEffect(() => {
    if (!job || (job.state !== "pending" && job.state !== "running")) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const next = await api<JobView>(`/import/jobs/${job.id}`);
        setJob(next);
      } catch { /* transient — keep polling */ }
    }, 1000);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [job]);

  /**
   * XHR rather than fetch: a whole-school roster takes real time to upload and
   * an admin staring at a dead button will reload the page halfway through.
   * XHR gives us upload progress; fetch does not.
   */
  function upload(dryRun: boolean) {
    if (!file) return;
    setBusy(true); setErr(""); setJob(null); setUploadPct(0);
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1/import/${kind}/upload?dry_run=${dryRun}`);
    xhr.setRequestHeader("x-csrf", csrf());
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploadPct(null); setBusy(false);
      let body: any = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
      if (xhr.status >= 400) {
        setErr(body?.detail ?? body?.title ?? `Upload failed (${xhr.status})`);
        return;
      }
      setJob({
        id: body.job_id, kind: body.kind, dryRun: body.dry_run, state: "pending",
        filename: body.filename, totalRows: 0, processedRows: 0, createdCount: 0,
        duplicateCount: 0, errorCount: 0, problems: [], secretCount: 0,
        errorMessage: null, percent: 0,
      });
    };
    xhr.onerror = () => { setUploadPct(null); setBusy(false); setErr("Network error during upload"); };
    xhr.send(form);
  }

  const inFlight = job && (job.state === "pending" || job.state === "running");
  const done = job && job.state === "completed";
  const current = KINDS.find((k) => k.id === kind);

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Import a roster</h2>
        <p className="muted">
          Import in the numbered order — enrolments need classes, and parents need students.
          Whole-school files are processed in the background, so you can leave this page.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <select value={kind} onChange={(e) => { setKind(e.target.value); setJob(null); setErr(""); }}
                  disabled={busy || !!inFlight}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <input ref={fileRef} type="file" accept=".csv,text/csv"
                 disabled={busy || !!inFlight}
                 onChange={(e) => { setFile(e.target.files?.[0] ?? null); setJob(null); setErr(""); }} />
          <a className="btn ghost" href={`/api/v1/import/${kind}/template.csv`}>
            Download blank template
          </a>
        </div>
        <p className="muted">
          Expected header: <code>{current?.header}</code>
        </p>
        <p className="muted">
          The <code>password</code> column is optional for students and staff — leave it blank and each
          person gets an emailed link to choose their own password, so no plaintext credentials sit in
          your spreadsheet. A supplied password is treated as temporary: the account is locked until
          they change it at first sign-in.
        </p>
        {file ? (
          <p className="muted">
            Selected: <strong>{file.name}</strong> ({(file.size / 1024).toFixed(0)} KB)
          </p>
        ) : null}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn" disabled={busy || !file || !!inFlight} onClick={() => upload(true)}>
            Dry run
          </button>
          <button className="btn ghost"
                  disabled={busy || !file || !!inFlight || !done || !job?.dryRun || (job?.errorCount ?? 1) > 0}
                  onClick={() => upload(false)}>
            Commit import
          </button>
        </div>
        <p className="muted">
          Always dry-run first: it checks every row and writes nothing. Commit unlocks after a clean
          dry run. Re-running a corrected file is safe — rows that already exist are skipped.
        </p>
      </div>

      {uploadPct !== null ? (
        <div className="card">
          <p>Uploading… {uploadPct}%</p>
          <Progress percent={uploadPct} />
        </div>
      ) : null}

      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}

      {job ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            {job.dryRun ? "Dry run" : "Import"} — {job.kind}
            {job.filename ? <span className="muted" style={{ fontWeight: 400 }}> · {job.filename}</span> : null}
          </h2>

          {inFlight ? (
            <>
              <p>
                {job.state === "pending" ? "Waiting to start…" : "Processing"}
                {job.totalRows ? ` — row ${job.processedRows} of ${job.totalRows}` : ""}
              </p>
              <Progress percent={job.percent} />
              <p className="muted">
                You can leave this page; the import continues in the background.
              </p>
            </>
          ) : null}

          {job.state === "failed" ? (
            <p style={{ color: "#b91c1c" }}>
              The import stopped: {job.errorMessage ?? "unknown error"}.
              {job.processedRows > 0
                ? ` ${job.processedRows} row(s) were already applied — fix the problem and re-upload the same file; rows that landed will be skipped.`
                : " Nothing was written."}
            </p>
          ) : null}

          {job.state === "cancelled" ? (
            <p className="muted">Cancelled after {job.processedRows} row(s). Those rows remain imported.</p>
          ) : null}

          {done ? (
            <>
              <div className="grid cols3">
                <div className="stat">
                  <div className="muted">{job.dryRun ? "Would be created" : "Created"}</div>
                  <div className="n">{job.createdCount}</div>
                </div>
                <div className="stat">
                  <div className="muted">Already present</div>
                  <div className="n">{job.duplicateCount}</div>
                </div>
                <div className="stat">
                  <div className="muted">Problems</div>
                  <div className="n" style={{ color: job.errorCount ? "#b91c1c" : undefined }}>
                    {job.errorCount}
                  </div>
                </div>
              </div>
              <p className="muted">{job.totalRows} row(s) read.</p>

              {job.errorCount > 0 ? (
                <>
                  <p>
                    <a className="btn" href={`/api/v1/import/jobs/${job.id}/errors.csv`}>
                      Download problem rows (CSV)
                    </a>
                  </p>
                  <p className="muted">
                    Open it in Excel beside your original file, fix the listed rows, and upload again.
                    {job.dryRun ? " Nothing was written." : " Valid rows were imported; only these were skipped."}
                  </p>
                  <table>
                    <thead><tr><th>Row</th><th>Status</th><th>Problem</th></tr></thead>
                    <tbody>
                      {job.problems.slice(0, 25).map((p) => (
                        <tr key={p.row}>
                          <td>{p.row}</td><td>{p.status}</td><td>{(p.errors ?? []).join("; ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {job.problems.length > 25 ? (
                    <p className="muted">Showing the first 25 — the download has all {job.errorCount}.</p>
                  ) : null}
                </>
              ) : (
                <p style={{ color: "#15803d" }}>Every row is valid.</p>
              )}

              {job.secretCount > 0 ? (
                <div style={{ marginTop: 16, padding: 12, border: "1px solid #b45309", borderRadius: 6 }}>
                  <strong>{job.secretCount} set-password link(s) to hand out</strong>
                  <p className="muted" style={{ margin: "4px 0 8px" }}>
                    No email server is configured, so these links could not be sent. Download them now —
                    they are shown once and expire in 24 hours.
                  </p>
                  <a className="btn" href={`/api/v1/import/jobs/${job.id}/credentials.csv`}>
                    Download links (once)
                  </a>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Progress({ percent }: { percent: number }) {
  return (
    <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
         style={{ background: "#e5e7eb", borderRadius: 999, height: 10, overflow: "hidden" }}>
      <div style={{
        width: `${Math.min(100, Math.max(0, percent))}%`, height: "100%",
        background: "#1d4ed8", transition: "width .3s ease",
      }} />
    </div>
  );
}
