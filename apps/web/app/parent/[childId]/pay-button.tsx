"use client";
import { useState } from "react";
import { api } from "@/lib/client";

/**
 * review-2 #7: parent pays their own child's invoice.
 * Calls the guardian-scoped initiate endpoint; on success opens the Paystack
 * checkout URL in a new tab.
 */
export default function PayButton({ childId, invoiceId }: { childId: string; invoiceId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function pay() {
    setBusy(true); setErr("");
    try {
      const res = await api<{ checkout_url: string | null }>(
        `/parent/children/${childId}/fees/invoices/${invoiceId}/initiate`,
        { method: "POST" },
      );
      if (res.checkout_url) {
        window.open(res.checkout_url, "_blank", "noopener");
      } else {
        setErr("Payment gateway did not return a checkout URL.");
      }
    } catch (e: any) {
      setErr(e?.message ?? "Could not initiate payment");
    }
    setBusy(false);
  }

  return (
    <span>
      <button className="btn" style={{ padding: "4px 10px", fontSize: 13 }} onClick={pay} disabled={busy}>
        {busy ? "…" : "Pay"}
      </button>
      {err && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>{err}</span>}
    </span>
  );
}
