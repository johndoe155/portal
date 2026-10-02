"use client";
import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@/lib/client";

export default function InviteForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  if (!token) {
    return <div className="card alert err">Missing invite token — open the link from your invite email.</div>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("/auth/invite/accept", { method: "POST", body: JSON.stringify({ token, password }) });
      setDone(true);
      setTimeout(() => router.push("/login"), 1500);
    } catch (e: any) {
      setErr(e?.code === "password_policy" ? `Password too weak: ${e?.detail ?? ""}`
        : e?.code === "invite_invalid" ? "This invite is invalid or has expired."
        : e?.code === "email_taken" ? "An account with this email already exists."
        : e?.message ?? "Activation failed.");
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card" role="status">
        <strong>Account activated</strong>
        <p className="muted" style={{ marginTop: 8 }}>Taking you to sign in…</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card" aria-label="Accept invite">
      {err && <div className="alert err" role="alert">{err}</div>}
      <label htmlFor="password">Choose a password</label>
      <input id="password" type="password" autoComplete="new-password" minLength={12} maxLength={200}
        value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      <button className="btn" style={{ marginTop: 12, width: "100%" }} disabled={busy}>
        {busy ? "Activating…" : "Activate my account"}
      </button>
    </form>
  );
}
