"use client";
import { useState } from "react";
import { api } from "@/lib/client";

/** Admin side of controlled TOTP enrolment: issue a single-use token (shown once),
 *  or reset a lost authenticator so the person can re-enrol. */
export default function MfaManager({ userId }: { userId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function issue() {
    setBusy(true); setErr(""); setMsg(""); setToken(null);
    try {
      const out = await api<{ token: string; expiresAt: string }>(`/users/${userId}/mfa-enroll-token`, { method: "POST" });
      setToken(out.token);
    } catch (e: any) { setErr(e?.message ?? "Could not issue token"); }
    setBusy(false);
  }
  async function reset() {
    setBusy(true); setErr(""); setMsg(""); setToken(null);
    try {
      await api(`/users/${userId}/mfa-reset`, { method: "POST" });
      setMsg("Authenticator reset — issue a new enrolment token and hand it over a trusted channel.");
    } catch (e: any) { setErr(e?.message ?? "Reset failed"); }
    setBusy(false);
  }
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Two-factor authentication</h2>
      <p className="muted">
        Enrolment is controlled: the person needs a <strong>single-use token</strong> (24 h) to add an
        authenticator. Send it over a trusted channel — never by the same route as their password.
      </p>
      <p>
        <button className="btn" onClick={issue} disabled={busy}>Issue enrolment token</button>{" "}
        <button className="btn ghost" onClick={reset} disabled={busy}>Reset authenticator</button>
      </p>
      {token ? (
        <div className="alert ok" role="status">
          <strong>Token (shown once):</strong> <code>{token}</code>
        </div>
      ) : null}
      {msg ? <p className="muted">{msg}</p> : null}
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}
    </div>
  );
}
