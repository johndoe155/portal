"use client";
import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@/lib/client";

export default function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  if (!token) {
    return <div className="card alert err">Missing reset token — open the link from the email.</div>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("/auth/password/reset", { method: "POST", body: JSON.stringify({ token, password }) });
      setDone(true);
      setTimeout(() => router.push("/login"), 1500);
    } catch (e: any) {
      setErr(e?.code === "password_policy" ? `Password too weak: ${e?.detail ?? ""}`
        : e?.code === "reset_token_invalid" ? "This reset link is invalid or has expired."
        : e?.message ?? "Reset failed.");
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card" role="status">
        <strong>Password updated</strong>
        <p className="muted" style={{ marginTop: 8 }}>Taking you to sign in…</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card" aria-label="Reset password">
      {err && <div className="alert err" role="alert">{err}</div>}
      <label htmlFor="password">New password</label>
      <input id="password" type="password" autoComplete="new-password" minLength={12} maxLength={200}
        value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      <button className="btn" style={{ marginTop: 12, width: "100%" }} disabled={busy}>
        {busy ? "Updating…" : "Set new password"}
      </button>
    </form>
  );
}
