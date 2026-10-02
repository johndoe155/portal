import "reflect-metadata";
import { config } from "./config";
import { createDbFromEnv } from "./db/client";
import { runMigrations } from "./db/migrate";
import { seedFromEnv } from "./seed";
import { createApp } from "./app.factory";

async function bootstrap() {
  const { db, runner, kind } = createDbFromEnv();
  const applied = await runMigrations(runner);
  await seedFromEnv(db);
  const app = await createApp(db);
  await app.listen(config.port, "0.0.0.0");
  console.log(`[api] listening on :${config.port} db=${kind} ` +
    `(migrations: ${applied.length ? applied.join(", ") : "up-to-date"})`);
}
bootstrap().catch((err) => { console.error(err); process.exit(1); });
