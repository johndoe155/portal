import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePg, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Query-builder type for the whole app. Both drivers expose the identical
 * drizzle PgDialect API (select/insert/update/delete/transaction/execute), so
 * we standardise on one flavour and cast at the factory boundary — a union
 * type here breaks generic methods like `.returning()` at every call site.
 */
export type Db = PgliteDatabase<typeof schema>;

/**
 * Minimal SQL surface the migration runner needs. Both drivers can execute
 * multi-statement scripts (PGlite exec; node-postgres simple-query protocol).
 */
export interface SqlRunner {
  exec(sqlText: string): Promise<void>;
  query<T = Record<string, unknown>>(sqlText: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  /**
   * review-3 #5: run `fn` against a SINGLE pinned connection. Session-scoped
   * state — pg_advisory_lock in particular — is per-connection; against a
   * pool the lock could be taken on one connection and released (or worse,
   * never released) on another. PGlite is inherently single-connection and
   * simply runs `fn` on its shared runner.
   */
  withConnection<T>(fn: (r: SqlRunner) => Promise<T>): Promise<T>;
}

function pgliteRunner(pg: PGlite): SqlRunner {
  const runner: SqlRunner = {
    async exec(sqlText: string) { await pg.exec(sqlText); },
    async query(sqlText: string, params?: unknown[]) {
      const r = params ? await pg.query(sqlText, params as never[]) : await pg.query(sqlText);
      return r.rows as never[];
    },
    async close() { await pg.close(); },
    withConnection(fn) { return fn(runner); },   // single connection by nature
  };
  return runner;
}

function pgRunner(pool: Pool): SqlRunner {
  const runner: SqlRunner = {
    // no params ⇒ simple-query protocol ⇒ multi-statement scripts allowed
    async exec(sqlText: string) { await pool.query(sqlText); },
    async query(sqlText: string, params?: unknown[]) {
      const r = params ? await pool.query(sqlText, params) : await pool.query(sqlText);
      return r.rows as never[];
    },
    async close() { await pool.end(); },
    async withConnection(fn) {
      const client = await pool.connect();
      try {
        const pinned: SqlRunner = {
          async exec(sqlText: string) { await client.query(sqlText); },
          async query(sqlText: string, params?: unknown[]) {
            const r = params ? await client.query(sqlText, params) : await client.query(sqlText);
            return r.rows as never[];
          },
          async close() { /* pinned client lifecycle belongs to withConnection */ },
          withConnection: (f) => f(pinned),
        };
        return await fn(pinned);
      } finally {
        client.release();
      }
    },
  };
  return runner;
}

/** Dev/tests: in-process PGlite (real Postgres, RLS via SET LOCAL ROLE portal_app). */
export function createDb(dataDir?: string): { pg: PGlite; db: Db; runner: SqlRunner } {
  const pg = new PGlite(dataDir);
  const db = drizzlePglite(pg, { schema });
  return { pg, db, runner: pgliteRunner(pg) };
}

/**
 * Environment-driven factory:
 *   DATABASE_URL set → node-postgres pool (production: Neon/Supabase/RDS — schema
 *   and RLS policies are unchanged; connect as the schema owner, which must be a
 *   member of portal_app so withActor can SET LOCAL ROLE and drop privileges).
 *   otherwise        → in-process PGlite (dev/tests).
 */
export function createDbFromEnv(): { db: Db; runner: SqlRunner; kind: "postgres" | "pglite" } {
  const url = process.env.DATABASE_URL;
  // review-2 #4: production must never silently fall back to in-process PGlite
  if (!url && process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is required when NODE_ENV=production — refusing to start on in-memory PGlite. " +
      "Set DATABASE_URL to a real Postgres connection string.",
    );
  }
  if (url) {
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      ssl: process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
        : undefined,
      statement_timeout: 15_000,
    });
    return { db: drizzlePg(pool, { schema }) as unknown as Db, runner: pgRunner(pool), kind: "postgres" };
  }
  const { db, runner } = createDb(process.env.PGLITE_DATA_DIR);
  return { db, runner, kind: "pglite" };
}
