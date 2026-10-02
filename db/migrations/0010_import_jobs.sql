-- 0010_import_jobs.sql — asynchronous roster import (2026-10-02)
--
-- Problem: the whole CSV went up as one JSON body and was applied in one
-- transaction. The API caps bodies at 1 MB and the Next proxy times out around
-- 30 s, while scrypt costs ~100 ms per account row. A real school's enrolments
-- file (6,000 rows) exceeded both limits — the import simply could not be done.
--
-- Fix: the file is uploaded as multipart, parked on disk, and processed by the
-- worker in batches. This table is the job record: progress is observable, a
-- crashed worker resumes from the last committed batch, and per-row problems
-- are retained for a downloadable error report instead of a 6,000-row HTML
-- table.
BEGIN;

CREATE TABLE IF NOT EXISTS import_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('students','staff','guardians','sections','enrollments')),
  dry_run        boolean NOT NULL DEFAULT false,
  state          text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','running','completed','failed','cancelled')),
  -- who asked for it; the batch runs with their role for grant checks
  requested_by   uuid NOT NULL,
  actor_role     text NOT NULL,
  filename       text,
  -- absolute path of the parked upload; removed when the job finishes
  source_path    text,
  byte_size      bigint,
  total_rows     integer NOT NULL DEFAULT 0,
  -- resume point: rows before this offset are already committed
  processed_rows integer NOT NULL DEFAULT 0,
  created_count  integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  error_count    integer NOT NULL DEFAULT 0,
  -- per-row problems; capped in the app so a pathological file cannot bloat a row
  problems       jsonb NOT NULL DEFAULT '[]',
  -- set-password links when SMTP is unconfigured; cleared once downloaded
  secrets        jsonb NOT NULL DEFAULT '[]',
  error_message  text,
  locked_by      text,
  locked_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

CREATE INDEX IF NOT EXISTS import_jobs_pending_idx
  ON import_jobs (created_at) WHERE state IN ('pending','running');
CREATE INDEX IF NOT EXISTS import_jobs_requester_idx
  ON import_jobs (requested_by, created_at DESC);

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;

-- Imports are an admin-tier operation; the worker runs as 'service'.
DROP POLICY IF EXISTS import_jobs_sel ON import_jobs;
CREATE POLICY import_jobs_sel ON import_jobs FOR SELECT USING (
  is_admin_role() OR current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS import_jobs_ins ON import_jobs;
CREATE POLICY import_jobs_ins ON import_jobs FOR INSERT WITH CHECK (
  is_admin_role() OR current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS import_jobs_upd ON import_jobs;
CREATE POLICY import_jobs_upd ON import_jobs FOR UPDATE USING (
  is_admin_role() OR current_setting('app.role', true) = 'service');

COMMIT;
