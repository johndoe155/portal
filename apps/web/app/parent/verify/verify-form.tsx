"use client";
import { useState } from "react";
import { api } from "@/lib/client";

export default function VerifyForm({ token }: { token: string }) {
  const [t, setT] = useState(token);
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");
  const [msg, setMsg] = useState("");
  async function verify() {
    try {
      const res = await api<any>("/family/guardian-verify", { method: "POST", body: JSON.stringify({ token: t.trim() }) });
      setState("ok");
      setMsg(res?.verified ? "Verified! You can now see your child's records under Children." : "Done.");
    } catch (e: any) { setState("err"); setMsg(e?.message ?? "Verification failed"); }
  }
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <label style={{ display: "block", marginBottom: 8 }}>
        <span className="muted">Verification token from your email</span>
        <input value={t} onChange={(e) => setT(e.target.value)} style={{ width: "100%" }} />
      </label>
      <button className="btn" onClick={verify} disabled={!t.trim()}>Confirm this is me</button>
      {state !== "idle" ? <p style={{ color: state === "ok" ? "#15803d" : "#b91c1c" }}>{msg}</p> : null}
    </div>
  );
}
