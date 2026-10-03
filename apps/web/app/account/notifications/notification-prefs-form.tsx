"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Pref { kind: string; label: string; detail: string; enabled: boolean }
interface PrefsResponse { data: Pref[]; note?: string }

export default function NotificationPrefsForm({ home }: { home: string }) {
  const [prefs, setPrefs] = useState<Pref[] | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<PrefsResponse>("/account/notifications");
      setPrefs(r.data);
      setNote(r.note ?? "");
    } catch (e: any) {
      setErr(e?.message ?? "Could not load your preferences.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Saved on toggle rather than behind a Save button: a parent who has just
  // clicked "unsubscribe" in their mail client should not have to find and
  // press a second button for it to count.
  async function toggle(kind: string, enabled: boolean) {
    setBusy(kind); setErr(""); setSaved("");
    const previous = prefs;
    setPrefs((p) => p?.map((x) => (x.kind === kind ? { ...x, enabled } : x)) ?? null);
    try {
      const r = await api<PrefsResponse>("/account/notifications", {
        method: "PUT",
        body: JSON.stringify({ [kind]: enabled }),
      });
      setPrefs(r.data);
      setSaved(enabled ? "Turned on." : "Turned off. You will stop receiving these.");
    } catch (e: any) {
      setPrefs(previous ?? null);
      setErr(e?.message ?? "Could not save that change.");
    } finally {
      setBusy(null);
    }
  }

  if (!prefs) {
    return <div className="card">{err ? <div className="alert err" role="alert">{err}</div> : <p className="muted">Loading…</p>}</div>;
  }

  return (
    <div className="card">
      {err && <div className="alert err" role="alert">{err}</div>}
      {saved && <div className="alert ok" role="status">{saved}</div>}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {prefs.map((p) => (
          <li key={p.kind} style={{ padding: "12px 0", borderBottom: "1px solid #e5e7eb" }}>
            <label style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={p.enabled}
                disabled={busy === p.kind}
                onChange={(e) => toggle(p.kind, e.target.checked)}
                style={{ marginTop: 4, width: 18, height: 18 }}
              />
              <span>
                <strong>{p.label}</strong>
                <br />
                <span className="muted" style={{ fontSize: 14 }}>{p.detail}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {note && <p className="muted" style={{ fontSize: 14, marginTop: 16 }}>{note}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <a className="btn ghost" href={home}>Back</a>
      </div>
    </div>
  );
}
