-- 0005_review2_hardening.sql — second production review (2026-10-01).
-- Adds: MFA recovery codes (lost-phone path), idempotency keys scoped per
-- user+path with atomic claim, notifications addressed to bare emails
-- (invites — the recipient has no user row yet), and the parent fees:pay
-- permission (deliberate parent-pay exception to the read-only rule).

BEGIN;

-- ── MFA recovery codes: single-use, hashed at rest (lost-phone recovery) ──
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  code_hash  text NOT NULL UNIQUE,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_rc_user_idx ON mfa_recovery_codes (user_id);

ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mrc_svc ON mfa_recovery_codes;
CREATE POLICY mrc_svc ON mfa_recovery_codes FOR ALL
  USING (current_setting('app.role', true) = 'service')
  WITH CHECK (current_setting('app.role', true) = 'service');

-- ── notifications: allow bare-email recipients (invite flow) ───────────────
ALTER TABLE notifications ALTER COLUMN recipient_user_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recipient_email text;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_recipient_chk;
ALTER TABLE notifications ADD CONSTRAINT notifications_recipient_chk
  CHECK (recipient_user_id IS NOT NULL OR recipient_email IS NOT NULL);

-- ── idempotency: scoped per (key, user, path); claim row precedes the work ──
-- The table is ephemeral (24 h TTL, replay-cache only) — recreate is safe.
DROP TABLE IF EXISTS idempotency_keys;
CREATE TABLE idempotency_keys (
  key         text NOT NULL,
  user_id     uuid NOT NULL,
  path        text NOT NULL,
  method      text NOT NULL,
  status      text NOT NULL DEFAULT 'processing',   -- processing | done
  status_code integer,
  body        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id, path)
);
CREATE INDEX IF NOT EXISTS idem_created_idx ON idempotency_keys (created_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idem_svc ON idempotency_keys;
CREATE POLICY idem_svc ON idempotency_keys FOR ALL
  USING (current_setting('app.role', true) = 'service')
  WITH CHECK (current_setting('app.role', true) = 'service');

-- ── parents may pay their own children's invoices (deliberate exception) ───
-- Conditional: on a fresh DB the roles table is empty (seed runs after
-- migrations and creates fees:pay). On an existing DB the 'parent' role
-- already exists, so we add the new permission here.
-- Temporarily disable RLS so the migration runner (table owner) can INSERT.
ALTER TABLE role_permissions DISABLE ROW LEVEL SECURITY;
INSERT INTO role_permissions (role_code, permission)
  SELECT 'parent', 'fees:pay'
  WHERE EXISTS (SELECT 1 FROM roles WHERE code = 'parent')
  ON CONFLICT DO NOTHING;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

COMMIT;
