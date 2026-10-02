"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export default function ChangeForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState("");
  async function submit() {
    setMsg("");
    try {
      await api("/auth/password/change", {
        method: "POST", body: JSON.stringify({ current_password: current, new_password: next }),
      });
      router.push(forced ? "/" : "/account");
      router.refresh();
    } catch (e: any) { setMsg(e?.message ?? "Change failed"); }
  }
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <label style={{ display: "block", marginBottom: 8 }}>
        <span className="muted">Current (temporary) password</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} style={{ width: "100%" }} />
      </label>
      <label style={{ display: "block", marginBottom: 8 }}>
        <span className="muted">New password (12+ characters, mixed classes)</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} style={{ width: "100%" }} />
      </label>
      <button className="btn" onClick={submit} disabled={!current || !next}>Change password</button>
      {msg ? <p style={{ color: "#b91c1c" }}>{msg}</p> : null}
    </div>
  );
}
