import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHmac, randomUUID } from "node:crypto";

process.env.COOKIE_SECURE = "false";
process.env.WORKER_INPROC = "false";
process.env.PAYSTACK_SECRET = "sk_test_phase54_secret";

const require = createRequire(import.meta.url);
const { createDb } = require("../dist/db/client.js");
const { runMigrations } = require("../dist/db/migrate.js");
const { seed } = require("../dist/seed.js");
const { createApp } = require("../dist/app.factory.js");
const { totpCode } = require("../dist/crypto/totp.js");
const { withActor, SERVICE } = require("../dist/db/actor.js");
const { issueEnrollToken } = require("../dist/auth/enroll-token.js");
const { users } = require("../dist/db/schema.js");
const { eq, sql } = require("drizzle-orm");
const request = require("supertest");
const { startMockPaystack } = await import("./mock-paystack.mjs");

let app, server, db, ids;
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
function auth(name) { return { Cookie: `sid=${jars[name].sid}; csrf=${jars[name].csrf}`, "x-csrf": jars[name].csrf }; }
async function loginAs(name, email) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password: "Passw0rd!" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  jars[name] = { ...cookiesOf(res) };
}
async function staffLogin(name, email) {
  await loginAs(name, email);
  // controlled enrollment: admin-issued single-use token (direct DB primitive)
  const [u] = await withActor(db, SERVICE, async (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  const token = await issueEnrollToken(db, u.id, null);
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll")
    .set(auth(name)).send({ token });
  assert.equal(enroll.status, 201, JSON.stringify(enroll.body));
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}

/** Paystack signs the raw JSON body with HMAC SHA-512 */
function paystackHeaders(bodyObj) {
  const raw = JSON.stringify(bodyObj);
  const sig = createHmac("sha512", process.env.PAYSTACK_SECRET).update(raw).digest("hex");
  return { raw, sig };
}

let paystackMock;
before(async () => {
  paystackMock = await startMockPaystack(0);          // ephemeral port
  const port = paystackMock.address().port;
  process.env.PAYSTACK_API_BASE = `http://127.0.0.1:${port}`; // read at call time by initiate
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  ids = await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");
  await staffLogin("t1", "t1@school.example");
  await staffLogin("t2", "t2@school.example");
  await loginAs("s1", "s1@school.example");
  await loginAs("p1", "p1@school.example");
});
after(async () => { await app.close(); paystackMock?.close(); });

/* ── fees ── */
test("seed invoice visible to student, guardian, admin; others blocked", async () => {
  for (const who of ["s1", "p1", "admin"]) {
    const path = who === "s1" ? "/api/v1/fees/my"
      : who === "p1" ? `/api/v1/parent/children/${ids.s1}/fees`
      : "/api/v1/fees/invoices";
    const res = await request(server).get(path).set(auth(who));
    assert.equal(res.status, 200, `${who} status ${res.status}`);
    const invoices = who === "admin" ? res.body.data : res.body.data.invoices;
    assert.ok(invoices.some((i) => i.id === ids.inv), `${who} sees seed invoice`);
    assert.equal(invoices.find((i) => i.id === ids.inv).amountKobo, 15000000);
  }
  const teacherBlocked = await request(server).get("/api/v1/fees/invoices").set(auth("t1"));
  assert.equal(teacherBlocked.status, 403);
  assert.equal(teacherBlocked.body.code, "missing_capability");
});

test("admin creates invoice; duplicate refused; parent read-only", async () => {
  const created = await request(server).post("/api/v1/fees/invoices").set(auth("admin"))
    .send({ student_user_id: ids.s1, term_id: ids.term, label: "PTA Levy", amount_kobo: 500000, due_date: "2026-11-15" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dupe = await request(server).post("/api/v1/fees/invoices").set(auth("admin"))
    .send({ student_user_id: ids.s1, term_id: ids.term, label: "PTA Levy", amount_kobo: 500000 });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, "invoice_exists");
  const parentWrite = await request(server).post("/api/v1/fees/invoices").set(auth("p1"))
    .send({ student_user_id: ids.s1, term_id: ids.term, label: "X", amount_kobo: 1 });
  assert.equal(parentWrite.status, 403);
  assert.equal(parentWrite.body.code, "parent_read_only");
});

test("paystack webhook: unsigned rejected, signed applies payment, replay idempotent", async () => {
  const init = await request(server).post(`/api/v1/fees/invoices/${ids.inv}/initiate`).set(auth("admin"));
  assert.equal(init.status, 201, JSON.stringify(init.body));
  const reference = init.body.reference;
  // real Initialize call (against the mock): checkout URL + access code returned
  assert.ok(init.body.checkout_url?.startsWith("https://checkout.mock-paystack.test/pay/"),
    `expected checkout_url, got ${JSON.stringify(init.body)}`);
  assert.ok(init.body.access_code, "access_code returned");
  assert.equal(init.body.amount_kobo, 15000000);

  // unsigned → 401
  const unsigned = await request(server).post("/api/v1/webhooks/paystack")
    .set("content-type", "application/json")
    .send(JSON.stringify({ event: "charge.success", data: { reference, amount: 15000000, currency: "NGN" } }));
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.code, "webhook_unverified");

  // tampered signature → 401
  const { raw } = paystackHeaders({ event: "charge.success", data: { reference, amount: 15000000, currency: "NGN" } });
  const tampered = await request(server).post("/api/v1/webhooks/paystack")
    .set("content-type", "application/json").set("x-paystack-signature", "deadbeef".repeat(16))
    .send(raw);
  assert.equal(tampered.status, 401);

  // review-3 #7 + review-4 #2: repeated initiate while pending REUSES the
  // same reference AND returns the STORED checkout — Paystack is NOT called
  // again (the real gateway rejects duplicate-reference initialize calls)
  const init2 = await request(server).post(`/api/v1/fees/invoices/${ids.inv}/initiate`).set(auth("admin"));
  assert.equal(init2.status, 201);
  assert.equal(init2.body.reference, reference, "repeated initiate reuses the pending reference");
  assert.equal(init2.body.checkout_url, init.body.checkout_url, "stored checkout returned, no re-initialize");
  assert.equal(init2.body.access_code, init.body.access_code);

  // review-3 #7: correctly signed but WRONG AMOUNT → rejected, row failed,
  // invoice untouched (the payload is untrusted even with a valid signature)
  const badAmt = { event: "charge.success", data: { reference, amount: 1, currency: "NGN" } };
  const badAmtH = paystackHeaders(badAmt);
  const badAmtRes = await request(server).post("/api/v1/webhooks/paystack")
    .set("content-type", "application/json").set("x-paystack-signature", badAmtH.sig)
    .send(badAmtH.raw);
  assert.equal(badAmtRes.status, 201);
  assert.equal(badAmtRes.body.rejected, true);
  assert.equal(badAmtRes.body.reason, "amount_mismatch");

  // review-3 #7: wrong currency → rejected too
  const badCur = { event: "charge.success", data: { reference, amount: 15000000, currency: "USD" } };
  const badCurH = paystackHeaders(badCur);
  const badCurRes = await request(server).post("/api/v1/webhooks/paystack")
    .set("content-type", "application/json").set("x-paystack-signature", badCurH.sig)
    .send(badCurH.raw);
  assert.equal(badCurRes.body.rejected, true);
  assert.equal(badCurRes.body.reason, "currency_mismatch");

  // invoice still unpaid after the rejected events; a fresh initiate is
  // possible because the failed row no longer blocks (status != pending)
  const init3 = await request(server).post(`/api/v1/fees/invoices/${ids.inv}/initiate`).set(auth("admin"));
  assert.equal(init3.status, 201);
  assert.notEqual(init3.body.reference, reference, "failed rows don't get reused; a new reference is issued");

  // correctly signed + exact amount → applied
  const evt = { event: "charge.success", data: { reference: init3.body.reference, amount: 15000000, currency: "NGN" } };
  const { raw: okRaw, sig } = paystackHeaders(evt);
  const ok = await request(server).post("/api/v1/webhooks/paystack")
    .set("content-type", "application/json").set("x-paystack-signature", sig)
    .send(okRaw);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.applied, true);

  // replay → duplicate, no double-credit
  const replay = await request(server).post("/api/v1/webhooks/paystack")
    .set("content-type", "application/json").set("x-paystack-signature", sig)
    .send(okRaw);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.duplicate, true);

  // invoice now paid
  const mine = await request(server).get("/api/v1/fees/my").set(auth("s1"));
  const inv = mine.body.data.invoices.find((i) => i.id === ids.inv);
  assert.equal(inv.status, "paid");
  const payments = mine.body.data.payments.filter((x) => x.invoiceId === ids.inv);
  assert.equal(payments.filter((x) => x.status === "success").length, 1, "single successful payment after replay");
});

test("partial cash payment → invoice partial; completing → paid", async () => {
  const inv2 = await request(server).post("/api/v1/fees/invoices").set(auth("admin"))
    .send({ student_user_id: ids.s1, term_id: ids.term, label: "Lab Fee", amount_kobo: 2000000 });
  assert.equal(inv2.status, 201);
  const id2 = inv2.body.id;
  const half = await request(server).post(`/api/v1/fees/invoices/${id2}/payments`).set(auth("admin"))
    .send({ amount_kobo: 1200000, channel: "cash" });
  assert.equal(half.status, 201);
  let check = await request(server).get("/api/v1/fees/invoices").set(auth("admin"));
  assert.equal(check.body.data.find((i) => i.id === id2).status, "partial");
  await request(server).post(`/api/v1/fees/invoices/${id2}/payments`).set(auth("admin"))
    .send({ amount_kobo: 800000, channel: "transfer" });
  check = await request(server).get("/api/v1/fees/invoices").set(auth("admin"));
  assert.equal(check.body.data.find((i) => i.id === id2).status, "paid");
  const overpay = await request(server).post(`/api/v1/fees/invoices/${id2}/payments`).set(auth("admin"))
    .send({ amount_kobo: 100, channel: "cash" });
  assert.equal(overpay.status, 409);
  assert.equal(overpay.body.code, "invoice_not_payable");
});

test("review-4 #3: online initiate charges the REMAINING balance after a partial payment", async () => {
  const inv = await request(server).post("/api/v1/fees/invoices").set(auth("admin"))
    .send({ student_user_id: ids.s1, term_id: ids.term, label: `Balance ${Date.now()}`, amount_kobo: 5000000 });
  assert.equal(inv.status, 201);
  const id = inv.body.id;
  // 2M paid offline → 3M remains
  const part = await request(server).post(`/api/v1/fees/invoices/${id}/payments`).set(auth("admin"))
    .send({ amount_kobo: 2000000, channel: "cash" });
  assert.equal(part.status, 201);

  const init = await request(server).post(`/api/v1/fees/invoices/${id}/initiate`).set(auth("admin"));
  assert.equal(init.status, 201, JSON.stringify(init.body));
  assert.equal(init.body.amount_kobo, 3000000, "charges the remaining balance, not the invoice total");

  // webhook for the remaining amount completes the invoice
  const evt = { event: "charge.success", data: { reference: init.body.reference, amount: 3000000, currency: "NGN" } };
  const { raw, sig } = paystackHeaders(evt);
  const wh = await request(server).post("/api/v1/webhooks/paystack")
    .set("content-type", "application/json").set("x-paystack-signature", sig).send(raw);
  assert.equal(wh.body.applied, true, JSON.stringify(wh.body));
  const ledger = await request(server).get("/api/v1/fees/my").set(auth("s1"));
  assert.equal(ledger.body.data.invoices.find((i) => i.id === id).status, "paid");

  // a webhook claiming the FULL original amount is rejected (mismatch)
  const init2 = await request(server).post(`/api/v1/fees/invoices/${id}/initiate`).set(auth("admin"));
  assert.equal(init2.status, 409, "paid invoice is not payable");
  assert.equal(init2.body.code, "invoice_not_payable");
});

test("review-5 #4: a STALE stored checkout is refreshed, not served again", async () => {
  const inv = await request(server).post("/api/v1/fees/invoices").set(auth("admin"))
    .send({ student_user_id: ids.s1, term_id: ids.term, label: `Stale ${Date.now()}`, amount_kobo: 900000 });
  assert.equal(inv.status, 201);
  const id = inv.body.id;

  const init1 = await request(server).post(`/api/v1/fees/invoices/${id}/initiate`).set(auth("admin"));
  assert.equal(init1.status, 201, JSON.stringify(init1.body));
  assert.ok(init1.body.checkout_url, "checkout stored on first initiate");
  const ref1 = init1.body.reference;

  // within the TTL the stored checkout is reused verbatim
  const again = await request(server).post(`/api/v1/fees/invoices/${id}/initiate`).set(auth("admin"));
  assert.equal(again.body.reference, ref1, "fresh checkout reused");

  // age the pending row past PAYSTACK_CHECKOUT_TTL_MS (default 30 min)
  await db.execute(sql`UPDATE fee_payments SET created_at = now() - interval '2 hours'
    WHERE gateway_ref = ${ref1}`);

  // stale → a NEW reference + a fresh Initialize (never re-init the old ref)
  const init2 = await request(server).post(`/api/v1/fees/invoices/${id}/initiate`).set(auth("admin"));
  assert.equal(init2.status, 201, JSON.stringify(init2.body));
  assert.notEqual(init2.body.reference, ref1, "stale checkout refreshed with a new reference");
  assert.ok(init2.body.checkout_url, "new checkout stored");

  // the refreshed checkout is stable again
  const init3 = await request(server).post(`/api/v1/fees/invoices/${id}/initiate`).set(auth("admin"));
  assert.equal(init3.body.reference, init2.body.reference);
});

/* ── exams ── */
test("teacher schedules exam for own section only; family reads schedule", async () => {
  const ok = await request(server).post(`/api/v1/sections/${ids.sec1}/exams`).set(auth("t1"))
    .send({ title: "Mid-term Test", exam_date: "2026-11-20", max_score: "50", weight_pct: "20" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const outsider = await request(server).post(`/api/v1/sections/${ids.sec1}/exams`).set(auth("t2"))
    .send({ title: "X", exam_date: "2026-11-21" });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.code, "outside_section_scope");

  const studentExams = await request(server).get("/api/v1/student/exams").set(auth("s1"));
  assert.equal(studentExams.status, 200);
  assert.ok(studentExams.body.data.some((e) => e.title === "First Term Examination"));
  assert.ok(studentExams.body.data.some((e) => e.title === "Mid-term Test"));

  const parentExams = await request(server).get(`/api/v1/parent/children/${ids.s1}/exams`).set(auth("p1"));
  assert.equal(parentExams.status, 200);
  assert.ok(parentExams.body.data.some((e) => e.title === "Mid-term Test"));
});

test("exam result flows through gradebook with source_type=exam + source_id", async () => {
  const grade = await request(server).post(`/api/v1/sections/${ids.sec1}/grades/bulk`).set(auth("t1"))
    .set("idempotency-key", randomUUID())
    .send({ items: [{ student_user_id: ids.s1, source_type: "exam", source_id: ids.exam,
      label: "First Term Examination", points: "78", max_points: "100" }] });
  assert.equal(grade.status, 201, JSON.stringify(grade.body));
  await request(server).post(`/api/v1/sections/${ids.sec1}/grades/release`).set(auth("t1"));
  const mine = await request(server).get("/api/v1/student/grades").set(auth("s1"));
  const examGrade = mine.body.data.find((g) => g.sourceType === "exam" && g.sourceId === ids.exam);
  assert.ok(examGrade, "exam grade visible after release");
  assert.equal(Number(examGrade.points), 78); // numeric(6,2) → "78.00"
});

/* ── transport ── */
test("routes readable by family; student sees own assignment", async () => {
  const routes = await request(server).get("/api/v1/transport/routes").set(auth("p1"));
  assert.equal(routes.status, 200);
  assert.ok(routes.body.data.routes.some((r) => r.id === ids.route));
  const mine = await request(server).get("/api/v1/student/transport").set(auth("s1"));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.route.name, "Route A — GRA Phase 2");
  assert.equal(mine.body.data.stop.name, "Abuloma Junction");
});

test("admin assigns transport; duplicate refused; teacher lacks capability", async () => {
  const denied = await request(server).post("/api/v1/transport/routes").set(auth("t1"))
    .send({ name: "Route B" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "missing_capability");

  const routeB = await request(server).post("/api/v1/transport/routes").set(auth("admin"))
    .send({ name: "Route B — Rumuokoro", driver_name: "Ife O.", capacity: 22 });
  assert.equal(routeB.status, 201, JSON.stringify(routeB.body));
  const stopB = await request(server).post(`/api/v1/transport/routes/${routeB.body.id}/stops`).set(auth("admin"))
    .send({ name: "Rumuokoro Roundabout", pickup_time: "06:55", seq: 1 });
  assert.equal(stopB.status, 201);

  // s1 already assigned (seed) → conflict
  const dupe = await request(server).post("/api/v1/transport/assignments").set(auth("admin"))
    .send({ student_user_id: ids.s1, route_id: routeB.body.id, stop_id: stopB.body.id, term_id: ids.term });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, "already_assigned");

  // end current assignment, reassign to Route B
  const mine = await request(server).get("/api/v1/student/transport").set(auth("s1"));
  const end = await request(server)
    .delete(`/api/v1/transport/assignments/${mine.body.data.assignment.id}`).set(auth("admin"));
  assert.equal(end.status, 200);
  const moved = await request(server).post("/api/v1/transport/assignments").set(auth("admin"))
    .send({ student_user_id: ids.s1, route_id: routeB.body.id, stop_id: stopB.body.id, term_id: ids.term });
  assert.equal(moved.status, 201);
  const after = await request(server).get(`/api/v1/parent/children/${ids.s1}/transport`).set(auth("p1"));
  assert.equal(after.body.data.route.name, "Route B — Rumuokoro");
});
