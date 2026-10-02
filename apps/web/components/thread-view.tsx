"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

interface Message { id: string; senderUserId: string; senderName: string; bodyText: string; createdAt: string }
interface Thread { id: string; subject: string; status: string; studentName: string | null }

export default function ThreadView({ thread, messages, canReply, meId }: {
  thread: Thread; messages: Message[]; canReply: boolean; meId: string;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api(`/threads/${thread.id}/messages`, {
        method: "POST", body: JSON.stringify({ body_text: text }),
      });
      setText("");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "parent_read_only"
        ? "Parent accounts are read-only — your teacher will follow up here."
        : e?.message ?? "Could not send");
    }
    setBusy(false);
  }

  async function close() {
    if (!confirm("Close this thread?")) return;
    setBusy(true);
    try { await api(`/threads/${thread.id}/close`, { method: "POST" }); router.refresh(); }
    catch (e: any) { setErr(e?.message ?? "Could not close"); }
    setBusy(false);
  }

  return (
    <>
      <h1>{thread.subject}</h1>
      <div className="muted">About {thread.studentName ?? "student"} · {thread.status}</div>
      {err && <div className="alert err" role="alert">{err}</div>}

      <div className="card">
        {messages.map((m) => (
          <div key={m.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
            <div className="row">
              <strong>{m.senderName}{m.senderUserId === meId ? " (you)" : ""}</strong>
              <span className="muted">{new Date(m.createdAt).toLocaleString()}</span>
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.bodyText}</div>
          </div>
        ))}
        {messages.length === 0 && <div className="muted">No messages yet.</div>}
      </div>

      {!canReply && (
        <div className="alert ok">Read-only view — messages from your child’s teacher appear here.</div>
      )}
      {canReply && thread.status === "open" && (
        <form className="card" onSubmit={send}>
          <label htmlFor="reply">Reply</label>
          <input id="reply" value={text} onChange={(e) => setText(e.target.value)} required maxLength={4000} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={busy || !text.trim()}>Send</button>
            <button type="button" className="btn ghost" onClick={close} disabled={busy}>Close thread</button>
          </div>
        </form>
      )}
      {canReply && thread.status === "closed" && <div className="muted">This thread is closed.</div>}
    </>
  );
}
