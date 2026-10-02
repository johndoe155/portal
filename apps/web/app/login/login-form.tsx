"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { ROLE_HOME } from "@/lib/roles";

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const body = await api<{ activeRole: string; mfaRequired: boolean; mustChangePassword?: boolean }>("/auth/login", {
        method: "POST", body: JSON.stringify({ email, password }),
      });
      // review-6 #3: temporary password → forced change first
      router.push(body.mustChangePassword ? "/change"
        : body.mfaRequired ? "/mfa" : ROLE_HOME[body.activeRole] ?? "/student");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "invalid_credentials" ? "Invalid email or password." : e?.message ?? "Sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card" aria-label="Sign in">
      {err && <div className="alert err" role="alert">{err}</div>}
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="email" value={email}
        onChange={(e) => setEmail(e.target.value)} required autoFocus />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" autoComplete="current-password" value={password}
        onChange={(e) => setPassword(e.target.value)} required />
      <button className="btn" style={{ marginTop: 12, width: "100%" }} disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p style={{ marginTop: 10, textAlign: "right" }}>
        <a className="muted" href="/forgot">Forgot password?</a>
      </p>
      <div className="row" style={{ marginTop: 14 }}>
        <a className="btn ghost" style={{ flex: 1 }} href="/api/v1/auth/sso/google/start">Continue with Google</a>
        <a className="btn ghost" style={{ flex: 1 }} href="/api/v1/auth/sso/entra/start">Continue with Microsoft</a>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        SSO signs you in via your school’s Google Workspace / Microsoft Entra directory.
        Staff accounts still require two-factor verification afterwards.
      </p>
    </form>
  );
}
