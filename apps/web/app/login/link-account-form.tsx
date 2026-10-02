"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { ROLE_HOME } from "@/lib/roles";

/**
 * review-4 #4: links a work identity (Entra — which cannot prove email
 * ownership) to an existing portal account. The user confirms their portal
 * password once; the API creates the identity link and signs them in.
 */
export default function LinkAccountForm({ linkToken }: { linkToken: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const body = await api<{ activeRole: string; mfaRequired: boolean }>("/auth/sso/link", {
        method: "POST", body: JSON.stringify({ link_token: linkToken, email, password }),
      });
      router.push(body.mfaRequired ? "/mfa" : ROLE_HOME[body.activeRole] ?? "/student");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "invalid_credentials" ? "Invalid email or password."
        : e?.code === "link_token_invalid" ? "This link session expired — start the Microsoft sign-in again."
        : e?.code === "identity_linked_elsewhere" ? "That work identity is already linked to another account."
        : e?.message ?? "Linking failed.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card" aria-label="Link your work sign-in">
      <h2 style={{ marginTop: 0 }}>Link your work sign-in</h2>
      <p className="muted">
        Your Microsoft sign-in is not connected to a portal account yet. Enter
        your portal email and password once to link them — after this, the
        Microsoft button signs you in directly.
      </p>
      {err && <div className="alert err" role="alert">{err}</div>}
      <label htmlFor="link-email">Portal email</label>
      <input id="link-email" type="email" autoComplete="email" value={email}
        onChange={(e) => setEmail(e.target.value)} required autoFocus />
      <label htmlFor="link-password">Portal password</label>
      <input id="link-password" type="password" autoComplete="current-password" value={password}
        onChange={(e) => setPassword(e.target.value)} required />
      <button className="btn" style={{ marginTop: 12, width: "100%" }} disabled={busy}>
        {busy ? "Linking…" : "Link and sign in"}
      </button>
      <p style={{ marginTop: 10, textAlign: "right" }}>
        <a className="muted" href="/login">Back to normal sign-in</a>
      </p>
    </form>
  );
}
