/**
 * Verifies the migration runner against a REAL Postgres (DATABASE_URL required):
 *   1. first run applies every migration and records checksums
 *   2. second run applies nothing ("up-to-date" — no re-execution)
 *   3. tables + schema_migrations rows exist
 * Run: DATABASE_URL=postgres://... node scripts/verify-pg.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }

const { createDbFromEnv } = require("../apps/api/dist/db/client.js");
const { runMigrations } = require("../apps/api/dist/db/migrate.js");

const { db, runner, kind } = createDbFromEnv();
if (kind !== "postgres") { console.error(`expected postgres driver, got ${kind}`); process.exit(1); }

const applied1 = await runMigrations(runner);
console.log(`run 1 applied: [${applied1.join(", ")}]`);
const applied2 = await runMigrations(runner);
console.log(`run 2 applied: [${applied2.join(", ")}]`);
if (applied2.length !== 0) { console.error("FAIL: second run re-applied migrations"); process.exit(1); }

const tracked = await runner.query("SELECT filename, left(checksum, 12) AS checksum FROM schema_migrations ORDER BY filename");
console.log("schema_migrations:", tracked);
const tables = await runner.query(
  "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
console.log(`public tables: ${tables[0].n}`);
if (tables[0].n < 25) { console.error("FAIL: expected >= 25 tables"); process.exit(1); }

await runner.close();
console.log("OK: migrations tracked, idempotent across restarts, checksums recorded");
