-- ─────────────────────────────────────────────────────────────────────────────
-- 0013 — data retention and erasure
--
-- The legal pages promise things the product did not do. /legal/retention
-- publishes a retention schedule and the privacy policy promises erasure on
-- request, but nothing ever deleted a row: the notifications outbox, revoked
-- sessions, used tokens and dead push subscriptions grew forever, and there
-- was no erasure path at all. That is a published policy the school cannot
-- honour — worse than having no policy.
--
-- This adds:
--   * retention_runs — an auditable record of every purge, including dry runs,
--     so "the purge job runs nightly" is a verifiable claim, not a hope;
--   * push_subscriptions failure tracking, so a subscription can be retired
--     after sustained failure rather than retried forever;
--   * users.anonymized_at / erasure columns, so an erasure is a visible,
--     recorded state rather than a silent UPDATE, and so a record held under
--     a statutory window can be *restricted* rather than deleted.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS retention_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  -- A dry run reports what it would delete and deletes nothing. The scheduled
  -- job commits; the admin screen previews.
  dry_run      boolean NOT NULL DEFAULT false,
  trigger      text NOT NULL DEFAULT 'schedule',     -- schedule | manual | test
  actor_user_id uuid REFERENCES users(id),
  -- {"notifications": 120, "sessions": 8, ...}
  counts       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ok           boolean NOT NULL DEFAULT false,
  error        text
);

CREATE INDEX IF NOT EXISTS retention_runs_recent ON retention_runs (started_at DESC);

ALTER TABLE retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS retention_runs_sel ON retention_runs;
CREATE POLICY retention_runs_sel ON retention_runs FOR SELECT USING (
  is_admin_role() OR current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS retention_runs_ins ON retention_runs;
CREATE POLICY retention_runs_ins ON retention_runs FOR INSERT WITH CHECK (
  is_admin_role() OR current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS retention_runs_upd ON retention_runs;
CREATE POLICY retention_runs_upd ON retention_runs FOR UPDATE USING (
  is_admin_role() OR current_setting('app.role', true) = 'service');

-- ── Push subscriptions: retire what is demonstrably dead ────────────────────
-- Browsers expire push endpoints silently. Without a failure counter the only
-- options were "keep forever" or "delete on first hiccup".
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS last_failure_at timestamptz;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS last_success_at timestamptz;

-- ── Erasure / anonymisation state on users ──────────────────────────────────
-- Erasure here is anonymisation, not DELETE: a pupil's marks, attendance and
-- invoices are statutory records the school must keep, and cascading a delete
-- through them would destroy the class statistics the school is required to
-- produce. Direct identifiers are overwritten; the row (the pseudonymous key)
-- stays.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_by uuid REFERENCES users(id);
-- True when records about this subject are inside a statutory window and are
-- therefore restricted (kept, not processed) rather than erased. NDPA §34(4).
ALTER TABLE users ADD COLUMN IF NOT EXISTS processing_restricted boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS erasure_note text;

CREATE INDEX IF NOT EXISTS users_anonymized ON users (anonymized_at) WHERE anonymized_at IS NOT NULL;

-- ── DELETE policies for the purge ──────────────────────────────────────────
-- Several tables were only ever appended to or updated, so RLS had no DELETE
-- policy at all and a purge would silently affect zero rows — the worst
-- possible failure mode for a retention job, because it looks like it worked.
-- Only the service role (the worker and the erasure path) may delete.
DROP POLICY IF EXISTS notif_del ON notifications;
CREATE POLICY notif_del ON notifications FOR DELETE USING (
  current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS import_jobs_del ON import_jobs;
CREATE POLICY import_jobs_del ON import_jobs FOR DELETE USING (
  current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS identities_del ON identities;
CREATE POLICY identities_del ON identities FOR DELETE USING (
  current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS mfa_del ON mfa_factors;
CREATE POLICY mfa_del ON mfa_factors FOR DELETE USING (
  current_setting('app.role', true) = 'service');

COMMIT;
