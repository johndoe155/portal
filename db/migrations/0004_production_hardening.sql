-- 0004_production_hardening.sql — security & lifecycle tables (production review)
-- Adds: login lockout columns, TOTP replay counter, password-reset tokens,
-- user invites, MFA enrollment tokens, DB-backed idempotency, audit hash chain.

BEGIN;

-- ── users: lockout + TOTP replay protection ─────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
-- last accepted TOTP time-step per user; codes at or below it are replays
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_counter bigint;

-- ── password reset tokens (single-use, hashed at rest) ──────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prt_user_idx ON password_reset_tokens (user_id);

-- ── user invites (admin creates; user sets own password on accept) ──────────
CREATE TABLE IF NOT EXISTS user_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  display_name text NOT NULL,
  role_codes   text NOT NULL,               -- JSON array
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_invites_open_uq
  ON user_invites (lower(email)) WHERE accepted_at IS NULL;

-- ── MFA enrollment tokens (admin-issued, single-use; controlled enroll) ─────
CREATE TABLE IF NOT EXISTS mfa_enroll_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── DB-backed idempotency (replaces in-memory map; survives restarts) ───────
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         text PRIMARY KEY,
  method      text NOT NULL,
  path        text NOT NULL,
  status_code integer NOT NULL,
  body        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idem_created_idx ON idempotency_keys (created_at);

-- ── audit hash chain (tamper-evident append log) ────────────────────────────
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash text;

-- ── RLS: service-actor-only tables (auth flows run as SERVICE) ──────────────
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE user_invites          ENABLE ROW LEVEL SECURITY; ALTER TABLE user_invites          FORCE ROW LEVEL SECURITY;
ALTER TABLE mfa_enroll_tokens     ENABLE ROW LEVEL SECURITY; ALTER TABLE mfa_enroll_tokens     FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys      ENABLE ROW LEVEL SECURITY; ALTER TABLE idempotency_keys      FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prt_svc ON password_reset_tokens;
CREATE POLICY prt_svc ON password_reset_tokens FOR ALL
  USING (current_setting('app.role', true) = 'service')
  WITH CHECK (current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS invites_svc ON user_invites;
CREATE POLICY invites_svc ON user_invites FOR ALL
  USING (is_admin_role() OR current_setting('app.role', true) = 'service')
  WITH CHECK (current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS met_svc ON mfa_enroll_tokens;
CREATE POLICY met_svc ON mfa_enroll_tokens FOR ALL
  USING (current_setting('app.role', true) = 'service')
  WITH CHECK (current_setting('app.role', true) = 'service');

DROP POLICY IF EXISTS idem_svc ON idempotency_keys;
CREATE POLICY idem_svc ON idempotency_keys FOR ALL
  USING (current_setting('app.role', true) = 'service')
  WITH CHECK (current_setting('app.role', true) = 'service');

COMMIT;
