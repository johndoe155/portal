-- 0008 — review-6 hardening (2026-10-02)
-- #3: CSV import can hand out a temporary password; the account is then locked
-- to the auth endpoints until the password is changed (enforced in
-- session.middleware via 403 password_change_required).
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMIT;
