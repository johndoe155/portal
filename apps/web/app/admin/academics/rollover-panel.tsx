"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";

interface Year { id: string; name: string; startDate: string; endDate: string; isCurrent: boolean }
type Action = "promote" | "retain" | "graduate" | "withdraw" | "transfer";

interface Pupil {
  studentUserId: string; displayName: string; admissionNo: string;
  fromGrade: number; toGrade: number | null; action: Action; overridden: boolean;
}
interface Plan {
  dryRun: boolean; alreadyDone: boolean;
  fromYear: { id: string; name: string };
  toYear: { id: string | null; name: string; created: boolean };
  terms: { termNo: number; name: string; created: boolean }[];
  pupils: Pupil[];
  counts: Record<Action, number> & { total: number };
  sections: { carried: number; skipped: number };
  warnings: string[]; blockers: string[];
  rolloverId?: string;
}
interface HistoryRow {
  id: string; fromYearId: string; toYearId: string; performedAt: string;
  summary: Record<string, unknown>; revertedAt: string | null; pupils: number;
}

const ACTIONS: { value: Action; label: string }[] = [
  { value: "promote", label: "Move up a year" },
  { value: "retain", label: "Repeat the year" },
  { value: "graduate", label: "Graduate (leaves)" },
  { value: "withdraw", label: "Withdrawn (leaves)" },
  { value: "transfer", label: "Transferred out (leaves)" },
];
const LEAVES: Action[] = ["graduate", "withdraw", "transfer"];

/** "2026/2027" → "2027/2028"; "2026-27" → "2027-28". Best-effort only. */
function guessNextName(name: string): string {
  const slash = name.match(/^(\d{4})\s*\/\s*(\d{2,4})$/);
  if (slash) {
    const a = Number(slash[1]) + 1;
    const b = slash[2].length === 2 ? String((Number(slash[2]) + 1) % 100).padStart(2, "0") : String(Number(slash[2]) + 1);
    return `${a}/${b}`;
  }
  const dash = name.match(/^(\d{4})\s*-\s*(\d{2,4})$/);
  if (dash) {
    const a = Number(dash[1]) + 1;
    const b = dash[2].length === 2 ? String((Number(dash[2]) + 1) % 100).padStart(2, "0") : String(Number(dash[2]) + 1);
    return `${a}-${b}`;
  }
  const n = Number(name);
  return Number.isFinite(n) && name.trim() !== "" ? String(n + 1) : "";
}
function plusYear(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
const yearGroup = (g: number | null) => (g === null ? "—" : `Year ${g}`);

/**
 * End-of-year rollover.
 *
 * Previously there was no way to start a second academic year: moving every
 * pupil up a year group, graduating the leaving cohort and carrying the
 * timetable forward would all have had to be done by hand in the database.
 *
 * This is deliberately a preview-then-confirm flow. It is the single most
 * far-reaching action in the portal — it touches every pupil record at once —
 * so nothing is written until the registrar has seen the exact list, and the
 * whole thing can be undone afterwards.
 */
export default function RolloverPanel({ years }: { years: Year[] }) {
  const current = useMemo(
    () => years.find((y) => y.isCurrent) ?? years[years.length - 1],
    [years]);

  const [fromId, setFromId] = useState(current?.id ?? "");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [toYearId, setToYearId] = useState("");
  const [name, setName] = useState("");
  const [startDate, setStart] = useState("");
  const [endDate, setEnd] = useState("");
  const [graduatingGrade, setGrad] = useState(13);
  const [carrySections, setCarrySections] = useState(true);
  const [carryStaff, setCarryStaff] = useState(true);
  const [setCurrent, setSetCurrent] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, Action>>({});

  const [plan, setPlan] = useState<Plan | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Plan | null>(null);
  const [confirm, setConfirm] = useState("");
  const [showPupils, setShowPupils] = useState(false);
  const [open, setOpen] = useState(false);

  const from = years.find((y) => y.id === fromId);

  // Sensible defaults for the new year, derived from the one ending.
  useEffect(() => {
    if (!from) return;
    setName((n) => n || guessNextName(from.name));
    setStart((d) => d || plusYear(from.startDate));
    setEnd((d) => d || plusYear(from.endDate));
  }, [from]);

  const loadHistory = useCallback(async () => {
    try { setHistory((await api<{ data: HistoryRow[] }>("/rollovers")).data); }
    catch { /* history is informational; a failure here must not block the tool */ }
  }, []);
  useEffect(() => { if (open) loadHistory(); }, [open, loadHistory]);

  function body(dryRun: boolean) {
    return {
      dry_run: dryRun,
      ...(mode === "existing" ? { to_year_id: toYearId }
        : { next_year: { name, start_date: startDate, end_date: endDate } }),
      graduating_grade: graduatingGrade,
      carry_sections: carrySections,
      carry_staff: carryStaff,
      set_current: setCurrent,
      overrides: Object.entries(overrides).map(([student_user_id, action]) => ({ student_user_id, action })),
    };
  }

  async function preview() {
    setBusy(true); setErr(""); setDone(null);
    try {
      setPlan(await api<Plan>(`/academic-years/${fromId}/rollover-preview`, {
        method: "POST", body: JSON.stringify(body(true)),
      }));
    } catch (e: any) { setErr(e?.detail ?? e?.message ?? "Could not work out the rollover"); }
    finally { setBusy(false); }
  }

  // Re-preview whenever an override changes so the counts never lie.
  async function setOverride(id: string, action: Action, natural: Action) {
    const next = { ...overrides };
    if (action === natural) delete next[id]; else next[id] = action;
    setOverrides(next);
    if (!plan) return;
    try {
      setPlan(await api<Plan>(`/academic-years/${fromId}/rollover-preview`, {
        method: "POST",
        body: JSON.stringify({
          ...body(true),
          overrides: Object.entries(next).map(([student_user_id, a]) => ({ student_user_id, action: a })),
        }),
      }));
    } catch { /* keep the old plan rather than blanking the screen */ }
  }

  async function commit() {
    setBusy(true); setErr("");
    try {
      const res = await api<Plan>(`/academic-years/${fromId}/rollover`, {
        method: "POST", body: JSON.stringify(body(false)),
      });
      setDone(res); setPlan(null); setConfirm(""); setOverrides({});
      await loadHistory();
    } catch (e: any) { setErr(e?.detail ?? e?.message ?? "The rollover could not be completed"); }
    finally { setBusy(false); }
  }

  async function revert(id: string) {
    if (!window.confirm(
      "Undo this rollover? Every pupil goes back to the year group they were in, " +
      "and anyone the rollover graduated gets their access back.")) return;
    setBusy(true); setErr("");
    try {
      const res = await api<{ restored: number; detail: string }>(`/rollovers/${id}/revert`, {
        method: "POST", body: JSON.stringify({}),
      });
      setErr(""); setDone(null);
      window.alert(res.detail);
      await loadHistory();
    } catch (e: any) { setErr(e?.detail ?? e?.message ?? "Could not undo that rollover"); }
    finally { setBusy(false); }
  }

  const targetName = mode === "existing"
    ? (years.find((y) => y.id === toYearId)?.name ?? "")
    : name;
  const canCommit = plan && !plan.blockers.length && confirm.trim() === targetName.trim() && targetName !== "";

  if (!open) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>End-of-year rollover</h2>
        <p className="muted">
          Start a new academic year: move every pupil up a year group, graduate the leaving
          cohort and carry the timetable forward. Nothing is changed until you have reviewed
          the full list, and the whole thing can be undone.
        </p>
        <button className="btn" onClick={() => setOpen(true)}>Open rollover</button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>End-of-year rollover</h2>
      <p className="muted">
        Every pupil record in the school is touched by this. Preview first — the list below is
        exactly what will happen.
      </p>

      {err && <p className="error" role="alert">{err}</p>}

      {done && (
        <div className="notice" style={{ border: "1px solid #0a0", padding: 12, borderRadius: 6, marginBottom: 12 }}>
          <strong>{done.fromYear.name} → {done.toYear.name} is done.</strong>
          <div className="muted" style={{ marginTop: 4 }}>
            {done.counts.promote} moved up, {done.counts.retain} repeating,{" "}
            {done.counts.graduate} graduated, {done.sections.carried} section(s) carried forward.
            You can undo it from the history below.
          </div>
        </div>
      )}

      {/* ── Settings ───────────────────────────────────────────────────── */}
      <div className="grid" style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
        <label>
          <span>Year ending</span>
          <select value={fromId} onChange={(e) => { setFromId(e.target.value); setPlan(null); }}>
            {years.map((y) => (
              <option key={y.id} value={y.id}>{y.name}{y.isCurrent ? " (current)" : ""}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Year starting</span>
          <select value={mode} onChange={(e) => { setMode(e.target.value as "new" | "existing"); setPlan(null); }}>
            <option value="new">Create a new year</option>
            <option value="existing">Use a year I already created</option>
          </select>
        </label>

        {mode === "existing" ? (
          <label>
            <span>Which year</span>
            <select value={toYearId} onChange={(e) => { setToYearId(e.target.value); setPlan(null); }}>
              <option value="">Choose…</option>
              {years.filter((y) => y.id !== fromId).map((y) => (
                <option key={y.id} value={y.id}>{y.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label><span>New year name</span>
              <input value={name} onChange={(e) => { setName(e.target.value); setPlan(null); }} placeholder="2027/2028" />
            </label>
            <label><span>Starts</span>
              <input type="date" value={startDate} onChange={(e) => { setStart(e.target.value); setPlan(null); }} />
            </label>
            <label><span>Ends</span>
              <input type="date" value={endDate} onChange={(e) => { setEnd(e.target.value); setPlan(null); }} />
            </label>
          </>
        )}

        <label>
          <span>Final year group (these pupils graduate)</span>
          <select value={graduatingGrade} onChange={(e) => { setGrad(Number(e.target.value)); setPlan(null); }}>
            {Array.from({ length: 13 }, (_, i) => i + 1).map((g) => (
              <option key={g} value={g}>Year {g}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "12px 0" }}>
        <label className="inline"><input type="checkbox" checked={carrySections}
          onChange={(e) => { setCarrySections(e.target.checked); setPlan(null); }} /> Recreate classes in the new year</label>
        <label className="inline"><input type="checkbox" checked={carryStaff} disabled={!carrySections}
          onChange={(e) => { setCarryStaff(e.target.checked); setPlan(null); }} /> Keep the same teachers on them</label>
        <label className="inline"><input type="checkbox" checked={setCurrent}
          onChange={(e) => setSetCurrent(e.target.checked)} /> Make the new year current</label>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" onClick={preview} disabled={busy || !fromId}>
          {busy ? "Working…" : "Preview rollover"}
        </button>
        <button className="btn ghost" onClick={() => { setOpen(false); setPlan(null); }}>Close</button>
      </div>

      {/* ── The plan ───────────────────────────────────────────────────── */}
      {plan && (
        <div style={{ marginTop: 20, borderTop: "1px solid #ddd", paddingTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>
            {plan.fromYear.name} → {plan.toYear.name || "(not chosen)"}
            {plan.toYear.created && <span className="muted"> — will be created</span>}
          </h3>

          {plan.blockers.map((b, i) => (
            <p key={i} className="error" role="alert" style={{ fontWeight: 600 }}>{b}</p>
          ))}
          {plan.warnings.map((w, i) => (
            <p key={i} className="muted" style={{ margin: "4px 0" }}>⚠ {w}</p>
          ))}

          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", margin: "12px 0" }}>
            <Stat n={plan.counts.promote} label="move up a year" />
            <Stat n={plan.counts.retain} label="repeat the year" />
            <Stat n={plan.counts.graduate} label="graduate" />
            <Stat n={plan.counts.withdraw + plan.counts.transfer} label="leave (other)" />
            <Stat n={plan.terms.filter((t) => t.created).length} label="terms created" />
            <Stat n={plan.sections.carried} label="classes carried" />
          </div>

          <button className="btn ghost" onClick={() => setShowPupils((v) => !v)}>
            {showPupils ? "Hide" : `Review all ${plan.counts.total} pupils`}
          </button>

          {showPupils && (
            <div style={{ maxHeight: 420, overflow: "auto", marginTop: 12 }}>
              <table className="table">
                <thead><tr>
                  <th>Pupil</th><th>Admission no.</th><th>Now</th><th>Next</th><th>What happens</th>
                </tr></thead>
                <tbody>
                  {plan.pupils.map((p) => {
                    const natural: Action = p.fromGrade >= graduatingGrade ? "graduate" : "promote";
                    return (
                      <tr key={p.studentUserId} style={p.overridden ? { background: "#fffbe6" } : undefined}>
                        <td>{p.displayName}</td>
                        <td className="muted">{p.admissionNo}</td>
                        <td>{yearGroup(p.fromGrade)}</td>
                        <td>{LEAVES.includes(p.action) ? <span className="muted">leaves</span> : yearGroup(p.toGrade)}</td>
                        <td>
                          <select value={p.action}
                            onChange={(e) => setOverride(p.studentUserId, e.target.value as Action, natural)}>
                            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Confirm ──────────────────────────────────────────────── */}
          {!plan.blockers.length && (
            <div style={{ marginTop: 16, borderTop: "1px dashed #ccc", paddingTop: 12 }}>
              <p style={{ marginTop: 0 }}>
                This will move {plan.counts.total} pupil record(s)
                {plan.counts.graduate > 0 && <> and end portal access for {plan.counts.graduate} leaver(s)</>}.
                Last year&rsquo;s marks, attendance and invoices are not changed.
              </p>
              <label>
                <span>Type <strong>{targetName}</strong> to confirm</span>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={targetName} />
              </label>
              <button className="btn danger" style={{ marginTop: 8 }} onClick={commit} disabled={busy || !canCommit}>
                {busy ? "Rolling over…" : `Run rollover into ${targetName || "…"}`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── History / undo ─────────────────────────────────────────────── */}
      {history.length > 0 && (
        <div style={{ marginTop: 24, borderTop: "1px solid #ddd", paddingTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Previous rollovers</h3>
          <table className="table">
            <thead><tr><th>When</th><th>Years</th><th>Pupils</th><th>Status</th><th /></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{new Date(h.performedAt).toLocaleString()}</td>
                  <td>{String(h.summary?.fromYear ?? "?")} → {String(h.summary?.toYear ?? "?")}</td>
                  <td>{h.pupils}</td>
                  <td>{h.revertedAt
                    ? <span className="muted">undone {new Date(h.revertedAt).toLocaleDateString()}</span>
                    : "applied"}</td>
                  <td>
                    {!h.revertedAt && (
                      <button className="btn ghost" onClick={() => revert(h.id)} disabled={busy}>Undo</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1 }}>{n}</div>
      <div className="muted" style={{ fontSize: 13 }}>{label}</div>
    </div>
  );
}
