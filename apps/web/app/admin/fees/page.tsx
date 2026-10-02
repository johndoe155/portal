import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import FeesAdmin from "./fees-admin";
import TemplatesPanel from "./templates-panel";

interface Invoice { id: string; studentUserId: string; termId: string; label: string; amountKobo: number; status: string; dueDate: string | null }
interface Term { id: string; name: string }
interface UserRow { id: string; displayName: string; email: string }

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

export default async function AdminFees() {
  const session = await requireRole("super_admin", "school_admin");
  const [invoices, terms, users] = await Promise.all([
    apiGet<{ data: Invoice[] }>("/fees/invoices"),
    apiGet<{ data: Term[] }>("/terms"),
    apiGet<{ data: UserRow[] }>("/users?per=100"),
  ]);
  return (
    <Shell session={session}>
      <h1>Fees</h1>
      <p className="muted">Amounts in Naira; stored in kobo (Paystack convention). Webhook-completed payments arrive automatically.</p>
      <TemplatesPanel />
      <FeesAdmin terms={terms?.data ?? []} students={(users?.data ?? [])} />
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Invoices</h2>
        {(invoices?.data ?? []).length === 0 ? <div className="muted">No invoices yet.</div> : (
          <table>
            <thead><tr><th>Student</th><th>Label</th><th>Amount</th><th>Status</th><th>Due</th></tr></thead>
            <tbody>
              {(invoices?.data ?? []).map((inv) => {
                const stu = (users?.data ?? []).find((u) => u.id === inv.studentUserId);
                return (
                  <tr key={inv.id}>
                    <td>{stu?.displayName ?? inv.studentUserId.slice(0, 8)}</td>
                    <td>{inv.label}</td>
                    <td>{naira(inv.amountKobo)}</td>
                    <td><span className={`chip ${inv.status === "paid" ? "on-present" : inv.status === "partial" ? "on-late" : "on-absent"}`}>{inv.status}</span></td>
                    <td>{inv.dueDate ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
