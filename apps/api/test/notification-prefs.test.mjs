/**
 * Notification preferences and one-click unsubscribe.
 *
 * Every bulk email the portal sends has always carried
 *
 *     List-Unsubscribe: <ORIGIN/account/notifications>
 *
 * and that page did not exist. A parent who clicked "unsubscribe" in Gmail
 * got a 404 and kept receiving absence alerts. That is not only rude, it is
 * the single signal Gmail and Yahoo use to decide whether a bulk sender is
 * legitimate.
 *
 * These tests pin the three things that make the header true: a real
 * preference, enqueue-time suppression, and an RFC 8058 endpoint a mail
 * client can POST to with no session at all.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

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
const { enqueue, enqueueAbsence } = require("../dist/notify/notify.service.js");
const {
  OPTIONAL_KINDS, unsubscribeToken, verifyUnsubscribeToken, wantsKind, isOptional,
} = require("../dist/notify/preferences.js");
const { renderEmail } = require("../dist/notify/templates/index.js");
const { users, notifications, guardians } = require("../dist/db/schema.js");
const { and, eq } = require("drizzle-orm");
const request = require("supertest");

let app, server, db;
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

async function uidOf(email) {
  const [u] = await withActor(db, SERVICE, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  return u.id;
}
async function login(name, email) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password: "Passw0rd!" });
  jars[name] = cookiesOf(res);
  return res;
}
async function staffLogin(name, email) {
  await login(name, email);
  const token = await issueEnrollToken(db, await uidOf(email), null);
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll").set(auth(name)).send({ token });
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}
const countFor = (userId, kind) => withActor(db, SERVICE, async (tx) => {
  const rows = await tx.select({ id: notifications.id }).from(notifications)
    .where(and(eq(notifications.recipientUserId, userId), eq(notifications.kind, kind)));
  return rows.length;
});

const brand = {
  schoolName: "Greenfield Academy", logoUrl: null, primaryColor: "#1d4ed8",
  contactEmail: "office@greenfield.ng", dpoEmail: "dpo@greenfield.ng",
  webOrigin: "https://portal.greenfield.ng",
};

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");
  await login("parent", "p1@school.example");
});
after(async () => { await app.close(); });

/* ── the header itself ───────────────────────────────────────────────────── */

test("bulk mail advertises a one-click unsubscribe, security mail does not", () => {
  const unsub = {
    oneClickUrl: "https://portal.greenfield.ng/api/v1/notifications/unsubscribe?t=abc",
    managePrefsUrl: "https://portal.greenfield.ng/account/notifications",
  };
  const absence = renderEmail("absence_recorded", { date: "2026-10-02" },
    { brand, recipientName: "Mrs Okoye", timezone: "Africa/Lagos", unsub });

  assert.match(absence.headers["List-Unsubscribe"], /<https:\/\/portal\.greenfield\.ng\/api\/v1\/notifications\/unsubscribe\?t=abc>/);
  assert.equal(absence.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(absence.headers["List-Unsubscribe"], /mailto:office@greenfield\.ng/,
    "a mailto: fallback for clients that do not do one-click");

  // ...and a link a human can see, because the header is invisible outside
  // Gmail and Apple Mail.
  assert.match(absence.text, /Change which emails you receive/);
  assert.match(absence.html, /account\/notifications/);

  const reset = renderEmail("password_reset", { url: "https://portal.greenfield.ng/reset?t=x" },
    { brand, recipientName: "Mrs Okoye", timezone: "Africa/Lagos" });
  assert.equal(reset.headers["List-Unsubscribe"], undefined,
    "you cannot unsubscribe from being told your password was reset");
});

test("the advertised URL is no longer a 404", async () => {
  // This is the whole bug in one assertion: the path the header points at
  // has to exist and has to be the preferences page.
  const res = await request(server).get("/api/v1/account/notifications").set(auth("parent"));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.length, OPTIONAL_KINDS.length);
  for (const p of res.body.data) {
    assert.equal(p.enabled, true, "absent preference means subscribed");
    assert.ok(p.label && p.detail.length > 10, `${p.kind} explains itself in plain words`);
  }
  assert.match(res.body.note, /always sent/i);
});

/* ── the preference actually changes behaviour ───────────────────────────── */

test("switching a category off stops it being queued at all", async () => {
  const guardianId = await uidOf("p1@school.example");
  const studentId = await uidOf("s1@school.example");
  await withActor(db, SERVICE, (tx) => tx.insert(guardians).values({
    userId: guardianId, studentUserId: studentId,
    relationship: "mother", verifiedAt: new Date(),
  }).onConflictDoNothing());

  const base = await countFor(guardianId, "absence_recorded");
  await withActor(db, SERVICE, (tx) => enqueueAbsence(tx, studentId, "2026-10-02", null));
  assert.equal(await countFor(guardianId, "absence_recorded"), base + 1, "subscribed by default");

  const off = await request(server).put("/api/v1/account/notifications")
    .set(auth("parent")).send({ absence_recorded: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.data.find((p) => p.kind === "absence_recorded").enabled, false);

  await withActor(db, SERVICE, (tx) => enqueueAbsence(tx, studentId, "2026-10-03", null));
  assert.equal(await countFor(guardianId, "absence_recorded"), base + 1,
    "suppressed at enqueue time — no outbox row to clutter the dead-letter screen");

  // Other categories are untouched: this is a per-category opt-out, not a mute-all.
  const back = await request(server).get("/api/v1/account/notifications").set(auth("parent"));
  assert.equal(back.body.data.find((p) => p.kind === "daily_digest").enabled, true);
});

test("security mail ignores preferences entirely", async () => {
  const guardianId = await uidOf("p1@school.example");
  // Even with everything switched off...
  await request(server).put("/api/v1/account/notifications").set(auth("parent")).send({
    absence_recorded: false, grade_released: false, message_received: false, daily_digest: false,
  });
  const before = await countFor(guardianId, "password_reset");
  await withActor(db, SERVICE, (tx) => enqueue(tx, {
    recipientUserId: guardianId, channel: "email", kind: "password_reset",
    payload: { url: "https://portal.greenfield.ng/reset?t=x" },
  }));
  assert.equal(await countFor(guardianId, "password_reset"), before + 1);
  assert.equal(isOptional("password_reset"), false);
});

/* ── RFC 8058 one-click ──────────────────────────────────────────────────── */

test("a mail client can unsubscribe by POST with no session and no CSRF token", async () => {
  const studentId = await uidOf("s1@school.example");
  assert.equal(wantsKind({}, "grade_released"), true);

  // No cookies, no x-csrf header — exactly what Gmail sends.
  const res = await request(server)
    .post(`/api/v1/notifications/unsubscribe?t=${encodeURIComponent(unsubscribeToken(studentId, "grade_released"))}`);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.unsubscribed, true);
  assert.equal(res.body.kind, "grade_released");

  const [row] = await withActor(db, SERVICE, (tx) =>
    tx.select({ p: users.notificationPrefs }).from(users).where(eq(users.id, studentId)).limit(1));
  assert.equal(row.p.grade_released, false);
});

test("the token is signed, scoped, and unforgeable", async () => {
  const a = await uidOf("s1@school.example");
  const b = await uidOf("p1@school.example");

  assert.deepEqual(verifyUnsubscribeToken(unsubscribeToken(a, "daily_digest")),
    { userId: a, kind: "daily_digest" });

  // Swapping the user id invalidates the MAC — you cannot unsubscribe someone else.
  const stolen = unsubscribeToken(a, "daily_digest").replace(a, b);
  assert.equal(verifyUnsubscribeToken(stolen), null);
  // Nor can you widen the scope to another category.
  assert.equal(verifyUnsubscribeToken(unsubscribeToken(a, "daily_digest")
    .replace("daily_digest", "message_received")), null);
  // Garbage, and kinds that are not opt-outable, are rejected.
  assert.equal(verifyUnsubscribeToken("nonsense"), null);
  assert.equal(verifyUnsubscribeToken(unsubscribeToken(a, "password_reset")), null);
});

test("a bad unsubscribe token answers 2xx rather than erroring", async () => {
  // A 4xx here makes a mail provider mark our unsubscribe as broken, which is
  // the reputation hit we are trying to avoid in the first place.
  const res = await request(server).post("/api/v1/notifications/unsubscribe?t=rubbish");
  assert.equal(res.status, 201);
  assert.equal(res.body.unsubscribed, false);
});

test("GET works too, for clients and scanners that follow the link", async () => {
  const id = await uidOf("t2@school.example");
  const res = await request(server)
    .get(`/api/v1/notifications/unsubscribe?t=${encodeURIComponent(unsubscribeToken(id, "message_received"))}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.unsubscribed, true);
});
