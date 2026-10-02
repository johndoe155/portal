-- Runs once on first postgres container init (docker-entrypoint-initdb.d).
-- Creates the least-privilege runtime role the API drops into via
-- SET LOCAL ROLE (withActor). portal_owner (POSTGRES_USER) owns the schema.
-- review-2: portal_app is NOLOGIN — only ever entered via SET LOCAL ROLE from
-- a portal_owner transaction (withActor). No connection ⇒ no password to leak.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_app') THEN
    CREATE ROLE portal_app NOINHERIT NOLOGIN;
  END IF;
END $$;
GRANT portal_app TO portal_owner;   -- enables SET LOCAL ROLE (privilege drop)
