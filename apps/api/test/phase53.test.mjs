import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── env BEFORE config module loads (config reads process.env at import) ──
process.env.COOKIE_SECURE = "false";
process.env.WORKER_INPROC = "false";           // tests drive the worker manually
process.env.PUBLIC_WEB_ORIGIN = "http://127.0.0.1:3000";
const IDP = 9310;
for (const name of ["ENTRA", "GOOGLE"]) {
  process.env[`SSO_${name}_ISSUER`] = `http://127.0.0.1:${IDP}`;
  process.env[`SSO_${name}_AUTH_URL`] = `http://127.0.0.1:${IDP}/authorize`;
  process.env[`SSO_${name}_TOKEN_URL`] = `http://127.0.0.1:${IDP}/token`;
  process.env[`SSO_${name}_CLIENT_ID`] = `${name.toLowerCase()}-client`;
  process.env[`SSO_${name}_CLIENT_SECRET`] = "mock-secret-value";
  process.env[`SSO_${name}_HMAC_SECRET`] = "mock-secret";
}
process.env.SSO_ENTRA_JIT_ROLE = "student";     // entra (mock IdP): JIT provisioning ON
// review-2: Entra id_tokens never carry email_verified — production Entra
// config must set this; Google keeps the default (required).
process.env.SSO_ENTRA_REQUIRE_EMAIL_VERIFIED = "false";
// GOOGLE: no JIT role → unprovisioned identities are refused

const require = createRequire(import.meta.url);
const { createDb } = require("../dist/db/client.js");
const { runMigrations } = require("../dist/db/migrate.js");
const { seed } = require("../dist/seed.js");
const { createApp } = require("../dist/app.factory.js");
const { totpCode } = require("../dist/crypto/totp.js");
const { withActor, SERVICE } = require("../dist/db/actor.js");
const { issueEnrollToken } = require("../dist/auth/enroll-token.js");
const { processQueue, runDigest } = require("../dist/notify/notify.service.js");
const { notifications, users } = require("../dist/db/schema.js");
const { eq } = require("drizzle-orm");
const request = require("supertest");
const { startMockIdp } = await import("./mock-idp.mjs");

let app, server, db, ids, idp;
const jars = {};
const tmp = mkdtempSync(join(tmpdir(), "portal53-"));
const PUSH_SINK = join(tmp, "push-outbox.jsonl");

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
async function loginAs(name, email, password = "Passw0rd!") {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  jars[name] = { ...cookiesOf(res) };
}
async function staffLogin(name, email, password = "Passw0rd!") {
  await loginAs(name, email, password);
  // controlled enrollment: admin-issued single-use token (direct DB primitive,
  // same path as scripts/mfa-token.mjs and POST /users/:id/mfa-enroll-token)
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

before(async () => {
  idp = await startMockIdp(IDP);
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  ids = await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("t1", "t1@school.example");
  await staffLogin("t2", "t2@school.example");
  await staffLogin("admin", "admin@school.example");
  await staffLogin("root", "root@school.example");
  await loginAs("s1", "s1@school.example");
  await loginAs("p1", "p1@school.example");
});
after(async () => { await app.close(); idp.close(); });

/* ── messaging ── */
let threadId;
test("teacher opens thread for own student; other teacher refused", async () => {
  const ok = await request(server).post("/api/v1/threads").set(auth("t1"))
    .send({ student_user_id: ids.s1, subject: "Sola's progress" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  threadId = ok.body.id;
  const denied = await request(server).post("/api/v1/threads").set(auth("t2"))
    .send({ student_user_id: ids.s1, subject: "hi" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "outside_section_scope");
});

test("parent reads thread/messages; writes refused; student sees nothing", async () => {
  const post = await request(server).post(`/api/v1/threads/${threadId}/messages`).set(auth("t1"))
    .send({ body_text: "Sola did great this week." });
  assert.equal(post.status, 201, JSON.stringify(post.body));

  const list = await request(server).get("/api/v1/threads").set(auth("p1"));
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].studentName, "Sola Student");

  const detail = await request(server).get(`/api/v1/threads/${threadId}`).set(auth("p1"));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.messages.length, 1);

  const parentWrite = await request(server).post(`/api/v1/threads/${threadId}/messages`).set(auth("p1"))
    .send({ body_text: "thanks!" });
  assert.equal(parentWrite.status, 403);
  assert.equal(parentWrite.body.code, "parent_read_only");

  const studentView = await request(server).get("/api/v1/threads").set(auth("s1"));
  assert.equal(studentView.status, 200);
  assert.equal(studentView.body.data.length, 0);

  const outsider = await request(server).get(`/api/v1/threads/${threadId}`).set(auth("t2"));
  assert.equal(outsider.status, 404); // RLS-invisible ⇒ not found
});

test("teacher message enqueues guardian notification", async () => {
  const inbox = await request(server).get("/api/v1/notifications").set(auth("p1"));
  assert.equal(inbox.status, 200);
  assert.ok(inbox.body.data.some((n) => n.kind === "message_received"), JSON.stringify(inbox.body.data.map((n) => n.kind)));
});

/* ── notification hooks ── */
const date = new Date().toISOString().slice(0, 10);
test("absence transition enqueues guardian email+push", async () => {
  const save = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`).set(auth("t1"))
    .set("idempotency-key", crypto.randomUUID())
    .send({ date, records: [{ student_user_id: ids.s1, status: "absent" }] });
  assert.equal(save.status, 201, JSON.stringify(save.body));
  const inbox = await request(server).get("/api/v1/notifications").set(auth("p1"));
  const alerts = inbox.body.data.filter((n) => n.kind === "absence_recorded");
  assert.equal(alerts.length, 2); // email + push
  assert.deepEqual(alerts.map((a) => a.channel).sort(), ["email", "push"]);
});

test("re-saving same absence does NOT re-alert; grade release notifies student+parent", async () => {
  const again = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`).set(auth("t1"))
    .set("idempotency-key", crypto.randomUUID())
    .send({ date, records: [{ student_user_id: ids.s1, status: "absent" }] });
  assert.equal(again.status, 201);
  const inbox = await request(server).get("/api/v1/notifications").set(auth("p1"));
  assert.equal(inbox.body.data.filter((n) => n.kind === "absence_recorded").length, 2, "no duplicate alert");

  const grade = await request(server).post(`/api/v1/sections/${ids.sec1}/grades/bulk`).set(auth("t1"))
    .set("idempotency-key", crypto.randomUUID())
    .send({ items: [{ student_user_id: ids.s1, source_type: "custom", label: "5.3 Quiz", points: "90", max_points: "100" }] });
  assert.equal(grade.status, 201);
  const rel = await request(server).post(`/api/v1/sections/${ids.sec1}/grades/release`).set(auth("t1"));
  assert.equal(rel.status, 201);
  for (const who of ["s1", "p1"]) {
    const n = await request(server).get("/api/v1/notifications").set(auth(who));
    assert.ok(n.body.data.some((x) => x.kind === "grade_released"), `${who} got grade_released`);
  }
});

test("review-3 #4: FAILED bulk save releases its idempotency key (retry works)", async () => {
  const key = crypto.randomUUID();
  // first attempt fails inside the handler (student not enrolled in section)
  const bad = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`).set(auth("t1"))
    .set("idempotency-key", key)
    .send({ date, records: [{ student_user_id: crypto.randomUUID(), status: "present" }] });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.equal(bad.body.code, "not_enrolled");
  // retry with the SAME key and a valid body must execute — pre-fix this was
  // a 409 idempotency_in_progress for 24 h (stranded processing row)
  const retry = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`).set(auth("t1"))
    .set("idempotency-key", key)
    .send({ date, records: [{ student_user_id: ids.s1, status: "present" }] });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  // and once complete, the key replays instead of re-executing
  const replay = await request(server).post(`/api/v1/sections/${ids.sec1}/attendance`).set(auth("t1"))
    .set("idempotency-key", key)
    .send({ date, records: [{ student_user_id: ids.s1, status: "absent" }] });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, retry.body, "completed key replays the stored response");
});

/* ── worker ── */
test("worker drains outbox: emails delivered, push sinks, failures recorded", async () => {
  // give s1 a push subscription + a push notification to exercise the sink
  await request(server).post("/api/v1/notifications/push").set(auth("s1"))
    .send({ endpoint: "https://push.example/abc", keys: { p256dh: "pk", auth: "ak" } });
  await withActor(db, SERVICE, (tx) => tx.insert(notifications).values({
    recipientUserId: ids.s1, channel: "push", kind: "absence_recorded", payload: { test: true },
  }));

  const sentMails = [];
  const mailer = { sendMail: async (opts) => { sentMails.push(opts); return {}; } };
  const r1 = await processQueue(db, { mailer, pushSinkFile: PUSH_SINK });
  assert.ok(r1.processed >= 5, `processed ${r1.processed}`);
  assert.ok(sentMails.length >= 4, `emails ${sentMails.length}`);
  assert.ok(sentMails.some((m) => /Absence recorded/.test(m.subject)));
  assert.ok(existsSync(PUSH_SINK), "push sink file written");
  assert.match(readFileSync(PUSH_SINK, "utf8"), /push\.example/);

  // p1's push row fails honestly (no subscription) and is marked failed
  const failed = await withActor(db, SERVICE, (tx) =>
    tx.select().from(notifications).where(eq(notifications.status, "failed")));
  assert.ok(failed.length >= 1 && failed.every((f) => /no push subscription/.test(f.lastError)));

  const r2 = await processQueue(db, { mailer, pushSinkFile: PUSH_SINK });
  assert.equal(r2.processed, 0, "queue empty after drain");
});

test("daily digest: one per recipient per day, idempotent", async () => {
  const first = await runDigest(db);
  assert.ok(first.created >= 2, `created ${first.created}`); // p1 + s1 had events today
  const second = await runDigest(db);
  assert.equal(second.created, 0, "idempotent per day");
  const inbox = await request(server).get("/api/v1/notifications").set(auth("p1"));
  const digest = inbox.body.data.find((n) => n.kind === "daily_digest");
  assert.ok(digest && digest.payload.date === date, "digest payload dated today");
  assert.ok(digest.payload.absences >= 1 && digest.payload.gradesReleased >= 1);
});

/* ── report cards ── */
test("report cards: term REQUIRED, generate (admin), read (self/guardian), denied (others)", async () => {
  // review-6 #1: no more silent "first term in the table" fallback
  const noTerm = await request(server).post("/api/v1/report-cards/generate").set(auth("root")).send({});
  assert.equal(noTerm.status, 403);
  assert.equal(noTerm.body.code, "validation");
  const gen = await request(server).post("/api/v1/report-cards/generate").set(auth("root"))
    .send({ term_id: ids.term });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.ok(gen.body.generated >= 1);

  const mine = await request(server).get(`/api/v1/students/${ids.s1}/report-card`).set(auth("s1"));
  assert.equal(mine.status, 200);
  const snap = mine.body.data[0].snapshot;
  assert.ok(snap.sections.some((s) => s.course === "MTH-101"), "MTH-101 in snapshot");

  const parent = await request(server).get(`/api/v1/students/${ids.s1}/report-card`).set(auth("p1"));
  assert.equal(parent.status, 200);

  const teacher = await request(server).get(`/api/v1/students/${ids.s1}/report-card`).set(auth("t2"));
  assert.equal(teacher.status, 403);
});

/* ── directory writes ── */
test("admin creates user; duplicate email refused; new user can log in", async () => {
  const created = await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email: "new.kid@school.example", display_name: "New Kid", password: "Passw0rd!Policy1", roles: ["student"], grade_level: 10 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dupe = await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email: "NEW.kid@school.example", display_name: "X", password: "Passw0rd!Policy1", roles: ["student"], grade_level: 10 });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, "email_taken");
  const newkidLogin = await request(server).post("/api/v1/auth/login")
    .send({ email: "new.kid@school.example", password: "Passw0rd!Policy1" });
  assert.equal(newkidLogin.status, 201, JSON.stringify(newkidLogin.body));
  jars["newkid"] = { ...cookiesOf(newkidLogin) };
  const sess = await request(server).get("/api/v1/auth/session").set(auth("newkid"));
  assert.deepEqual(sess.body.roles, ["student"]);
});

test("review-3 #6: invite accept-link is withheld from admins when SMTP is configured", async () => {
  const email = `invited.${Date.now()}@school.example`;
  // dev mode (no SMTP): the link must be returned — it's the only channel
  const dev = await request(server).post("/api/v1/invites").set(auth("admin"))
    .send({ email, display_name: "Invited One", roles: ["student"], grade_level: 10 });
  assert.equal(dev.status, 201, JSON.stringify(dev.body));
  assert.ok(dev.body.acceptUrl && dev.body.inviteToken, "dev sink exposes the link");

  // SMTP configured: response carries NO token — the admin must not be able
  // to accept their own invite and set the invitee's password
  process.env.SMTP_URL = "smtps://unused@example.invalid:465";
  try {
    const email2 = `invited2.${Date.now()}@school.example`;
    const prod = await request(server).post("/api/v1/invites").set(auth("admin"))
      .send({ email: email2, display_name: "Invited Two", roles: ["student"], grade_level: 10 });
    assert.equal(prod.status, 201, JSON.stringify(prod.body));
    assert.equal(prod.body.delivery, "email");
    assert.equal(prod.body.inviteToken, undefined, "no token in response when SMTP is live");
    assert.equal(prod.body.acceptUrl, undefined, "no accept URL in response when SMTP is live");
  } finally {
    delete process.env.SMTP_URL;
  }
});

test("review-4 #5: invites can be listed, resent (token rotates) and revoked", async () => {
  const email = `stuck.${Date.now()}@school.example`;
  const made = await request(server).post("/api/v1/invites").set(auth("admin"))
    .send({ email, display_name: "Stuck Invitee", roles: ["student"], grade_level: 10 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const inviteId = made.body.inviteId ?? null;

  // list shows it
  const list = await request(server).get("/api/v1/invites").set(auth("admin"));
  assert.equal(list.status, 200);
  const row = list.body.data.find((r) => r.email === email);
  assert.ok(row, "pending invite listed");
  const id = inviteId ?? row.id;

  // re-inviting the same email is refused (the stuck state the review cites)
  const dupe = await request(server).post("/api/v1/invites").set(auth("admin"))
    .send({ email, display_name: "Stuck Invitee", roles: ["student"], grade_level: 10 });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, "invite_exists");

  // resend rotates the token — the OLD link must stop working
  const resent = await request(server).post(`/api/v1/invites/${id}/resend`).set(auth("admin"));
  assert.equal(resent.status, 201, JSON.stringify(resent.body));
  assert.ok(resent.body.acceptUrl && resent.body.inviteToken, "dev sink exposes rotated link");
  assert.notEqual(resent.body.inviteToken, made.body.inviteToken, "token rotated");
  const oldAccept = await request(server).post("/api/v1/auth/invite/accept")
    .send({ token: made.body.inviteToken, password: "Passw0rd!Policy1" });
  assert.notEqual(oldAccept.status, 201, "old token is dead after resend");
  // the rotated link works
  const newAccept = await request(server).post("/api/v1/auth/invite/accept")
    .send({ token: resent.body.inviteToken, password: "Passw0rd!Policy1" });
  assert.equal(newAccept.status, 201, JSON.stringify(newAccept.body));

  // second invite → revoke → accepting fails, and re-inviting is possible again
  const email2 = `stuck2.${Date.now()}@school.example`;
  const made2 = await request(server).post("/api/v1/invites").set(auth("admin"))
    .send({ email: email2, display_name: "Stuck Two", roles: ["student"], grade_level: 10 });
  assert.equal(made2.status, 201);
  const list2 = await request(server).get("/api/v1/invites").set(auth("admin"));
  const row2 = list2.body.data.find((r) => r.email === email2);
  const rev = await request(server).post(`/api/v1/invites/${row2.id}/revoke`).set(auth("admin"));
  assert.equal(rev.status, 201);
  assert.equal(rev.body.ok, true);
  const revokedAccept = await request(server).post("/api/v1/auth/invite/accept")
    .send({ token: made2.body.inviteToken, password: "Passw0rd!Policy1" });
  assert.notEqual(revokedAccept.status, 201, "revoked invite cannot be accepted");
  const reinvite = await request(server).post("/api/v1/invites").set(auth("admin"))
    .send({ email: email2, display_name: "Stuck Two", roles: ["student"], grade_level: 10 });
  assert.equal(reinvite.status, 201, "revoke unblocks re-inviting");

  // teachers have no directory:write → no invite management
  const denied = await request(server).get("/api/v1/invites").set(auth("t1"));
  assert.equal(denied.status, 403);
});

test("roles:write is super_admin-only; grant + revoke audited", async () => {
  const denied = await request(server).post(`/api/v1/users/${ids.s1}/roles`).set(auth("admin"))
    .send({ role_code: "teacher_assistant" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "missing_capability");

  const granted = await request(server).post(`/api/v1/users/${ids.s1}/roles`).set(auth("root"))
    .send({ role_code: "student" }); // already held → conflict path
  assert.equal(granted.status, 409);
  const g2 = await request(server).post(`/api/v1/users/${ids.s1}/roles`).set(auth("root"))
    .send({ role_code: "teacher_assistant" });
  assert.equal(g2.status, 201, JSON.stringify(g2.body));
  const revoked = await request(server).delete(`/api/v1/users/${ids.s1}/roles/teacher_assistant`).set(auth("root"));
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, 1);
});

/* ── academics writes ── */
test("section create, enrollment, duplicate refusal, admission lookup", async () => {
  const sec = await request(server).post("/api/v1/sections").set(auth("admin"))
    .send({ course_code: "BIO-101", course_title: "Biology", name: "BIO-101 A", term_id: ids.term });
  assert.equal(sec.status, 201, JSON.stringify(sec.body));
  const dupe = await request(server).post("/api/v1/sections").set(auth("admin"))
    .send({ course_code: "BIO-101", course_title: "Biology", name: "BIO-101 A", term_id: ids.term });
  assert.equal(dupe.status, 409);

  const en = await request(server).post(`/api/v1/sections/${sec.body.id}/enrollments`).set(auth("admin"))
    .send({ student_user_id: ids.s1 });
  assert.equal(en.status, 201);
  const en2 = await request(server).post(`/api/v1/sections/${sec.body.id}/enrollments`).set(auth("admin"))
    .send({ student_user_id: ids.s1 });
  assert.equal(en2.status, 409);
  assert.equal(en2.body.code, "already_enrolled");

  const lookup = await request(server).get("/api/v1/students-lookup?admission_no=stu-0001").set(auth("admin"));
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.displayName, "Sola Student");

  const teacherDenied = await request(server).post("/api/v1/sections").set(auth("t1"))
    .send({ course_code: "X-1", course_title: "x", name: "x", term_id: ids.term });
  assert.equal(teacherDenied.status, 403); // teachers lack academics:write
});

/* ── push subscription lifecycle + parent guard ── */
test("push subscribe/unsubscribe; parent blocked by read-only guard", async () => {
  const sub = await request(server).post("/api/v1/notifications/push").set(auth("s1"))
    .send({ endpoint: "https://push.example/s1-device", keys: { p256dh: "pk", auth: "ak" } });
  assert.equal(sub.status, 201);
  const un = await request(server).post(`/api/v1/notifications/push/${sub.body.id}/unsubscribe`).set(auth("s1"));
  assert.equal(un.status, 201);
  assert.equal(un.body.removed, 1);

  const parentSub = await request(server).post("/api/v1/notifications/push").set(auth("p1"))
    .send({ endpoint: "https://push.example/p1" });
  assert.equal(parentSub.status, 403);
  assert.equal(parentSub.body.code, "parent_read_only");
});

/* ── SSO (OIDC authorization-code via mock IdP) ── */
// review-2: /start mirrors the signed state into an httpOnly sso_flow cookie
// (login-CSRF binding) — the callback rejects a state param that doesn't
// match the calling browser's cookie, so the flow must forward it.
function flowCookieOf(res) {
  const setCookies = res.headers["set-cookie"] ?? [];
  const found = setCookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("sso_flow="));
  return found ?? null;
}

async function ssoFlow(provider, email, extraAuthParams = "") {
  const start = await request(server).get(`/api/v1/auth/sso/${provider}/start`);
  assert.equal(start.status, 302);
  const authUrl = new URL(start.headers.location);
  assert.equal(authUrl.searchParams.get("client_id"), `${provider}-client`);
  assert.ok(authUrl.searchParams.get("state"));
  const flowCookie = flowCookieOf(start);
  assert.ok(flowCookie, "sso_flow cookie set on /start");
  // walk the IdP: auto-approve → callback URL with code+state
  const approved = await fetch(`${authUrl.toString()}&mock_email=${encodeURIComponent(email)}${extraAuthParams}`, { redirect: "manual" });
  assert.equal(approved.status, 302);
  const cb = new URL(approved.headers.get("location"));
  return request(server).get(`/api/v1/auth/sso/${provider}/callback`)
    .set({ Cookie: flowCookie })
    .query({ code: cb.searchParams.get("code"), state: cb.searchParams.get("state") });
}

test("SSO: JIT-provisions unknown user, session + cookie set", async () => {
  const cb = await ssoFlow("entra", "fresh.face@example.com");
  assert.equal(cb.status, 302, JSON.stringify(cb.body ?? {}));
  assert.equal(cb.headers.location, "http://127.0.0.1:3000/"); // student ⇒ no MFA redirect
  const sid = cookiesOf(cb).sid;
  assert.ok(sid, "session cookie set on web origin via BFF path");
  const sess = await request(server).get("/api/v1/auth/session").set({ Cookie: `sid=${sid}` });
  assert.equal(sess.status, 200);
  assert.equal(sess.body.email, "fresh.face@example.com");
  assert.deepEqual(sess.body.roles, ["student"]);
});

test("SSO: verified-email provider (google) links existing directory user by email; staff still MFA-gated", async () => {
  // email linking is only allowed for providers that ENFORCE email_verified
  const cb = await ssoFlow("google", "t2@school.example");
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, "http://127.0.0.1:3000/mfa"); // teacher ⇒ MFA gate
  const sid = cookiesOf(cb).sid;
  const sess = await request(server).get("/api/v1/auth/session").set({ Cookie: `sid=${sid}` });
  assert.equal(sess.body.email, "t2@school.example");
  assert.deepEqual(sess.body.roles, ["teacher"]);
  // and the MFA gate actually blocks data access pre-verification
  const blocked = await request(server).get("/api/v1/sections").set({ Cookie: `sid=${sid}` });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "mfa_required");
});

test("SSO: Entra (email_verified-exempt) may NOT claim an existing account by email — nOAuth", async () => {
  // review-3 #3: t2@school.example exists in the directory. An Entra identity
  // asserting that email has NOT proven mailbox ownership (no email_verified
  // claim), and Entra is exempt from it — so it must never link to t2's
  // account. review-4 #4: instead of a dead end, the callback offers the
  // password-proven linking flow.
  const cb = await ssoFlow("entra", "t2@school.example");
  assert.equal(cb.status, 302, JSON.stringify(cb.body ?? {}));
  assert.match(cb.headers.location, /^http:\/\/127\.0\.0\.1:3000\/login\?sso_error=sso_link_required&link_token=/);
  assert.equal(cookiesOf(cb).sid, undefined, "no session issued before the password proof");
  // the identity must NOT have been linked by the bare assertion
  const direct = await ssoFlow("entra", "t2@school.example");
  assert.equal(direct.status, 302);
  assert.match(direct.headers.location, /sso_link_required/, "still unlinked on the next attempt");
});

test("review-4 #4: password-proven linking connects Entra identity to the existing account", async () => {
  const cb = await ssoFlow("entra", "t2@school.example");
  const linkToken = new URL(cb.headers.location).searchParams.get("link_token");
  assert.ok(linkToken, "link_token issued");

  // wrong password → refused, nothing linked
  const bad = await request(server).post("/api/v1/auth/sso/link")
    .send({ link_token: linkToken, email: "t2@school.example", password: "WrongPassw0rd!1" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, "invalid_credentials");

  // email that doesn't match the IdP-asserted one → refused
  const wrongAcct = await request(server).post("/api/v1/auth/sso/link")
    .send({ link_token: linkToken, email: "s1@school.example", password: "Passw0rd!" });
  assert.equal(wrongAcct.status, 401, "cannot link to a different account than the IdP asserted");

  // correct password → linked + signed in
  const ok = await request(server).post("/api/v1/auth/sso/link")
    .send({ link_token: linkToken, email: "t2@school.example", password: "Passw0rd!" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok(ok.body.roles.includes("teacher"));
  assert.equal(ok.body.mfaRequired, true, "staff still face the MFA gate after linking");
  assert.ok(cookiesOf(ok).sid, "session cookie set");

  // subsequent Entra SSO signs straight in (identity now linked on sub)
  const again = await ssoFlow("entra", "t2@school.example");
  assert.equal(again.status, 302);
  assert.equal(again.headers.location, "http://127.0.0.1:3000/mfa");
  assert.ok(cookiesOf(again).sid, "session issued without the password step");

  // a forged/expired link token is refused
  const forged = await request(server).post("/api/v1/auth/sso/link")
    .send({ link_token: `${linkToken.split(".")[0]}.deadbeefdeadbeef`, email: "t2@school.example", password: "Passw0rd!" });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, "link_token_invalid");
});

test("review-5 #1: sso/link shares the DB-backed login lockout (no password oracle)", async () => {
  // the people who reach this form are exactly the ones who can make the IdP
  // assert someone else's email — the link form must burn the SAME failure
  // counter as /auth/login, not just the in-memory per-process rate limiter.
  const email = `lockme.${Date.now()}@school.example`;
  const made = await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email, display_name: "Lock Target", password: "Passw0rd!Policy1", roles: ["student"], grade_level: 10 });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const cb = await ssoFlow("entra", email);
  const linkToken = new URL(cb.headers.location).searchParams.get("link_token");
  assert.ok(linkToken, "link_token issued");

  // maxFailures (5) wrong passwords through the link form
  for (let i = 0; i < 5; i++) {
    const bad = await request(server).post("/api/v1/auth/sso/link")
      .send({ link_token: linkToken, email, password: `Wrong${i}Passw0rd!1` });
    assert.equal(bad.status, 401, `attempt ${i + 1} refused`);
  }
  // 6th attempt — even with the CORRECT password — hits the lockout
  const locked = await request(server).post("/api/v1/auth/sso/link")
    .send({ link_token: linkToken, email, password: "Passw0rd!Policy1" });
  assert.equal(locked.status, 423, JSON.stringify(locked.body));
  assert.equal(locked.body.code, "account_locked");
  assert.ok(locked.body.retryAfterMs > 0, "retryAfterMs returned");

  // the lockout is SHARED: the normal login endpoint is locked too
  const login = await request(server).post("/api/v1/auth/login")
    .send({ email, password: "Passw0rd!Policy1" });
  assert.equal(login.status, 423);
  assert.equal(login.body.code, "account_locked");
});

test("review-5 #2: revoke is tier-checked — a registrar cannot revoke an admin's invite", async () => {
  // admin invites a fellow school_admin (a role the registrar cannot grant)
  const email = `newadmin.${Date.now()}@school.example`;
  const made = await request(server).post("/api/v1/invites").set(auth("admin"))
    .send({ email, display_name: "New Admin", roles: ["school_admin"] });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  // registrar DOES hold directory:write — the tier check is the discriminator
  const regEmail = `reg.${Date.now()}@school.example`;
  const reg = await request(server).post("/api/v1/users").set(auth("admin"))
    .send({ email: regEmail, display_name: "Reg One", password: "Passw0rd!Policy1", roles: ["registrar"] });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  await staffLogin("reg", regEmail, "Passw0rd!Policy1");

  // registrar can manage invites within its own tier
  const stuEmail = `regstu.${Date.now()}@school.example`;
  const stuInv = await request(server).post("/api/v1/invites").set(auth("reg"))
    .send({ email: stuEmail, display_name: "Reg Student", roles: ["student"], grade_level: 10 });
  assert.equal(stuInv.status, 201, JSON.stringify(stuInv.body));

  // revoking the ADMIN-tier invite is refused
  const denied = await request(server).post(`/api/v1/invites/${made.body.inviteId}/revoke`).set(auth("reg"));
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.code, "role_above_your_tier");

  // and the admin's invite survived
  const stillThere = await request(server).get("/api/v1/invites").set(auth("admin"));
  assert.ok(stillThere.body.data.some((r) => r.email === email), "admin invite still pending");
});

test("SSO: unprovisioned identity refused when JIT disabled", async () => {
  const cb = await ssoFlow("google", "stranger@example.com");
  assert.equal(cb.status, 403);
  assert.equal(cb.body.code, "sso_user_not_provisioned");
});

test("SSO: tampered state rejected", async () => {
  const start = await request(server).get("/api/v1/auth/sso/entra/start");
  const state = new URL(start.headers.location).searchParams.get("state");
  const flowCookie = flowCookieOf(start);
  const [b64] = state.split(".");
  const cb = await request(server).get("/api/v1/auth/sso/entra/callback")
    .set({ Cookie: flowCookie })
    .query({ code: Buffer.from("x@y.z").toString("base64url"), state: `${b64}.deadbeef` });
  assert.equal(cb.status, 302);
  assert.match(cb.headers.location, /sso_error=state/);
});

/* ── review-2: login-CSRF cookie binding ── */
test("SSO: callback without flow cookie rejected (login CSRF)", async () => {
  const start = await request(server).get("/api/v1/auth/sso/entra/start");
  const state = new URL(start.headers.location).searchParams.get("state");
  const cb = await request(server).get("/api/v1/auth/sso/entra/callback")
    .query({ code: Buffer.from("x@y.z").toString("base64url"), state });
  assert.equal(cb.status, 302);
  assert.match(cb.headers.location, /sso_error=sso%20flow%20cookie%20missing/);
});

test("SSO: state from another browser's flow rejected", async () => {
  // Browser A starts a flow; attacker hands victim their own code+state.
  const startA = await request(server).get("/api/v1/auth/sso/entra/start");
  const stateA = new URL(startA.headers.location).searchParams.get("state");
  // Victim's browser has its OWN flow cookie (different nonce/verifier).
  const startB = await request(server).get("/api/v1/auth/sso/entra/start");
  const cookieB = flowCookieOf(startB);
  const cb = await request(server).get("/api/v1/auth/sso/entra/callback")
    .set({ Cookie: cookieB })
    .query({ code: Buffer.from("x@y.z").toString("base64url"), state: stateA });
  assert.equal(cb.status, 302);
  assert.match(cb.headers.location, /sso_error=state%20does%20not%20match/);
});

/* ── review-2: Entra oid/tid identity linking ── */
test("SSO: Entra identity linked on oid:tid, survives email change", async () => {
  const oid = "11111111-2222-3333-4444-555555555555";
  const tid = "99999999-8888-7777-6666-555555555555";
  const params = `&mock_oid=${oid}&mock_tid=${tid}`;
  const first = await ssoFlow("entra", "rename.me@example.com", params);
  assert.equal(first.status, 302, JSON.stringify(first.body ?? {}));
  const sid1 = cookiesOf(first).sid;
  const sess1 = await request(server).get("/api/v1/auth/session").set({ Cookie: `sid=${sid1}` });
  assert.equal(sess1.body.email, "rename.me@example.com");
  const uid = sess1.body.userId;
  // same oid/tid, DIFFERENT email (marriage/rename) → same linked account
  const second = await ssoFlow("entra", "renamed.person@example.com", params);
  assert.equal(second.status, 302, JSON.stringify(second.body ?? {}));
  const sid2 = cookiesOf(second).sid;
  const sess2 = await request(server).get("/api/v1/auth/session").set({ Cookie: `sid=${sid2}` });
  assert.equal(sess2.body.userId, uid, "oid:tid identity resolves to the same user after email change");
  // identity subject stored as oid:tid
  const [ident] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(require("../dist/db/schema.js").identities)
      .where(eq(require("../dist/db/schema.js").identities.userId, uid)));
  assert.equal(ident.subject, `${oid}:${tid}`);
});

/* ── review-2: email_verified per-provider ── */
test("SSO: unverified email refused on Google (email_verified required)", async () => {
  const cb = await ssoFlow("google", "unverified@example.com", "&mock_email_verified=false");
  assert.equal(cb.status, 302);
  assert.match(cb.headers.location, /sso_error=email%20not%20verified/);
});

test("SSO: unverified-email claim absent is OK on Entra (exempt per-provider)", async () => {
  const cb = await ssoFlow("entra", "entra.noverified@example.com", "&mock_email_verified=false");
  assert.equal(cb.status, 302, JSON.stringify(cb.body ?? {}));
  assert.ok(cookiesOf(cb).sid, "session issued despite absent email_verified (Entra exemption)");
});
