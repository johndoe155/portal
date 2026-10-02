"use client";
import { useState } from "react";
import { api } from "@/lib/client";

export default function ForgotForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("/auth/password/forgot", { method: "POST", body: JSON.stringify({ email }) });
      setSent(true);
    } catch (e: any) {
      setErr(e?.message ?? "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="card" role="status">
        <strong>Check your inbox</strong>
        <p className="muted" style={{ marginTop: 8 }}>
          If that email has a portal account, a reset link is on its way.
          The link expires after one hour and can be used once.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card" aria-label="Forgot password">
      {err && <div className="alert err" role="alert">{err}</div>}
      <label htmlFor="email">School email</label>
      <input id="email" type="email" autoComplete="email" value={email}
        onChange={(e) => setEmail(e.target.value)} required autoFocus />
      <button className="btn" style={{ marginTop: 12, width: "100%" }} disabled={busy}>
        {busy ? "Sending…" : "Email me a reset link"}
      </button>
    </form>
  );
}
