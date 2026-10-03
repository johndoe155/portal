/**
 * Paystack: the four things that stood between a parent and paying a school fee.
 *
 *   1. The runbook told the operator to set PAYSTACK_SECRET_KEY. The code read
 *      PAYSTACK_SECRET. An operator who followed the documentation got a 503
 *      on the first fee payment of the term with nothing in the logs to say
 *      why.
 *   2. Initialize sent no callback_url, so a parent who finished paying was
 *      dropped on Paystack's own page with no route back and no confirmation
 *      the school knew — the obvious next move being to pay again.
 *   3. The charge was hardcoded to NGN and the webhook rejected anything else,
 *      even though school_settings.currency has existed since 0007.
 *   4. None of this was on the go-live screen.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHmac, randomUUID } from "node:crypto";

process.env.COOKIE_SECURE = "false";
process.env.WORKER_INPROC = "false";
// Set ONLY the canonical name — the code used to read the other one.
process.env.PAYSTACK_SECRET_KEY = "sk_test_canonical_name";
delete process.env.PAYSTACK_SECRET;

const require = createRequire(import.meta.url);
const { createDb } = require("../dist/db/client.js");
const { runMigrations } = require("../dist/db/migrate.js");
const { seed } = require("../dist/seed.js");
const { createApp } = require("../dist/app.factory.js");
const { totpCode } = require("../dist/crypto/totp.js");
const { withActor, SERVICE } = require("../dist/db/actor.js");
const { issueEnrollToken } = require("../dist/auth/enroll-token.js");
const { goLiveReadiness } = require("../dist/ops/go-live.service.js");
const { config } = require("../dist/config.js");
const { users, feePayments, schoolSettings } = require("../dist/db/schema.js");
const { eq } = require("drizzle-orm");
const request = require("supertest");
const { startMockPaystack } = await import("./mock-paystack.mjs");

let app, server, db, ids, mock;
const jars = {};

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
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll").set(auth(name)).send({ token });
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}
const byId = (r, id) => r.checks.find((c) => c.id === id);
const setCurrency = (c) => withActor(db, SERVICE, (tx) =>
  tx.update(schoolSettings).set({ currency: c }).where(eq(schoolSettings.id, 1)));

before(async () => {
  mock = await startMockPaystack(0);
  process.env.PAYSTACK_API_BASE = `http://127.0.0.1:${mock.address().port}`;
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  ids = await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");
});
after(async () => { await app.close(); mock.close(); });

/* ── 1. the documented env var name actually works ───────────────────────── */

test("PAYSTACK_SECRET_KEY — the name the runbook documents — is the one read", () => {
  assert.equal(config.paystackSecret, "sk_test_canonical_name",
    "an operator who follows the runbook must not get a 503");
});

/* ── 2 & 3. what we put on the wire ──────────────────────────────────────── */

test("Initialize sends the school's currency and a way back to the portal", async () => {
  await setCurrency("GHS");
  const init = await request(server).post(`/api/v1/fees/invoices/${ids.inv}/initiate`).set(auth("admin"));
  assert.equal(init.status, 201, JSON.stringify(init.body));

  const sent = mock.lastInitialize();
  assert.equal(sent.currency, "GHS",
    "the school's configured currency, not a hardcoded NGN");
  assert.ok(sent.callback_url, "without callback_url the payer is stranded on Paystack's page");
  assert.equal(sent.callback_url, `${config.publicWebOrigin}/fees/return`);
  assert.equal(sent.amount, init.body.amount_kobo);
});

test("the currency is recorded on the payment, not re-read later", async () => {
  const [pay] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(feePayments).where(eq(feePayments.status, "pending")).limit(1));
  assert.equal(pay.currency, "GHS");

  // A bursar switching the school currency must not fail payments already in
  // flight — which is exactly what re-reading the setting at webhook time
  // would do.
  await setCurrency("NGN");
  const [again] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(feePayments).where(eq(feePayments.id, pay.id)).limit(1));
  assert.equal(again.currency, "GHS", "the charge is still a GHS charge");
});

test("the webhook validates against the charged currency", async () => {
  const [pay] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(feePayments).where(eq(feePayments.status, "pending")).limit(1));

  const post = async (body) => {
    const raw = JSON.stringify(body);
    return request(server).post("/api/v1/webhooks/paystack")
      .set("x-paystack-signature",
        createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex"))
      .set("content-type", "application/json").send(raw);
  };

  // NGN would have been accepted by the old hardcoded check; this charge is GHS.
  const wrong = await post({
    event: "charge.success",
    data: { reference: pay.gatewayRef, amount: Number(pay.amountKobo), currency: "NGN" },
  });
  assert.equal(wrong.body.reason, "currency_mismatch");

  // And a genuine GHS settlement is accepted, which the old check refused.
  const [fresh] = await withActor(db, SERVICE, (tx) =>
    tx.select().from(feePayments).where(eq(feePayments.id, pay.id)).limit(1));
  assert.equal(fresh.status, "failed", "a mismatch fails the row rather than posting it");

  await setCurrency("GHS");
  const init = await request(server).post(`/api/v1/fees/invoices/${ids.inv}/initiate`).set(auth("admin"));
  const ok = await post({
    event: "charge.success",
    data: { reference: init.body.reference, amount: init.body.amount_kobo, currency: "ghs" },
  });
  assert.ok(!ok.body.rejected, JSON.stringify(ok.body));
  assert.ok(!ok.body.ignored, JSON.stringify(ok.body));
});

/* ── the return page has something to ask ────────────────────────────────── */

test("a payer can ask what happened to their payment, and only their own", async () => {
  // The seed invoice was settled by the test above, so raise a fresh one.
  const inv = await request(server).post("/api/v1/fees/invoices").set(auth("admin"))
    .send({ student_user_id: ids.s1, term_id: ids.term, label: "Bus pass", amount_kobo: 250000 });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const init = await request(server).post(`/api/v1/fees/invoices/${inv.body.id}/initiate`).set(auth("admin"));
  assert.equal(init.status, 201, JSON.stringify(init.body));
  const ref = init.body.reference;

  const mine = await request(server).get(`/api/v1/fees/payments/${ref}/status`).set(auth("admin"));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.reference, ref);
  assert.ok(["pending", "success"].includes(mine.body.status));
  assert.equal(mine.body.currency, "GHS");

  // Somebody else's reference is a 404, not a leak of what another family owes.
  await staffLogin("t1", "t1@school.example");
  const theirs = await request(server).get(`/api/v1/fees/payments/${ref}/status`).set(auth("t1"));
  assert.equal(theirs.status, 404);

  const nonsense = await request(server)
    .get(`/api/v1/fees/payments/psk_${randomUUID()}/status`).set(auth("admin"));
  assert.equal(nonsense.status, 404);
});

/* ── 4. go-live notices all of it ────────────────────────────────────────── */

test("go-live reports the payment configuration honestly", async () => {
  await setCurrency("GHS");
  const r = await goLiveReadiness(db);

  assert.equal(byId(r, "paystack_config").status, "pass");
  // A test key is a warning outside production and a failure inside it.
  assert.equal(byId(r, "paystack_mode").status, "warn");
  assert.match(byId(r, "paystack_mode").detail, /TEST Paystack key/);
  assert.equal(byId(r, "paystack_currency").status, "pass");

  await setCurrency("GBP");
  const gbp = byId(await goLiveReadiness(db), "paystack_currency");
  assert.equal(gbp.status, "fail", "Paystack does not settle GBP — say so before go-live");
  assert.match(gbp.detail, /GBP/);
  await setCurrency("NGN");
});

test("go-live catches a loopback email origin", async () => {
  // The exact failure the worker had: PUBLIC_WEB_ORIGIN unset, so every link
  // in every email pointed at the recipient's own machine.
  const c = byId(await goLiveReadiness(db), "public_origin");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /127\.0\.0\.1:3000/);
  assert.match(c.detail, /worker/i, "points at the service that actually renders the mail");
});
