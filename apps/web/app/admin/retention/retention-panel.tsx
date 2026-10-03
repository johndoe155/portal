"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Windows {
  notificationsDays: number; sessionsDays: number; tokensDays: number;
  idempotencyDays: number;
  importJobsDays: number; leaverAnonymiseDays: number;
}
interface Run {
  id: string; startedAt: string; finishedAt: string | null; dryRun: boolean;
  trigger: string; counts: Record<string, number>; ok: boolean; error: string | null;
}
interface Status {
  windows: Windows;
  lastRun: { id: string; finishedAt: string; counts: Record<string, number>; ageHours: number } | null;
  stale: boolean;
  runs: Run[];
}
interface RunResult {
  dryRun: boolean; counts: Record<string, number>; total: number;
  notes: string[]; ok: boolean; error?: string;
}

const LABELS: Record<string, string> = {
  notifications: "Delivered emails",
  sessions: "Expired sessions",
  passwordResetTokens: "Spent password-reset tokens",
  userInvites: "Spent invitations",
  mfaEnrollTokens: "Spent two-factor enrolment tokens",
  idempotencyKeys: "Replay-protection keys",
  importJobs: "Finished import jobs (and their uploaded files)",
  leaversAnonymised: "Leavers anonymised",
};

const WINDOW_ROWS: { key: keyof Windows; label: string; unit: string }[] = [
  { key: "notificationsDays", label: "Delivered emails", unit: "days" },
  { key: "sessionsDays", label: "Expired or revoked sessions", unit: "days" },
  { key: "tokensDays", label: "Spent reset / invite / enrolment tokens", unit: "days" },
  { key: "importJobsDays", label: "Finished import jobs and uploaded rosters", unit: "days" },
  { key: "idempotencyDays", label: "Replay-protection keys", unit: "days" },
  { key: "leaverAnonymiseDays", label: "Anonymise leavers after", unit: "days" },
];

/**
 * The purge, made visible.
 *
 * A retention policy nobody can see running is indistinguishable from one that
 * is not running — and until now it genuinely was not. This shows the windows
 * in force, when the job last ran, what it removed, and lets an administrator
 * preview the next sweep before it happens.
 */
export default function RetentionPanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try { setSt(await api<Status>("/admin/retention")); }
    catch (e: any) { setErr(e?.detail ?? e?.message ?? "Could not load retention status"); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(dryRun: boolean) {
    setBusy(true); setErr(""); setResult(null);
    try {
      setResult(await api<RunResult>("/admin/retention/run", {
        method: "POST", body: JSON.stringify({ dry_run: dryRun }),
      }));
      setConfirming(false);
      if (!dryRun) await load();
    } catch (e: any) {
      setErr(e?.detail ?? e?.message ?? "The purge could not run");
    } finally { setBusy(false); }
  }

  if (!st) {
    return <div className="card"><h2 style={{ marginTop: 0 }}>Retention schedule</h2>
      <div className="muted">{err || "Loading…"}</div></div>;
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Retention schedule</h2>
      {err && <p className="error" role="alert">{err}</p>}

      {st.stale ? (
        <p style={{ border: "1px solid #b45309", background: "#fffbeb", padding: 12, borderRadius: 6 }}>
          <strong>The purge has not run recently.</strong>{" "}
          {st.lastRun
            ? `Last completed ${Math.round(st.lastRun.ageHours)} hours ago.`
            : "It has never completed."}{" "}
          It runs in the worker process — if that is not running, the retention policy published at
          /legal/retention is not being honoured.
        </p>
      ) : (
        <p className="muted">
          Last purge completed {Math.round(st.lastRun!.ageHours)} hour(s) ago, removing{" "}
          {Object.values(st.lastRun!.counts).reduce((a, b) => a + b, 0)} record(s).
        </p>
      )}

      <h3>Windows in force</h3>
      <table className="table">
        <thead><tr><th>Data</th><th>Removed after</th></tr></thead>
        <tbody>
          {WINDOW_ROWS.map((r) => {
            const v = st.windows[r.key];
            return (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td>
                  {v === 0 && r.key === "leaverAnonymiseDays"
                    ? <span className="muted">off — not configured</span>
                    : `${v} ${r.unit}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 13 }}>
        Marks, attendance, enrolments, fee records, report cards and the audit log are never touched
        by this job — they are statutory records with their own, longer windows.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={() => run(true)} disabled={busy}>
          {busy ? "Working…" : "Preview the next purge"}
        </button>
        {confirming ? (
          <>
            <button className="btn danger" onClick={() => run(false)} disabled={busy}>
              Yes, purge now
            </button>
            <button className="btn ghost" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn ghost" onClick={() => setConfirming(true)} disabled={busy}>
            Run a purge now
          </button>
        )}
      </div>

      {result && (
        <div style={{ marginTop: 16, borderTop: "1px solid #ddd", paddingTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>
            {result.dryRun ? "Preview — nothing was deleted" : "Purge complete"}
          </h3>
          {result.total === 0
            ? <p className="muted">Nothing is currently past its retention window.</p>
            : (
              <table className="table">
                <thead><tr><th>Data</th><th>{result.dryRun ? "Would remove" : "Removed"}</th></tr></thead>
                <tbody>
                  {Object.entries(result.counts).filter(([, n]) => n > 0).map(([k, n]) => (
                    <tr key={k}><td>{LABELS[k] ?? k}</td><td>{n}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          {result.notes.map((n, i) => <p key={i} className="muted" style={{ fontSize: 13 }}>{n}</p>)}
        </div>
      )}

      {st.runs.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h3>Recent runs</h3>
          <table className="table">
            <thead><tr><th>When</th><th>Trigger</th><th>Removed</th><th>Result</th></tr></thead>
            <tbody>
              {st.runs.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.startedAt).toLocaleString()}</td>
                  <td>{r.dryRun ? "preview" : r.trigger}</td>
                  <td>{Object.values(r.counts ?? {}).reduce((a, b) => a + b, 0)}</td>
                  <td>{r.ok ? "ok" : <span className="error">{r.error ?? "failed"}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
