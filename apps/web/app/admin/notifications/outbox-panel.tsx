"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import type { OutboxRow, OutboxStats } from "./page";

const FILTERS = [
  { id: "failed,dead", label: "Needs attention" },
  { id: "queued", label: "Waiting to send" },
  { id: "sent", label: "Delivered" },
  { id: "all", label: "Everything" },
];

/** Turn an SMTP error into something an office administrator can act on. */
function explain(row: OutboxRow): string {
  const e = (row.lastError ?? "").toLowerCase();
  if (!e) return "";
  if (/no such user|user unknown|does not exist|recipient address rejected|5\.1\.1/.test(e)) {
    return "That address does not exist. Correct it on the person's record, then retry.";
  }
  if (/no push subscription/.test(e)) {
    return "This person has not enabled browser notifications. They will still get the email.";
  }
  if (/recipient not found/.test(e)) {
    return "The account was removed before the message could be sent. No action needed.";
  }
  if (/mailbox (unavailable|full)|quota/.test(e)) {
    return "Their mailbox is full or unavailable. Ask them to clear it, then retry.";
  }
  if (/timeout|econnrefused|enotfound|connection/.test(e)) {
    return "The mail server could not be reached. Check SMTP settings, then retry.";
  }
  if (/auth|535|credentials/.test(e)) {
    return "The mail server rejected our credentials. Check SMTP_URL, then retry all.";
  }
  if (/spam|blocked|blacklist|5\.7/.test(e)) {
    return "The receiving server blocked the message. Check SPF/DKIM/DMARC (docs/email-setup.md).";
  }
  return "Retry once the underlying problem is fixed.";
}

const KIND_LABEL: Record<string, string> = {
  password_reset: "Password reset",
  user_invite: "Staff/user invitation",
  mfa_enroll_token: "Two-factor setup",
  guardian_verify: "Parent verification",
  absence_recorded: "Absence alert",
  grade_released: "Grades published",
  message_received: "New message",
  daily_digest: "Daily summary",
  account_deactivated: "Account deactivated",
};

/** These are the ones that block someone from using the portal at all. */
const CRITICAL = new Set(["password_reset", "user_invite", "mfa_enroll_token", "guardian_verify"]);

export default function OutboxPanel({
  initialRows, total, stats, status, canRetry,
}: {
  initialRows: OutboxRow[];
  total: number;
  stats: OutboxStats | null;
  status: string;
  canRetry: boolean;
}) {
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const router = useRouter();

  async function retry(id: string) {
    setBusy(id); setErr(""); setMsg("");
    try {
      await api(`/admin/notifications/${id}/retry`, { method: "POST" });
      setRows((r) => r.filter((x) => x.id !== id));
      setMsg("Queued for immediate delivery.");
    } catch (e: any) { setErr(e?.message ?? "Retry failed"); }
    setBusy(null);
  }

  async function retryAll() {
    setBusy("all"); setErr(""); setMsg("");
    try {
      const out = await api<{ requeued: number }>("/admin/notifications/retry-all", { method: "POST" });
      setMsg(`${out.requeued} message(s) queued for delivery.`);
      setRows([]);
      router.refresh();
    } catch (e: any) { setErr(e?.message ?? "Retry failed"); }
    setBusy(null);
  }

  const criticalCount = rows.filter((r) => CRITICAL.has(r.kind) && r.status !== "sent").length;

  return (
    <>
      {stats && !stats.mailConfigured ? (
        <div className="card" style={{ borderLeft: "4px solid #b91c1c" }}>
          <strong>Email is not configured.</strong>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            No SMTP server is set, so nothing is being delivered — password resets, invitations
            and parent verifications are all queuing up unsent. Set <code>SMTP_URL</code> and
            restart. See <code>docs/email-setup.md</code>.
          </p>
        </div>
      ) : null}

      {criticalCount > 0 ? (
        <div className="card" style={{ borderLeft: "4px solid #b45309" }}>
          <strong>{criticalCount} person(s) cannot get into the portal.</strong>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Password resets, invitations, two-factor setup and parent verification links are
            how people gain access. These never arrived.
          </p>
        </div>
      ) : null}

      <div className="grid cols3">
        <div className="stat"><div className="muted">Waiting to send</div><div className="n">{stats?.queued ?? "—"}</div></div>
        <div className="stat"><div className="muted">Needs attention</div><div className="n">{(stats?.failed ?? 0) + (stats?.dead ?? 0)}</div></div>
        <div className="stat"><div className="muted">Delivered</div><div className="n">{stats?.sent ?? "—"}</div></div>
      </div>

      {stats && stats.oldestQueuedAgeSeconds > 900 ? (
        <p className="muted">
          Oldest waiting message is {Math.round(stats.oldestQueuedAgeSeconds / 60)} minutes old —
          if that keeps climbing, the worker may not be running.
        </p>
      ) : null}

      <div className="card">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {FILTERS.map((f) => (
            <a key={f.id} className={`btn ${status === f.id ? "" : "ghost"}`}
               href={`/admin/notifications?status=${encodeURIComponent(f.id)}`}>{f.label}</a>
          ))}
          <span className="spacer" style={{ flex: 1 }} />
          {canRetry && rows.length > 0 && status === "failed,dead" ? (
            <button className="btn" disabled={busy !== null} onClick={retryAll}>
              {busy === "all" ? "Retrying…" : "Retry all"}
            </button>
          ) : null}
        </div>
      </div>

      {msg ? <p style={{ color: "#15803d" }}>{msg}</p> : null}
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{total} message(s)</h2>
        {rows.length === 0 ? (
          <p className="muted">Nothing here — every message has been delivered.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Recipient</th><th>Message</th><th>Status</th><th>What went wrong</th>
                {canRetry ? <th></th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.recipientName ? <div>{r.recipientName}</div> : null}
                    <span className="muted" style={{ fontSize: 12 }}>{r.recipient}</span>
                  </td>
                  <td>
                    {KIND_LABEL[r.kind] ?? r.kind}
                    {CRITICAL.has(r.kind) ? (
                      <span style={{ color: "#b45309", fontSize: 12 }}> · blocks access</span>
                    ) : null}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {r.channel} · {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </td>
                  <td>
                    {r.status === "dead" ? "Gave up" : r.status === "failed" ? "Rejected" : r.status}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {r.attempts} attempt{r.attempts === 1 ? "" : "s"}
                      {r.status === "queued" && r.nextAttemptAt
                        ? ` · next ${new Date(r.nextAttemptAt).toLocaleTimeString()}`
                        : ""}
                    </div>
                  </td>
                  <td style={{ maxWidth: 320 }}>
                    <div>{explain(r)}</div>
                    {r.lastError ? (
                      <details>
                        <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                          Technical detail
                        </summary>
                        <code style={{ fontSize: 11, wordBreak: "break-all" }}>{r.lastError}</code>
                      </details>
                    ) : null}
                  </td>
                  {canRetry ? (
                    <td>
                      <button className="btn ghost" disabled={busy !== null}
                              onClick={() => retry(r.id)}>
                        {busy === r.id ? "…" : "Retry"}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
