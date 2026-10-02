"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { ROLE_HOME } from "@/lib/roles";

export default function MfaForm({ activeRole }: { activeRole: string }) {
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function enroll() {
    setBusy(true); setErr("");
    try {
      const out = await api<{ secret: string; otpauthUrl: string }>("/auth/mfa/totp/enroll", {
        method: "POST", body: JSON.stringify({ token: token.trim() }),
      });
      setSecret(out.secret);
      setInfo("Add this secret to your authenticator app (manual entry or paste the otpauth link), then verify a code below.");
    } catch (e: any) {
      if (e?.code === "enroll_token_required") {
        setErr("Enrolment is controlled: paste the one-time enrolment token your administrator sent you. "
          + "(The first admin gets one from the ops CLI: node scripts/mfa-token.mjs <email>.)");
      } else if (e?.code === "enroll_token_invalid") {
        setErr("That enrolment token is invalid, already used, or expired (tokens are single-use, valid 24 h). Ask your administrator for a new one.");
      } else setErr(e?.message ?? "Enrolment failed");
    }
    setBusy(false);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("/auth/mfa/totp/verify", { method: "POST", body: JSON.stringify({ code }) });
      router.push(ROLE_HOME[activeRole] ?? "/teacher");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "totp_invalid" ? "That code is not valid. Check your device clock and try again." : e?.message ?? "Verification failed");
      setBusy(false);
    }
  }

  return (
    <div className="card">
      {!secret && (
        <div>
          <p className="muted">
            Authenticator enrolment is <strong>admin-controlled</strong> — nobody can add a factor to an
            account with only a password. Ask an administrator for a one-time enrolment token
            (they issue it from your directory page), then paste it below.
          </p>
          <label htmlFor="enroll-token" className="muted">Enrolment token</label>
          <input id="enroll-token" value={token} onChange={(e) => setToken(e.target.value)}
            autoComplete="off" style={{ width: "100%" }} />
          <p>
            <button className="btn ghost" onClick={enroll} disabled={busy || !token.trim()}>
              Set up / re-enrol authenticator
            </button>
          </p>
        </div>
      )}
      {secret && (
        <div className="alert ok" role="status">
          <div><strong>Secret:</strong> <code>{secret}</code></div>
          <div className="muted" style={{ marginTop: 4 }}>{info}</div>
        </div>
      )}
      <form onSubmit={verify}>
        {err && <div className="alert err" role="alert">{err}</div>}
        <label htmlFor="code">6-digit code</label>
        <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required autoFocus />
        <button className="btn" style={{ marginTop: 12, width: "100%" }} disabled={busy || code.length !== 6}>
          {busy ? "Verifying…" : "Verify"}
        </button>
      </form>
    </div>
  );
}
