import { redirect } from "next/navigation";
import { checkSession, ROLE_HOME } from "@/lib/session";
import PaymentReturn from "./payment-return";

export const metadata = { title: "Payment — School Portal" };

/**
 * Where Paystack sends the payer back to.
 *
 * Initialize used to send no callback_url at all, so after paying school
 * fees a parent landed on Paystack's own generic confirmation page with no
 * route back to the portal and no indication the school knew anything had
 * happened. The obvious next move for a worried parent is to pay again.
 */
export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string; trxref?: string }>;
}) {
  const check = await checkSession();
  if (check.kind === "anon") redirect("/login");
  if (check.kind === "mfa") redirect("/mfa");
  const sp = await searchParams;
  // Paystack appends both; they carry the same value.
  const reference = sp.reference ?? sp.trxref ?? "";
  const home = ROLE_HOME[check.session.activeRole] ?? "/parent";
  return (
    <div className="container" style={{ maxWidth: 560, paddingTop: 32 }}>
      <h1>Payment</h1>
      <PaymentReturn reference={reference} home={home} />
    </div>
  );
}
