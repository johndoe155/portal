"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

type CheckStatus = "pass" | "warn" | "fail";
interface Check {
  id: string; group: string; label: string; status: CheckStatus; detail: string; fix?: string;
}
interface Readiness {
  ready: boolean; checkedAt: string;
  summary: { pass: number; warn: number; fail: number };
  checks: Check[];
}

const MARK: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✕" };
const COLOUR: Record<CheckStatus, string> = { pass: "#047857", warn: "#b45309", fail: "#b91c1c" };

/**
 * Go-live readiness.
 *
 * The pilot runbook ended with a prose checklist — confirm SMTP, confirm
 * backups, confirm the DPO address. Nobody runs a checklist in a markdown
 * file, and every item on it is something that looks fine until the morning
 * it matters. This is the same list, executed.
 */
export default function GoLive() {
  const [r, setR] = useState<Readiness | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try { setR(await api<Readiness>("/reports/go-live")); setErr(""); }
    catch (e: any) { setErr(e?.detail ?? e?.message ?? "Could not run the readiness checks"); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!r) {
    return <div className="card"><h2 style={{ marginTop: 0 }}>Go-live readiness</h2>
      <div className="muted">{err || "Checking…"}</div></div>;
  }

  const groups = Array.from(new Set(r.checks.map((c) => c.group)));

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Go-live readiness</h2>
      {err && <p className="error" role="alert">{err}</p>}

      <div style={{
        border: `1px solid ${r.ready ? "#047857" : "#b91c1c"}`,
        background: r.ready ? "#ecfdf5" : "#fef2f2",
        padding: 12, borderRadius: 6, marginBottom: 16,
      }}>
        <strong style={{ color: r.ready ? "#047857" : "#b91c1c" }}>
          {r.ready
            ? "Ready — no blocking problems."
            : `Not ready — ${r.summary.fail} blocking problem(s).`}
        </strong>
        <div className="muted" style={{ marginTop: 4 }}>
          {r.summary.pass} passing · {r.summary.warn} worth fixing · {r.summary.fail} blocking.
          {" "}Warnings will not stop the school working, but somebody will notice them.
        </div>
      </div>

      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 6px" }}>{g}</h3>
          <table className="table">
            <tbody>
              {r.checks.filter((c) => c.group === g).map((c) => (
                <tr key={c.id}>
                  <td style={{ width: 28, color: COLOUR[c.status], fontWeight: 700, textAlign: "center" }}
                      aria-label={c.status}>
                    {MARK[c.status]}
                  </td>
                  <td style={{ width: "30%" }}>{c.label}</td>
                  <td>
                    {c.detail}
                    {c.status !== "pass" && c.fix && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        Fix: {c.fix.startsWith("/") ? <a href={c.fix}>{c.fix}</a> : c.fix}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <button className="btn ghost" onClick={load} disabled={busy}>
        {busy ? "Checking…" : "Re-check"}
      </button>
      <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
        Checked {new Date(r.checkedAt).toLocaleString()}
      </span>
    </div>
  );
}
