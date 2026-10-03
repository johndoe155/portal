-- ─────────────────────────────────────────────────────────────────────────────
-- 0015 — remove Web Push
--
-- Push was half-built and the half that existed was worse than nothing:
--
--   * the server had a subscribe endpoint, an unsubscribe endpoint, this
--     table, a web-push dependency and a retention rule for retiring dead
--     endpoints;
--   * the browser had no service worker, no manifest, no icons and no UI to
--     ask for permission — so no row was ever written to this table;
--   * and with no VAPID keys configured, the worker wrote the payload to a
--     JSONL file on the container's disk and marked the notification SENT.
--
-- That last point is the reason this is being deleted rather than finished.
-- A school looking at the outbox saw "sent" for an absence alert that reached
-- nobody. Guardians already receive the same alert by email, which is the
-- channel that actually works, so removing push loses no delivered message.
--
-- Shipping a real PWA (service worker, offline attendance, install prompt) is
-- a genuine piece of work and stays on the roadmap as a future phase. It will
-- bring its own table when it is actually built.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

DROP TABLE IF EXISTS push_subscriptions;

COMMIT;
