-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 — record the currency a payment was initiated in
--
-- school_settings.currency has existed since 0007 and the payment path
-- ignored it: Initialize hardcoded "NGN" and the webhook rejected anything
-- that was not "NGN". A school configured in GHS or KES could set its
-- currency in the UI, watch it appear on invoices, and still have every
-- Paystack charge raised in naira.
--
-- Reading school_settings at webhook time would not be enough either. The
-- webhook arrives minutes or hours after Initialize, and a bursar who
-- changes the school currency in between would make every in-flight payment
-- fail the comparison. So the currency we actually initiated with is stored
-- on the payment row and the webhook compares against that — the same
-- reasoning that already makes amount_kobo authoritative rather than
-- re-derived.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE fee_payments
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'NGN';

COMMENT ON COLUMN fee_payments.currency IS
  'ISO-4217 code this charge was initiated in, copied from school_settings at Initialize. Authoritative for the webhook check.';

COMMIT;
