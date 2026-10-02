"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

interface Term { id: string; name: string }
interface RouteOption { id: string; name: string }

export default function TransportAdmin({ terms, routeOptions }: { terms: Term[]; routeOptions: RouteOption[] }) {
  const [name, setName] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [capacity, setCapacity] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  // stop
  const [stopRoute, setStopRoute] = useState(routeOptions[0]?.id ?? "");
  const [stopName, setStopName] = useState("");
  const [pickupTime, setPickupTime] = useState("");
  // assign
  const [admissionNo, setAdmissionNo] = useState("");
  const [assignRoute, setAssignRoute] = useState(routeOptions[0]?.id ?? "");
  const [assignTerm, setAssignTerm] = useState(terms[0]?.id ?? "");
  const router = useRouter();

  async function createRoute(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setInfo("");
    try {
      await api("/transport/routes", {
        method: "POST",
        body: JSON.stringify({
          name,
          ...(driverName ? { driver_name: driverName } : {}),
          ...(driverPhone ? { driver_phone: driverPhone } : {}),
          ...(capacity ? { capacity: parseInt(capacity, 10) } : {}),
        }),
      });
      setInfo(`Route "${name}" created.`);
      setName(""); setDriverName(""); setDriverPhone(""); setCapacity("");
      router.refresh();
    } catch (e: any) { setErr(e?.message ?? "Could not create route"); }
    setBusy(false);
  }

  async function createStop(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setInfo("");
    try {
      await api(`/transport/routes/${stopRoute}/stops`, {
        method: "POST",
        body: JSON.stringify({ name: stopName, ...(pickupTime ? { pickup_time: pickupTime } : {}) }),
      });
      setInfo(`Stop "${stopName}" added.`);
      setStopName(""); setPickupTime("");
      router.refresh();
    } catch (e: any) { setErr(e?.message ?? "Could not add stop"); }
    setBusy(false);
  }

  async function assign(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setInfo("");
    try {
      const stu = await api<{ userId: string; displayName: string }>(
        `/students-lookup?admission_no=${encodeURIComponent(admissionNo)}`);
      await api("/transport/assignments", {
        method: "POST",
        body: JSON.stringify({ student_user_id: stu.userId, route_id: assignRoute, term_id: assignTerm }),
      });
      setInfo(`Assigned ${stu.displayName} to a route.`);
      setAdmissionNo("");
      router.refresh();
    } catch (e: any) {
      setErr(e?.code === "not_found" ? "No student with that admission number."
        : e?.code === "already_assigned" ? "That student already has an active route this term."
        : e?.message ?? "Assign failed");
    }
    setBusy(false);
  }

  return (
    <>
      <form className="card" onSubmit={createRoute}>
        <h2 style={{ marginTop: 0 }}>New route</h2>
        {err && <div className="alert err" role="alert">{err}</div>}
        {info && <div className="alert ok" role="status">{info}</div>}
        <div className="grid cols2">
          <div><label htmlFor="rname">Route name</label>
            <input id="rname" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Route C — Mile 3" /></div>
          <div><label htmlFor="rcap">Capacity</label>
            <input id="rcap" inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="30" /></div>
          <div><label htmlFor="rdriver">Driver name</label>
            <input id="rdriver" value={driverName} onChange={(e) => setDriverName(e.target.value)} /></div>
          <div><label htmlFor="rphone">Driver phone</label>
            <input id="rphone" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} placeholder="+234 …" /></div>
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={busy || !name}>Create route</button>
      </form>

      <form className="card" onSubmit={createStop}>
        <h2 style={{ marginTop: 0 }}>Add stop</h2>
        <div className="grid cols3">
          <div><label htmlFor="sroute">Route</label>
            <select id="sroute" value={stopRoute} onChange={(e) => setStopRoute(e.target.value)}>
              {routeOptions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select></div>
          <div><label htmlFor="sname">Stop name</label>
            <input id="sname" value={stopName} onChange={(e) => setStopName(e.target.value)} required placeholder="Peter Odili Rd" /></div>
          <div><label htmlFor="stime">Pickup time</label>
            <input id="stime" type="time" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} /></div>
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={busy || !stopName || !stopRoute}>Add stop</button>
      </form>

      <form className="card" onSubmit={assign}>
        <h2 style={{ marginTop: 0 }}>Assign student</h2>
        <div className="grid cols3">
          <div><label htmlFor="aadno">Admission no.</label>
            <input id="aadno" value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)} required placeholder="STU-0001" /></div>
          <div><label htmlFor="aroute">Route</label>
            <select id="aroute" value={assignRoute} onChange={(e) => setAssignRoute(e.target.value)}>
              {routeOptions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select></div>
          <div><label htmlFor="aterm">Term</label>
            <select id="aterm" value={assignTerm} onChange={(e) => setAssignTerm(e.target.value)}>
              {terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></div>
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={busy || !admissionNo}>Assign</button>
      </form>
    </>
  );
}
