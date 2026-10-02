"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

const ROLES = ["student", "parent", "teacher", "teacher_assistant", "registrar", "counselor", "school_admin", "auditor"];

/**
 * review-2 #6: Invite flow replaces the old "admin sets a temporary password"
 * form. The admin enters email + name + role; the API returns a single-use
 * accept URL. The invitee sets their own password. When SMTP is configured the
 * invite is emailed automatically; otherwise the admin copies the link.
 */
export default function NewUser() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("student");
  const [err, setErr] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [emailed, setEmailed] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setInviteUrl(""); setEmailed("");
    try {
      // review-3 #6: with SMTP configured the API deliberately does NOT
      // return the accept link (it's a password-setting credential) — it goes
      // to the invitee by email only. Dev (no SMTP) returns it for copying.
      const res = await api<{ acceptUrl?: string; delivery?: string; email: string }>("/invites", {
        method: "POST",
        body: JSON.stringify({ email, display_name: name, roles: [role] }),
      });
      if (res.acceptUrl) setInviteUrl(res.acceptUrl);
      else setEmailed(res.email);
      setEmail(""); setName("");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "email_taken" ? "That email already exists."
        : e?.code === "invite_exists" ? "An invite for that email is already pending."
        : e?.code === "role_above_your_tier" ? "You cannot invite that role (above your tier)."
        : e?.message ?? "Could not create invite");
    }
    setBusy(false);
  }

  if (!open) return <button className="btn" onClick={() => setOpen(true)}>+ Invite user</button>;
  return (
    <div className="card">
      <form onSubmit={submit}>
        <h2 style={{ marginTop: 0 }}>Invite user</h2>
        {err && <div className="alert err" role="alert">{err}</div>}
        {emailed && (
          <div className="alert ok" role="status">
            <strong>Invite sent to {emailed}.</strong> They will choose their own password
            from the link in the email. The link is never shown here — it is a
            password-setting credential.
          </div>
        )}
        {inviteUrl && (
          <div className="alert ok" role="status">
            <strong>Invite created.</strong> SMTP is not configured on this deployment, so
            hand this link to the invitee through a trusted channel:
            <br /><code style={{ wordBreak: "break-all" }}>{inviteUrl}</code>
            <br /><button type="button" className="btn ghost" style={{ marginTop: 8 }}
              onClick={() => { navigator.clipboard.writeText(inviteUrl); }}>Copy link</button>
          </div>
        )}
        <div className="grid cols2">
          <div><label htmlFor="nu-name">Display name</label>
            <input id="nu-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></div>
          <div><label htmlFor="nu-email">Email</label>
            <input id="nu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div><label htmlFor="nu-role">Role</label>
            <select id="nu-role" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
            </select></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={busy}>{busy ? "Sending…" : "Send invite"}</button>
          <button type="button" className="btn ghost" onClick={() => { setOpen(false); setInviteUrl(""); }}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
