-- ─────────────────────────────────────────────────────────────────────────────
-- One-time bootstrap for a self-managed Postgres instance.
--
--   psql "postgres://<superuser>@<host>:5432/postgres" -f db/bootstrap.sql
--
-- Managed PaaS (Neon / Supabase / RDS): create the two roles through the
-- provider's role management instead, then run the GRANTs in section 3 against
-- the app database. The app itself only needs these three facts to hold:
--   1. it connects as the schema OWNER (portal_owner) — migrations create tables;
--   2. portal_owner is a MEMBER of portal_app — withActor() drops privileges via
--      SET LOCAL ROLE portal_app inside every transaction so RLS binds;
--   3. portal_app is NOT the table owner (owners need FORCE RLS to be limited,
--      which the migrations set anyway).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) roles (skip on managed PaaS — use the provider console/IaC)
-- review-2: portal_app is NOLOGIN — it is never a connection role, it is only
-- ever entered via `SET LOCAL ROLE portal_app` from a portal_owner
-- transaction (withActor). A LOGIN role with a default password is a standing
-- credential that nothing needs; NOLOGIN removes the attack surface entirely.
CREATE ROLE portal_owner LOGIN PASSWORD 'change-me-owner';
CREATE ROLE portal_app  NOINHERIT NOLOGIN;

-- 2) database owned by portal_owner
CREATE DATABASE portal OWNER portal_owner;

-- 3) connect to the app database, then:
--    \c portal
GRANT portal_app TO portal_owner;                 -- enables SET LOCAL ROLE (privilege drop)
GRANT USAGE ON SCHEMA public TO portal_owner;

-- App connection string:
--   DATABASE_URL=postgres://portal_owner:<password>@<host>:5432/portal
-- Backups: scripts/backup.sh (pg_dump -Fc). On managed PaaS prefer the
-- provider's PITR + daily snapshots; keep this for logical exports.
