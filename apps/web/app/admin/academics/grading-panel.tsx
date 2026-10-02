"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Letter { letter: string; min_pct: number; point: number }

/** phase 6: school-wide grading scale + exam/coursework weights. */
export default function GradingPanel() {
  const [scale, setScale] = useState<Letter[]>([]);
  const [weights, setWeights] = useState({ exam: 70, coursework: 30 });
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api<{ scale: Letter[]; weights?: { exam: number; coursework: number } }>("/grading-config")
      .then((r) => { setScale(r.scale ?? []); if (r.weights) setWeights(r.weights); }).catch(() => {});
  }, []);

  const setRow = (i: number, k: keyof Letter, v: string) => {
    const next = [...scale];
    (next[i] as any)[k] = k === "letter" ? v : Number(v);
    setScale(next);
  };
  async function save() {
    setMsg("");
    try {
      const r = await api<{ scale: Letter[] }>("/grading-config", {
        method: "PUT", body: JSON.stringify({ scale, weights }),
      });
      setScale(r.scale); setMsg("Saved (re-sorted by min %).");
    } catch (e: any) { setMsg(e?.message ?? "Save failed"); }
  }
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Grading scale</h2>
      <table>
        <thead><tr><th>Letter</th><th>Min %</th><th>Point</th><th></th></tr></thead>
        <tbody>
          {scale.map((s, i) => (
            <tr key={i}>
              <td><input style={{ width: 60 }} value={s.letter} onChange={(e) => setRow(i, "letter", e.target.value)} /></td>
              <td><input style={{ width: 80 }} type="number" min={0} max={100} value={s.min_pct} onChange={(e) => setRow(i, "min_pct", e.target.value)} /></td>
              <td><input style={{ width: 80 }} type="number" step="0.5" value={s.point} onChange={(e) => setRow(i, "point", e.target.value)} /></td>
              <td><button className="btn ghost" onClick={() => setScale(scale.filter((_, j) => j !== i))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button className="btn ghost" onClick={() => setScale([...scale, { letter: "", min_pct: 0, point: 0 }])}>+ Add band</button>
      </p>
      <p className="muted">
        Weights — exam <input style={{ width: 60 }} type="number" value={weights.exam} onChange={(e) => setWeights({ ...weights, exam: Number(e.target.value) })} />% ·
        coursework <input style={{ width: 60 }} type="number" value={weights.coursework} onChange={(e) => setWeights({ ...weights, coursework: Number(e.target.value) })} />%
      </p>
      <button className="btn" onClick={save}>Save scale</button>
      {msg ? <p className="muted">{msg}</p> : null}
    </div>
  );
}
