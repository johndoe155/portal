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
import { startImportWorker } from "../import/import.jobs";
import { createMailer, mailConfigured, verifyMailer } from "../notify/mailer";

async function main() {
  // Production: DATABASE_URL → node-postgres (Neon/Supabase/RDS).
  // Dev: PGLITE_DATA_DIR shared with the API (PGlite is single-process — stop
  // the API first, or use WORKER_INPROC=true inside the API instead).
  const { db, runner, kind } = createDbFromEnv();
  if (kind === "pglite" && !process.env.PGLITE_DATA_DIR) {
    console.warn("[worker] no DATABASE_URL or PGLITE_DATA_DIR — running against an empty in-memory DB");
  }
  await runMigrations(runner);

  // Fail loudly at deploy time, not at 2am. createMailer() throws outright in
  // production when SMTP_URL is missing, so the worker will not start pretending
  // to deliver mail into a JSON sink.
  const mailer = createMailer();
  if (mailConfigured()) {
    const { ok, error } = await verifyMailer(mailer);
    console[ok ? "log" : "error"](ok ? "[worker] SMTP connection verified"
      : `[worker] SMTP verification FAILED: ${error} — email delivery will not work`);
  } else {
    console.warn("[worker] SMTP_URL not set — emails go to the dev sink and are NOT delivered");
  }

  const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
  console.log(`[worker] started (interval ${intervalMs}ms, db=${kind})`);
  // Roster imports are heavy and long-running; they get their own loop so a
  // 6,000-row enrolments file never stalls outbox delivery.
  startImportWorker(db);
  startWorker(db, {
    mailer,
    intervalMs,
    pushSinkFile: process.env.PUSH_SINK_FILE ?? "data/push-outbox.jsonl",
    vapid: process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY,
          subject: process.env.VAPID_SUBJECT ?? "mailto:portal@school.example" }
      : undefined,
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
