"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export default function ChangePasswordForm({ home }: { home: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("/auth/password/change", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      setDone(true);
      setTimeout(() => router.push(home), 1500);
    } catch (e: any) {
      setErr(e?.code === "password_policy" ? `Password too weak: ${e?.detail ?? ""}`
        : e?.code === "invalid_credentials" ? "Current password is incorrect."
        : e?.message ?? "Change failed.");
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card" role="status">
        <strong>Password changed</strong>
        <p className="muted" style={{ marginTop: 8 }}>Other sessions were signed out. Taking you back…</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card" aria-label="Change password">
      {err && <div className="alert err" role="alert">{err}</div>}
      <label htmlFor="current">Current password</label>
      <input id="current" type="password" autoComplete="current-password"
        value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <label htmlFor="next">New password</label>
      <input id="next" type="password" autoComplete="new-password" minLength={12} maxLength={200}
        value={next} onChange={(e) => setNext(e.target.value)} required />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy}>{busy ? "Updating…" : "Change password"}</button>
        <a className="btn ghost" href={home}>Cancel</a>
      </div>
    </form>
  );
}
