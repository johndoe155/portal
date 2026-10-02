import "reflect-metadata";
import { config } from "./config";
import { createDbFromEnv } from "./db/client";
import { runMigrations } from "./db/migrate";
import { seedFromEnv } from "./seed";
import { createApp } from "./app.factory";
import { createMailer, mailConfigured, verifyMailer } from "./notify/mailer";

/**
 * Prove the mail path at boot. A school's first sign that email is broken
 * should be a failed deploy, not a parent who never received a reset link.
 * createMailer() itself throws in production when SMTP_URL is absent.
 */
async function checkMail() {
  const mailer = createMailer();
  if (!mailConfigured()) {
    console.warn("[api] SMTP_URL not set — emails go to the dev sink and are NOT delivered");
    return;
  }
  const { ok, error } = await verifyMailer(mailer);
  if (ok) console.log("[api] SMTP connection verified");
  else console.error(`[api] SMTP verification FAILED: ${error} — email delivery will not work`);
}

async function bootstrap() {
  const { db, runner, kind } = createDbFromEnv();
  const applied = await runMigrations(runner);
  await seedFromEnv(db);
  await checkMail();
  const app = await createApp(db);
  await app.listen(config.port, "0.0.0.0");
  console.log(`[api] listening on :${config.port} db=${kind} ` +
    `(migrations: ${applied.length ? applied.join(", ") : "up-to-date"})`);
}
bootstrap().catch((err) => { console.error(err); process.exit(1); });
