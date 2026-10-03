-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 — record the DPIA instead of asserting one
--
-- /legal/privacy §5 told every reader that the school relies on "a filed Data
-- Protection Impact Assessment (DPIA) with the Nigeria Data Protection
-- Commission", and /legal/retention repeated it. Nothing in this system had
-- ever recorded a DPIA. The claim was published to parents, on the school's
-- behalf, by software — and if the NDPC ever asked, the school would be the
-- one explaining why its own privacy policy said something untrue.
--
-- Same shape as dpo_email, which had the same problem and was fixed the same
-- way: store what the school actually has, render it, and when it is absent
-- say so plainly on the page rather than asserting the comfortable version.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS dpia_reference text,
  ADD COLUMN IF NOT EXISTS dpia_completed_at date;

COMMENT ON COLUMN school_settings.dpia_reference IS
  'Reference of the school''s completed Data Protection Impact Assessment. NULL = none recorded, and the legal pages say so.';

COMMIT;
