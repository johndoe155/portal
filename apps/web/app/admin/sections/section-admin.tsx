"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

interface Term { id: string; name: string; termNo: number }
interface SectionOption { id: string; name: string }

export default function SectionAdmin({ terms, sectionOptions }: { terms: Term[]; sectionOptions: SectionOption[] }) {
  const [courseCode, setCourseCode] = useState("");
  const [courseTitle, setCourseTitle] = useState("");
  const [name, setName] = useState("");
  const [termId, setTermId] = useState(terms[0]?.id ?? "");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  // enrollment
  const [enrollSection, setEnrollSection] = useState(sectionOptions[0]?.id ?? "");
  const [admissionNo, setAdmissionNo] = useState("");
  const router = useRouter();

  async function createSection(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setInfo("");
    try {
      await api("/sections", {
        method: "POST",
        body: JSON.stringify({ course_code: courseCode, course_title: courseTitle, name, term_id: termId }),
      });
      setInfo(`Section ${name} created.`);
      setCourseCode(""); setCourseTitle(""); setName("");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "section_exists" ? "That section already exists." : e?.message ?? "Create failed");
    }
    setBusy(false);
  }

  async function enroll(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setInfo("");
    try {
      const stu = await api<{ userId: string; displayName: string }>(
        `/students-lookup?admission_no=${encodeURIComponent(admissionNo)}`);
      await api(`/sections/${enrollSection}/enrollments`, {
        method: "POST", body: JSON.stringify({ student_user_id: stu.userId }),
      });
      setInfo(`Enrolled ${stu.displayName} (${admissionNo.toUpperCase()}).`);
      setAdmissionNo("");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "not_found" ? "No student with that admission number."
        : e?.code === "already_enrolled" ? "Already enrolled in that section."
        : e?.message ?? "Enroll failed");
    }
    setBusy(false);
  }

  return (
    <>
      <form className="card" onSubmit={createSection}>
        <h2 style={{ marginTop: 0 }}>Create section</h2>
        {err && <div className="alert err" role="alert">{err}</div>}
        {info && <div className="alert ok" role="status">{info}</div>}
        <div className="grid cols2">
          <div><label htmlFor="cc">Course code</label>
            <input id="cc" value={courseCode} onChange={(e) => setCourseCode(e.target.value)} required maxLength={20} placeholder="BIO-101" /></div>
          <div><label htmlFor="ct">Course title</label>
            <input id="ct" value={courseTitle} onChange={(e) => setCourseTitle(e.target.value)} required placeholder="Biology" /></div>
          <div><label htmlFor="sn">Section name</label>
            <input id="sn" value={name} onChange={(e) => setName(e.target.value)} required placeholder="BIO-101 A" /></div>
          <div><label htmlFor="tm">Term</label>
            <select id="tm" value={termId} onChange={(e) => setTermId(e.target.value)}>
              {terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></div>
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={busy}>Create</button>
      </form>

      <form className="card" onSubmit={enroll}>
        <h2 style={{ marginTop: 0 }}>Enroll a student</h2>
        <div className="grid cols2">
          <div><label htmlFor="es">Section</label>
            <select id="es" value={enrollSection} onChange={(e) => setEnrollSection(e.target.value)}>
              {sectionOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></div>
          <div><label htmlFor="an">Admission number</label>
            <input id="an" value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)} required placeholder="STU-0001" /></div>
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={busy || !admissionNo}>Enroll</button>
      </form>
    </>
  );
}
