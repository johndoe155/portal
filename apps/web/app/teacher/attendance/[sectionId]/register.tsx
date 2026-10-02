"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { ATTENDANCE_STATUSES, type AttendanceStatus } from "@/lib/roles";

interface RosterRow { studentUserId: string; admissionNo: string; gradeLevel: number; displayName: string }
interface AttendanceRow { studentUserId: string; status: string; note: string | null }

export default function Register({ sectionId, date, roster, initial, registerStatus }: {
  sectionId: string; date: string; roster: RosterRow[];
  initial: AttendanceRow[]; registerStatus: string | null;
}) {
  const init = new Map(initial.map((r) => [r.studentUserId, r.status as AttendanceStatus]));
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>(
    Object.fromEntries(roster.map((s) => [s.studentUserId, init.get(s.studentUserId) ?? "present"])),
  );
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [final, setFinal] = useState(registerStatus === "final");
  const keyRef = useRef<string | null>(null);
  const router = useRouter();

  function mark(id: string, status: AttendanceStatus) {
    setErr(""); setInfo("");
    setMarks((m) => ({ ...m, [id]: status }));
  }

  async function save() {
    setBusy(true); setErr(""); setInfo("");
    // Same key across a failed retry, fresh key per new save — idempotent replay, no dupes.
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    try {
      await api(`/sections/${sectionId}/attendance`, {
        method: "POST",
        idempotencyKey: keyRef.current,
        body: JSON.stringify({
          date,
          records: roster.map((s) => ({ student_user_id: s.studentUserId, status: marks[s.studentUserId] })),
        }),
      });
      keyRef.current = null;
      setInfo(`Register saved for ${date}. You can keep editing until you finalize.`);
      router.refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Save failed");
    }
    setBusy(false);
  }

  async function finalize() {
    if (!confirm(`Finalize the ${date} register? This locks it for edits.`)) return;
    setBusy(true); setErr("");
    try {
      await api(`/sections/${sectionId}/attendance/finalize`, { method: "POST", body: JSON.stringify({ date }) });
      setFinal(true);
      setInfo("Register finalized and locked.");
      router.refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Finalize failed");
    }
    setBusy(false);
  }

  const counts = ATTENDANCE_STATUSES.map((st) => ({
    st, n: Object.values(marks).filter((v) => v === st).length,
  }));

  return (
    <>
      <h1>Daily register — {date}</h1>
      <div className="row muted">
        {counts.map(({ st, n }) => <span key={st}>{st}: <strong>{n}</strong></span>)}
      </div>
      {err && <div className="alert err" role="alert">{err}</div>}
      {info && <div className="alert ok" role="status">{info}</div>}
      {final && <div className="alert err">This register is finalized — edits are locked.</div>}

      <div className="card">
        {roster.length === 0 && <div className="muted">No enrolled students.</div>}
        {roster.map((s) => (
          <div key={s.studentUserId} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div>{s.displayName}</div>
              <div className="muted">{s.admissionNo} · Grade {s.gradeLevel}</div>
            </div>
            <div className="row" role="radiogroup" aria-label={`Attendance for ${s.displayName}`}>
              {ATTENDANCE_STATUSES.map((st) => (
                <button key={st} type="button" role="radio" aria-checked={marks[s.studentUserId] === st}
                  className={`chip ${marks[s.studentUserId] === st ? `on-${st}` : ""}`}
                  disabled={final} onClick={() => mark(s.studentUserId, st)}>
                  {st}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={save} disabled={busy || final || roster.length === 0}>
          {busy ? "Saving…" : "Save register"}
        </button>
        <button className="btn danger" onClick={finalize} disabled={busy || final || roster.length === 0}>
          Finalize
        </button>
      </div>
    </>
  );
}
