-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 — user offboarding
--
-- There was no way to deactivate anyone. A teacher who resigned on Friday kept
-- working credentials on Monday, and the only "offboarding" available was
-- deleting the row — which would have taken their marks, attendance records
-- and message history with it.
--
-- Deactivation is therefore a reversible state change, recorded with who did
-- it, when and why, so the action can be explained to an auditor and undone if
-- it was a mistake.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at   timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by   uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_reason text;

-- Reactivation restores exactly the roles that deactivation revoked, matched
-- on this timestamp, so a user who comes back gets what they had — not a
-- guess, and not an accidental privilege grant.
COMMENT ON COLUMN users.deactivated_at IS
  'Set when the account was deactivated; user_roles revoked at the same instant are restored on reactivation.';

CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);

COMMIT;
