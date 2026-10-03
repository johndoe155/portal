"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Staff {
  id: string; email: string; displayName: string; roles: string[];
  enrolled: boolean; pendingToken: boolean; status: string;
}
interface Coverage {
  total: number; enrolled: number; outstanding: number; pendingTokens: number;
  percent: number; data: Staff[];
}
interface Issued {
  issued: number; emailed: number; expiresAt: string; note: string;
  skipped: { userId: string; email: string; reason: string }[];
  data: { userId: string; email: string; displayName: string; token?: string }[];
}

/**
 * Two-factor rollout.
 *
 * Enrolment tokens could only be issued one person at a time, which for a
 * staff of sixty is an afternoon of clicking — so it does not get done. This
 * shows how far the rollout has got and covers everyone outstanding in one
 * action, with a printable sheet for the staff meeting where it realistically
 * happens.
 */
export default function MfaRollout() {
  const [cov, setCov] = useState<Coverage | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Issued | null>(null);
  const [show, setShow] = useState(false);

  const load = useCallback(async () => {
    try { setCov(await api<Coverage>("/mfa/coverage")); }
    catch (e: any) { setErr(e?.message ?? "Could not load two-factor coverage"); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function issueAll(deliver?: "print") {
    setBusy(true); setErr(""); setResult(null);
    try {
      const res = await api<Issued>("/mfa/enroll-tokens/bulk", {
        method: "POST",
        body: JSON.stringify({ scope: "outstanding", ...(deliver ? { deliver } : {}) }),
      });
      setResult(res);
      await load();
    } catch (e: any) {
      setErr(e?.detail ?? e?.message ?? "Could not issue enrolment tokens");
    } finally { setBusy(false); }
  }

  if (!cov) {
    return <div className="card"><h2 style={{ marginTop: 0 }}>Two-factor rollout</h2>
      <div className="muted">{err || "Loading…"}</div></div>;
  }

  const done = cov.outstanding === 0;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ marginTop: 0 }}>Two-factor rollout</h2>
        <button className="btn ghost" style={{ padding: "2px 8px", fontSize: ".8rem" }}
          onClick={() => setShow(!show)}>
          {show ? "Hide list" : "Show staff"}
        </button>
      </div>

      {/* Progress: a number people can finish. */}
      <div style={{ margin: "4px 0 10px" }}>
        <div style={{ height: 8, background: "var(--line, #e5e5e5)", borderRadius: 4, overflow: "hidden" }}>
          <div style={{
            width: `${cov.percent}%`, height: "100%",
            background: done ? "var(--ok, #067647)" : "var(--warn, #b54708)",
          }} />
        </div>
        <p className="muted" style={{ fontSize: ".85rem", margin: "6px 0 0" }}>
          {cov.enrolled} of {cov.total} staff enrolled ({cov.percent}%).{" "}
          {done
            ? "Everyone is covered."
            : `${cov.outstanding} still to go${cov.pendingTokens ? `, ${cov.pendingTokens} already hold a token` : ""}.`}
        </p>
      </div>

      {!done && (
        <div className="row">
          <button className="btn" onClick={() => issueAll()} disabled={busy}>
            {busy ? "Issuing…" : `Email enrolment links to all ${cov.outstanding}`}
          </button>
          <button className="btn ghost" onClick={() => issueAll("print")} disabled={busy}>
            Issue + show printable sheet
          </button>
        </div>
      )}

      {err && <p style={{ color: "var(--danger, #b42318)" }}>{err}</p>}

      {result && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <p style={{ marginTop: 0 }}>
            <strong>{result.issued}</strong> token(s) issued
            {result.emailed > 0 && `, ${result.emailed} emailed`}. Valid until{" "}
            {new Date(result.expiresAt).toLocaleDateString()}.
          </p>
          {result.skipped.length > 0 && (
            <details>
              <summary className="muted" style={{ fontSize: ".85rem" }}>
                {result.skipped.length} skipped
              </summary>
              <ul style={{ fontSize: ".85rem" }}>
                {result.skipped.map((s) => <li key={s.userId}>{s.email} — {s.reason}</li>)}
              </ul>
            </details>
          )}
          {result.data.some((d) => d.token) && (
            <>
              <p style={{ color: "var(--danger, #b42318)", fontSize: ".85rem" }}>{result.note}</p>
              <table style={{ fontSize: ".85rem" }}>
                <thead><tr><th>Name</th><th>Email</th><th>Enrolment code</th></tr></thead>
                <tbody>
                  {result.data.map((d) => (
                    <tr key={d.userId}>
                      <td>{d.displayName}</td><td>{d.email}</td>
                      <td><code style={{ fontSize: ".8rem", wordBreak: "break-all" }}>{d.token}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn ghost" onClick={() => window.print()} style={{ marginTop: 8 }}>
                Print this sheet
              </button>
            </>
          )}
        </div>
      )}

      {show && (
        <table style={{ marginTop: 12, fontSize: ".88rem" }}>
          <thead><tr><th>Name</th><th>Role</th><th>Two-factor</th></tr></thead>
          <tbody>
            {cov.data.map((s) => (
              <tr key={s.id}>
                <td>{s.displayName}<br /><span className="muted" style={{ fontSize: ".78rem" }}>{s.email}</span></td>
                <td className="muted">{s.roles.join(", ")}</td>
                <td>
                  {s.enrolled
                    ? <span style={{ color: "var(--ok, #067647)" }}>✅ Enrolled</span>
                    : s.pendingToken
                      ? <span style={{ color: "var(--warn, #b54708)" }}>Token issued, not used</span>
                      : <span style={{ color: "var(--danger, #b42318)" }}>Not set up</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
