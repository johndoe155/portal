-- 0009_notification_retries.sql — go-live hardening (2026-10-02)
--
-- Problem: a single SMTP hiccup set a notification to status='failed'
-- permanently. One flaky connection and a parent's password-reset link was
-- gone forever, with nobody told. The `attempts` column existed but nothing
-- ever read it.
--
-- This migration turns the outbox into a real retry queue:
--   * next_attempt_at — exponential backoff with jitter, computed by the worker
--   * locked_at/locked_by — visible claim, so a crashed worker's rows are
--     reclaimed rather than stranded (FOR UPDATE SKIP LOCKED handles the race;
--     these columns make a stuck row diagnosable from SQL)
--   * failed_permanently — distinguishes "mailbox does not exist" (never retry)
--     from "connection refused" (retry)
--   * status 'dead' — attempts exhausted; shows up on the admin dead-letter
--     screen for a human to act on
BEGIN;

-- 0002 constrained status to ('queued','sent','failed'). 'dead' (retries
-- exhausted) is a new terminal state, so the CHECK has to be widened before
-- anything can write it. Postgres names an inline column CHECK
-- <table>_<column>_check; drop defensively in case it was named otherwise.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('queued', 'sent', 'failed', 'dead'));

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS locked_at       timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS locked_by       text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS failed_permanently boolean NOT NULL DEFAULT false;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

-- The worker's claim query: WHERE status='queued' AND next_attempt_at <= now()
-- ORDER BY next_attempt_at. Partial index keeps it cheap as `sent` rows pile up.
DROP INDEX IF EXISTS notif_queue_idx;
CREATE INDEX IF NOT EXISTS notif_due_idx
  ON notifications (next_attempt_at, created_at)
  WHERE status = 'queued';

-- Dead-letter screen: "show me everything that needs a human".
CREATE INDEX IF NOT EXISTS notif_dead_idx
  ON notifications (created_at DESC)
  WHERE status IN ('failed', 'dead');

-- Existing rows that were permanently failed by the old code get one more
-- chance: re-queue them with an immediate attempt. A reset link that was
-- dropped by a transient error is worth retrying; genuinely bad addresses
-- will fail again and dead-letter properly this time.
UPDATE notifications
   SET status = 'queued', next_attempt_at = now(), attempts = 0, last_error = NULL
 WHERE status = 'failed'
   AND created_at > now() - interval '7 days';

COMMIT;
