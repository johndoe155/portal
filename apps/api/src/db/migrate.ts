import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { SqlRunner } from "./client";

export const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "..", "..", "db", "migrations");

/** Advisory-lock key (arbitrary constant) so concurrent boots serialize. */
const MIGRATION_LOCK_KEY = 8675309;

/**
 * Runs pending migrations exactly once, tracked in `schema_migrations` with a
 * SHA-256 content checksum per file. Rules:
 *   - files apply in lexicographic order;
 *   - each file must be self-transactional (BEGIN; … COMMIT;) — a failure
 *     leaves the DB unchanged and the file unrecorded;
 *   - an already-applied file whose contents changed is a HARD ERROR
 *     (migrations are append-only; ship a new file instead of editing);
 *   - review-2 ops: an advisory lock serializes concurrent boots so two API
 *     instances racing on deploy don't both try to apply the same file.
 *   - review-3 #5: the lock, the migrations and the unlock ALL run on one
 *     pinned connection (withConnection). pg_advisory_lock is session state:
 *     against a pool, `pool.query` could lock on connection A and unlock on
 *     connection B — the unlock silently fails and every other booting node
 *     (and the worker) blocks until connection A happens to close.
 */
export async function runMigrations(runner: SqlRunner): Promise<string[]> {
  return runner.withConnection(async (r) => {
    // Advisory lock (PG-only; PGlite is single-process so it's a no-op there)
    let locked = false;
    try { await r.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]); locked = true; }
    catch { /* PGlite or lock unavailable — proceed without serialization */ }
    try {
      return await applyMigrations(r);
    } finally {
      if (locked) {
        try { await r.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]); }
        catch { /* best-effort unlock — connection close releases it anyway */ }
      }
    }
  });
}

async function applyMigrations(runner: SqlRunner): Promise<string[]> {
  await runner.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const recorded = new Map(
    (await runner.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum FROM schema_migrations`,
    )).map((r) => [r.filename, r.checksum]),
  );

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    const checksum = createHash("sha256").update(sqlText).digest("hex");
    const prev = recorded.get(f);
    if (prev) {
      if (prev !== checksum) {
        throw new Error(
          `migration ${f} was modified after being applied (recorded ${prev.slice(0, 12)}…, ` +
          `file ${checksum.slice(0, 12)}…). Migrations are append-only — add a new file.`,
        );
      }
      continue;
    }
    await runner.exec(sqlText);
    await runner.query(`INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`, [f, checksum]);
    applied.push(f);
  }
  return applied;
}
