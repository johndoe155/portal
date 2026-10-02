-- 0007 — phase 6: real-school bootstrap.
-- Adds: school_settings (single-row identity), grading_config (scale + weights),
-- fee_templates (bulk invoice generation), guardian verification columns,
-- and the settings:write permission. Idempotent (IF NOT EXISTS / guarded).

BEGIN;

-- ── school identity (single row, id fixed) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS school_settings (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name          text NOT NULL DEFAULT 'School Portal',
  logo_url      text,
  primary_color text NOT NULL DEFAULT '#1d4ed8',
  accent_color  text NOT NULL DEFAULT '#0ea5e9',
  contact_email text,
  dpo_email     text,
  address       text,
  phone         text,
  timezone      text NOT NULL DEFAULT 'Africa/Lagos',
  currency      text NOT NULL DEFAULT 'NGN',
  mail_sender   text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid
);

-- ── grading configuration (single row): scale + default weights ─────────────
CREATE TABLE IF NOT EXISTS grading_config (
  id       int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config   jsonb NOT NULL DEFAULT
    '{"scale":[{"letter":"A","min_pct":80,"point":4},{"letter":"B","min_pct":65,"point":3},
               {"letter":"C","min_pct":50,"point":2},{"letter":"D","min_pct":40,"point":1},
               {"letter":"F","min_pct":0,"point":0}],
      "weights":{"exam":60,"coursework":40}}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- ── fee templates → bulk invoice generation ─────────────────────────────────
CREATE TABLE IF NOT EXISTS fee_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  grade_level smallint,                    -- NULL = applies to every grade
  due_days    int NOT NULL DEFAULT 14,     -- due = generation date + due_days
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid
);

-- ── guardian link verification ───────────────────────────────────────────────
ALTER TABLE guardians ADD COLUMN IF NOT EXISTS verify_token_hash text;
ALTER TABLE guardians ADD COLUMN IF NOT EXISTS requested_by uuid;

-- ── invited students carry their record fields (accept creates students row) ─
ALTER TABLE user_invites ADD COLUMN IF NOT EXISTS grade_level smallint;
ALTER TABLE user_invites ADD COLUMN IF NOT EXISTS admission_no text;

-- ── RLS (BEFORE any data inserts — then disable for the owner's seed rows,
--    same pattern as 0005) ────────────────────────────────────────────────────
ALTER TABLE school_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE school_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE grading_config  ENABLE ROW LEVEL SECURITY; ALTER TABLE grading_config  FORCE ROW LEVEL SECURITY;
ALTER TABLE fee_templates   ENABLE ROW LEVEL SECURITY; ALTER TABLE fee_templates   FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS school_settings_sel ON school_settings;
CREATE POLICY school_settings_sel ON school_settings FOR SELECT USING (current_setting('app.role', true) <> '');
DROP POLICY IF EXISTS school_settings_wr ON school_settings;
CREATE POLICY school_settings_wr ON school_settings FOR UPDATE USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));

DROP POLICY IF EXISTS grading_config_sel ON grading_config;
CREATE POLICY grading_config_sel ON grading_config FOR SELECT USING (current_setting('app.role', true) <> '');
DROP POLICY IF EXISTS grading_config_wr ON grading_config;
CREATE POLICY grading_config_wr ON grading_config FOR UPDATE USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));

DROP POLICY IF EXISTS fee_templates_sel ON fee_templates;
CREATE POLICY fee_templates_sel ON fee_templates FOR SELECT USING (is_staff_role());
DROP POLICY IF EXISTS fee_templates_wr ON fee_templates;
CREATE POLICY fee_templates_wr ON fee_templates FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));

ALTER TABLE school_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE grading_config  DISABLE ROW LEVEL SECURITY;
INSERT INTO school_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO grading_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE school_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE grading_config  ENABLE ROW LEVEL SECURITY;

-- ── permission: school settings writer ──────────────────────────────────────
-- Conditional (0005 pattern): on a fresh DB the roles table is empty here —
-- seedBase creates roles AND settings:write right after migrations. On an
-- existing DB the roles already exist, so the permission lands here.
ALTER TABLE role_permissions DISABLE ROW LEVEL SECURITY;
INSERT INTO role_permissions (role_code, permission)
  SELECT r.code, 'settings:write'
  FROM roles r
  WHERE r.code IN ('super_admin','school_admin')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

COMMIT;
