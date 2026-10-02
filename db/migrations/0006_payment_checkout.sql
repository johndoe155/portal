-- ─────────────────────────────────────────────────────────────────────────────
-- 0006 — review-4: payment retry + remaining-balance fixes
--
--  • checkout_url / access_code persist the Paystack Initialize result on the
--    pending payment. Retries return the STORED checkout instead of calling
--    Initialize again with the same reference (Paystack rejects duplicate
--    references — the mock hides this, the real gateway would 502).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE fee_payments ADD COLUMN IF NOT EXISTS checkout_url text;
ALTER TABLE fee_payments ADD COLUMN IF NOT EXISTS access_code  text;

COMMIT;
