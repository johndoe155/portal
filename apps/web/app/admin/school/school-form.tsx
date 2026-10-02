"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export default function SchoolForm({ initial }: { initial: Record<string, any> }) {
  const router = useRouter();
  const [f, setF] = useState({
    name: initial.name ?? "", logo_url: initial.logo_url ?? "",
    primary_color: initial.primary_color ?? "#1d4ed8", accent_color: initial.accent_color ?? "#0ea5e9",
    contact_email: initial.contact_email ?? "", dpo_email: initial.dpo_email ?? "",
    address: initial.address ?? "", phone: initial.phone ?? "",
    timezone: initial.timezone ?? "Africa/Lagos", currency: initial.currency ?? "NGN",
    mail_sender: initial.mail_sender ?? "",
  });
  const [msg, setMsg] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function save() {
    setMsg("");
    try {
      await api("/school", { method: "PUT", body: JSON.stringify({
        ...f,
        logo_url: f.logo_url || null, contact_email: f.contact_email || null,
        dpo_email: f.dpo_email || null, address: f.address || null,
        phone: f.phone || null, mail_sender: f.mail_sender || null,
      }) });
      setMsg("Saved."); router.refresh();
    } catch (e: any) { setMsg(e?.message ?? "Save failed"); }
  }
  const row = (k: string, label: string, type = "text") => (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span className="muted">{label}</span>
      <input type={type} value={(f as any)[k] ?? ""} onChange={set(k)} style={{ width: "100%" }} />
    </label>
  );
  return (
    <div className="card">
      {row("name", "School name")}
      {row("logo_url", "Logo URL (optional)")}
      <div style={{ display: "flex", gap: 12 }}>
        {row("primary_color", "Primary colour", "color")}
        {row("accent_color", "Accent colour", "color")}
      </div>
      {row("contact_email", "Contact email", "email")}
      {row("dpo_email", "Data protection officer email", "email")}
      {row("address", "Address")}
      {row("phone", "Phone")}
      {row("timezone", "Timezone")}
      {row("currency", "Currency (ISO 4217)")}
      {row("mail_sender", "Email sender address (e.g. portal@school.ng)")}
      <button className="btn" onClick={save}>Save settings</button>
      {msg ? <p className="muted">{msg}</p> : null}
    </div>
  );
}
