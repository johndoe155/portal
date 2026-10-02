/**
 * Ops CLI — issue an MFA enrollment token for a user (controlled TOTP setup).
 * This is the bootstrap path for the FIRST admin: after starting the API once
 * with BOOTSTRAP_ADMIN_EMAIL/PASSWORD, run:
 *
 *   DATABASE_URL=postgres://... node scripts/mfa-token.mjs admin@school.example
 *
 * Hand the printed token to the user over a trusted channel; they log in with
 * their password and POST /api/v1/auth/mfa/totp/enroll {token}. Single-use, 24 h.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const email = process.argv[2];
if (!email) { console.error("usage: node scripts/mfa-token.mjs <email>"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }

const { createDbFromEnv } = require("../apps/api/dist/db/client.js");
const { issueEnrollToken } = require("../apps/api/dist/auth/enroll-token.js");
const { withActor, SERVICE } = require("../apps/api/dist/db/actor.js");
const { users } = require("../apps/api/dist/db/schema.js");
const { eq, sql } = require("drizzle-orm");

const { db, runner } = createDbFromEnv();
const [user] = await withActor(db, SERVICE, async (tx) =>
  tx.select({ id: users.id, email: users.email }).from(users)
    .where(eq(sql`lower(${users.email})`, email.toLowerCase())).limit(1));
if (!user) { console.error(`no such user: ${email}`); process.exit(1); }

const token = await issueEnrollToken(db, user.id, null);
console.log(`MFA enrollment token for ${user.email} (single-use, 24 h):`);
console.log(token);
await runner.close();
