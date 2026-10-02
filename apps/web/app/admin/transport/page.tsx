import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import TransportAdmin from "./transport-admin";

interface Route { id: string; name: string; driverName: string | null; driverPhone: string | null; capacity: number | null; active: boolean }
interface Stop { id: string; routeId: string; name: string; pickupTime: string | null; seq: number }
interface Term { id: string; name: string }

export default async function AdminTransport() {
  const session = await requireRole("super_admin", "school_admin");
  const [transport, terms] = await Promise.all([
    apiGet<{ data: { routes: Route[]; stops: Stop[] } }>("/transport/routes"),
    apiGet<{ data: Term[] }>("/terms"),
  ]);
  const routes = transport?.data.routes ?? [];
  const stops = transport?.data.stops ?? [];
  return (
    <Shell session={session}>
      <h1>Transport</h1>
      <TransportAdmin terms={terms?.data ?? []} routeOptions={routes.map((r) => ({ id: r.id, name: r.name }))} />
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Routes</h2>
        {routes.length === 0 ? <div className="muted">No routes yet.</div> : (
          <table>
            <thead><tr><th>Route</th><th>Driver</th><th>Capacity</th><th>Stops</th></tr></thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.driverName ?? "—"}{r.driverPhone ? <div className="muted">{r.driverPhone}</div> : null}</td>
                  <td>{r.capacity ?? "—"}</td>
                  <td>
                    {stops.filter((s) => s.routeId === r.id).sort((a, b) => a.seq - b.seq)
                      .map((s) => `${s.name}${s.pickupTime ? ` (${s.pickupTime})` : ""}`).join(" → ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
