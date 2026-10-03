"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

interface Status {
  reference: string;
  status: "pending" | "success" | "failed" | string;
  amount_kobo: number;
  currency: string;
  paid_at: string | null;
  invoice_label: string | null;
  invoice_status: string | null;
}

/**
 * The payer's answer to "did that work?".
 *
 * Deliberately NOT trusting the query string Paystack appends — the payer can
 * edit it. The only authority is our own payment row, which is updated by the
 * signed webhook. While that webhook is in flight the honest answer is
 * "we are confirming", so the page polls for a short while and then tells the
 * parent what to do rather than spinning forever.
 */
export default function PaymentReturn({ reference, home }: { reference: string; home: string }) {
  const [state, setState] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [waited, setWaited] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const s = await api<Status>(`/fees/payments/${encodeURIComponent(reference)}/status`);
      setState(s);
      if (s.status === "pending") {
        setWaited((w) => w + 3);
        timer.current = setTimeout(() => { void poll(); }, 3000);
      }
    } catch (e: any) {
      setErr(e?.status === 404
        ? "We cannot find that payment. If money has left your account, contact the school office with the reference below — nothing is lost."
        : e?.message ?? "Could not check the payment.");
    }
  }, [reference]);

  useEffect(() => {
    if (!reference) { setErr("No payment reference was supplied."); return; }
    void poll();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [reference, poll]);

  const money = (kobo: number, currency: string) =>
    `${currency} ${(kobo / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  if (err) {
    return (
      <div className="card">
        <div className="alert err" role="alert">{err}</div>
        {reference && <p className="muted" style={{ fontSize: 13 }}>Reference: <code>{reference}</code></p>}
        <a className="btn ghost" href={home}>Back to the portal</a>
      </div>
    );
  }

  if (!state) return <div className="card"><p className="muted">Checking your payment…</p></div>;

  if (state.status === "success") {
    return (
      <div className="card">
        <div className="alert ok" role="status"><strong>Payment received.</strong></div>
        <p>
          {money(state.amount_kobo, state.currency)}
          {state.invoice_label ? ` towards ${state.invoice_label}` : ""} has been recorded
          {state.invoice_status === "paid" ? " and that invoice is now settled." : "."}
        </p>
        <p className="muted" style={{ fontSize: 13 }}>Reference: <code>{state.reference}</code></p>
        <a className="btn" href={home}>Back to the portal</a>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="card">
        <div className="alert err" role="alert"><strong>That payment did not go through.</strong></div>
        <p>Nothing has been charged against your invoice. You can try again from your child&apos;s fees page.</p>
        <p className="muted" style={{ fontSize: 13 }}>Reference: <code>{state.reference}</code></p>
        <a className="btn" href={home}>Back to the portal</a>
      </div>
    );
  }

  return (
    <div className="card">
      <p role="status"><strong>Confirming your payment…</strong></p>
      <p className="muted">
        Your bank has sent us back here and we are waiting for the gateway to confirm.
        This usually takes a few seconds. You do not need to pay again.
      </p>
      {waited >= 30 && (
        <p className="muted">
          It is taking longer than usual. It is safe to leave this page — the payment will
          appear on the fees page once confirmed. If it has not within an hour, contact the
          school office quoting the reference below.
        </p>
      )}
      <p className="muted" style={{ fontSize: 13 }}>Reference: <code>{state.reference}</code></p>
      <a className="btn ghost" href={home}>Back to the portal</a>
    </div>
  );
}
