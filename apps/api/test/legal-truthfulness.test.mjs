/**
 * The published legal pages have to be true.
 *
 * Three claims were not:
 *
 *   1. /legal/privacy §9 said "bcrypt password hashing". The code has always
 *      used scrypt (apps/api/src/crypto/password.ts). Harmless-looking, but
 *      it is a security claim in a published policy, and the kind of detail a
 *      regulator or an auditor checks precisely because it is checkable.
 *
 *   2. /legal/privacy §5 and /legal/retention both told readers a DPIA was
 *      "filed with the NDPC". Nothing in this system had ever recorded one.
 *      Software published that claim on the school's behalf with no way of
 *      knowing whether it was true.
 *
 *   3. /legal/retention said under-13 data is processed "only with verified
 *      parental consent obtained at enrollment". The portal records no
 *      consent, and `students` has no date of birth — it cannot even tell
 *      which pupils are under 13.
 *
 * (1) is simply fixed. (2) and (3) are fixed by making the pages report what
 * the school has actually recorded, and say so when it has recorded nothing.
 * These tests hold the server side of that: the DPIA field round-trips, and
 * go-live notices an empty one.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.COOKIE_SECURE = "false";
process.env.WORKER_INPROC = "false";

const require = createRequire(import.meta.url);
const { createDb } = require("../dist/db/client.js");
const { runMigrations } = require("../dist/db/migrate.js");
const { seed } = require("../dist/seed.js");
const { createApp } = require("../dist/app.factory.js");
const { totpCode } = require("../dist/crypto/totp.js");
const { withActor, SERVICE } = require("../dist/db/actor.js");
const { issueEnrollToken } = require("../dist/auth/enroll-token.js");
const { goLiveReadiness } = require("../dist/ops/go-live.service.js");
const { hashPassword } = require("../dist/crypto/password.js");
const { users } = require("../dist/db/schema.js");
const { eq } = require("drizzle-orm");
const request = require("supertest");

let app, server, db;
const jars = {};
const WEB = join(import.meta.dirname, "../../web/app");

function cookiesOf(res) {
  const out = {};
  for (const c of res.headers["set-cookie"] ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}
const auth = (n) => ({ Cookie: `sid=${jars[n].sid}; csrf=${jars[n].csrf}`, "x-csrf": jars[n].csrf });
async function staffLogin(name, email) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password: "Passw0rd!" });
  jars[name] = cookiesOf(res);
  const [u] = await withActor(db, SERVICE, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  const token = await issueEnrollToken(db, u.id, null);
  const e = await request(server).post("/api/v1/auth/mfa/totp/enroll").set(auth(name)).send({ token });
  const v = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(e.body.secret) });
  assert.equal(v.status, 201, JSON.stringify(v.body));
}
const page = (p) => readFileSync(join(WEB, p), "utf8");
const byId = (r, id) => r.checks.find((c) => c.id === id);

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");
});
after(async () => { await app.close(); });

/* ── 1. the algorithm we name is the algorithm we use ────────────────────── */

test("the privacy policy names the hash the code actually uses", async () => {
  const stored = await hashPassword("Passw0rd!");
  assert.ok(stored.startsWith("scrypt$"), `password format is ${stored.slice(0, 12)}…`);

  const privacy = page("legal/privacy/page.tsx");
  assert.ok(!/bcrypt/i.test(privacy), "the policy claimed bcrypt; the code has always used scrypt");
  assert.match(privacy, /scrypt/);
  // While we are here: the other security claims on that page.
  assert.match(privacy, /AES-256-GCM/);
  assert.match(privacy, /row-level security/i);
});

/* ── 2. the DPIA is reported, not asserted ───────────────────────────────── */

test("neither legal page claims a DPIA exists", () => {
  for (const p of ["legal/privacy/page.tsx", "legal/retention/page.tsx"]) {
    const src = page(p);
    assert.ok(!/is filed with|a filed Data Protection Impact/i.test(src),
      `${p} still asserts a filed DPIA`);
    assert.match(src, /DpiaStatement/, `${p} should report what the school recorded`);
  }
  // And the component says so plainly when there is nothing to report.
  const comp = readFileSync(join(WEB, "../components/dpia-statement.tsx"), "utf8");
  assert.match(comp, /No Data Protection Impact Assessment has been recorded/);
});

test("the DPIA reference round-trips through settings and reaches the public page", async () => {
  const before = await request(server).get("/api/v1/school");
  assert.equal(before.body.dpia_reference, null, "nothing is recorded out of the box");

  const put = await request(server).put("/api/v1/school").set(auth("admin")).send({
    name: "Greenfield Academy", dpo_email: "dpo@greenfield.ng",
    dpia_reference: "NDPC/DPIA/2026/0041", dpia_completed_at: "2026-08-14",
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  // The legal pages read the PUBLIC endpoint — unauthenticated, like a parent.
  const pub = await request(server).get("/api/v1/school");
  assert.equal(pub.body.dpia_reference, "NDPC/DPIA/2026/0041");
  assert.equal(pub.body.dpia_completed_at, "2026-08-14");
});

test("go-live warns while no DPIA is recorded, and stops once one is", async () => {
  const withDpia = byId(await goLiveReadiness(db), "dpia");
  assert.equal(withDpia.status, "pass");
  assert.match(withDpia.detail, /NDPC\/DPIA\/2026\/0041/);

  await request(server).put("/api/v1/school").set(auth("admin")).send({
    name: "Greenfield Academy", dpo_email: "dpo@greenfield.ng", dpia_reference: null,
  });
  const without = byId(await goLiveReadiness(db), "dpia");
  assert.equal(without.status, "warn");
  assert.match(without.detail, /tell parents that none is on file/);
  assert.ok(without.fix);
});

/* ── 3. the consent claim matches what the portal can actually know ──────── */

test("the pages no longer claim consent the portal does not hold", () => {
  const retention = page("legal/retention/page.tsx");
  const privacy = page("legal/privacy/page.tsx");

  assert.ok(!/verified parental consent obtained at enrol/i.test(retention),
    "the portal stores no consent record, so it must not claim verified consent");
  // It states the limitation instead, in both places.
  assert.match(retention, /does not store pupils&apos; dates of birth/);
  assert.match(privacy, /does not record the parental consent/);
  // And is honest that this is an open item rather than a design decision.
  assert.match(retention, /known gap/);

  // The guardian-link mechanism it DOES have is described accurately: a link
  // the school creates and the guardian confirms from their own address.
  assert.match(privacy, /confirmed by the guardian from their own email address/);
});

test("removed features are not still described as live", () => {
  // Web Push was deleted in 0015; the policy still listed push subscriptions
  // as a retained category and push providers as a recipient of personal data.
  for (const p of ["legal/privacy/page.tsx", "legal/retention/page.tsx"]) {
    assert.ok(!/push/i.test(page(p)), `${p} still mentions push`);
  }
});
