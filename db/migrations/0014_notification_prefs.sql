-- ─────────────────────────────────────────────────────────────────────────────
-- 0014 — notification preferences
--
-- Every digest, absence alert, grade notice and message notification carried
--   List-Unsubscribe: <ORIGIN/account/notifications>
-- and that page did not exist. Only /account/password did. So the one header
-- a mailbox provider uses to decide whether we are a legitimate sender
-- pointed at a 404, and a parent who clicked "unsubscribe" in Gmail got
-- nothing — while the alerts kept coming.
--
-- Opt-out model: an absent key means "send it". That way existing recipients
-- keep their current behaviour and the column can stay empty for almost
-- everyone.
--
-- Security mail (password resets, invitations, MFA enrolment, deactivation
-- notices) is deliberately NOT opt-outable and is not represented here. You
-- cannot unsubscribe from being told your password was changed.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.notification_prefs IS
  'Opt-outs for non-essential email, e.g. {"absence_recorded": false}. Absent key = subscribed.';

COMMIT;
