-- ─────────────────────────────────────────────────────────────────────────────
-- 0012 — academic year rollover
--
-- Nothing existed for this, which made the portal a one-year tool: there was
-- no way to start a new academic year, promote pupils, or graduate the top
-- cohort. A school reaching the end of its first year would have had to edit
-- the database by hand.
--
-- Rollover touches every pupil at once, so it is recorded as an operation
-- rather than just a pile of UPDATEs:
--   * it can be previewed (dry run) before anything is written;
--   * it is idempotent — running it twice does not promote anyone twice;
--   * the per-pupil before-state is stored, so it can be reverted if someone
--     rolls over a week early or with the wrong graduating year.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS year_rollovers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_year_id   uuid NOT NULL REFERENCES academic_years(id),
  to_year_id     uuid NOT NULL REFERENCES academic_years(id),
  performed_by   uuid REFERENCES users(id),
  performed_at   timestamptz NOT NULL DEFAULT now(),
  -- Counts, for the history screen.
  summary        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-pupil prior state: [{userId, fromGrade, fromStatus, userStatus, action}].
  -- This is what makes a revert possible rather than theoretical.
  student_states jsonb NOT NULL DEFAULT '[]'::jsonb,
  reverted_at    timestamptz,
  reverted_by    uuid REFERENCES users(id),
  -- One completed rollover per year pair. The partial index ignores reverted
  -- rows so a corrected rollover can be re-run after an undo.
  CONSTRAINT year_rollovers_distinct CHECK (from_year_id <> to_year_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS year_rollovers_once
  ON year_rollovers (from_year_id, to_year_id)
  WHERE reverted_at IS NULL;

CREATE INDEX IF NOT EXISTS year_rollovers_recent
  ON year_rollovers (performed_at DESC);

ALTER TABLE year_rollovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE year_rollovers FORCE ROW LEVEL SECURITY;

-- Rollover is an admin-tier operation; the worker/service may also read it.
DROP POLICY IF EXISTS year_rollovers_sel ON year_rollovers;
CREATE POLICY year_rollovers_sel ON year_rollovers FOR SELECT USING (
  is_admin_role() OR current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS year_rollovers_ins ON year_rollovers;
CREATE POLICY year_rollovers_ins ON year_rollovers FOR INSERT WITH CHECK (
  is_admin_role() OR current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS year_rollovers_upd ON year_rollovers;
CREATE POLICY year_rollovers_upd ON year_rollovers FOR UPDATE USING (
  is_admin_role() OR current_setting('app.role', true) = 'service');

COMMIT;
