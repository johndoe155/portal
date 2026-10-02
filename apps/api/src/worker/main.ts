/**
 * Standalone notification worker (Phase 5.3).
 *
 * Dev: point PGLITE_DATA_DIR at the same data dir the API used, with the API
 * stopped (PGlite is single-process). Production: this entry swaps to the
 * node-postgres driver against Neon/Supabase — processQueue/runDigest code is
 * driver-agnostic (drizzle).
 */
import { createDbFromEnv } from "../db/client";
import { runMigrations } from "../db/migrate";
import { startWorker } from "../notify/notify.service";

async function main() {
  // Production: DATABASE_URL → node-postgres (Neon/Supabase/RDS).
  // Dev: PGLITE_DATA_DIR shared with the API (PGlite is single-process — stop
  // the API first, or use WORKER_INPROC=true inside the API instead).
  const { db, runner, kind } = createDbFromEnv();
  if (kind === "pglite" && !process.env.PGLITE_DATA_DIR) {
    console.warn("[worker] no DATABASE_URL or PGLITE_DATA_DIR — running against an empty in-memory DB");
  }
  await runMigrations(runner);
  const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
  console.log(`[worker] started (interval ${intervalMs}ms, db=${kind})`);
  startWorker(db, {
    intervalMs,
    pushSinkFile: process.env.PUSH_SINK_FILE ?? "data/push-outbox.jsonl",
    vapid: process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY,
          subject: process.env.VAPID_SUBJECT ?? "mailto:portal@school.example" }
      : undefined,
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
