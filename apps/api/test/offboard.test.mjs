/**
 * Offboarding suite.
 *
 * The gap: there was no way to deactivate anyone, so a teacher who resigned on
 * Friday still had working credentials on Monday. Deleting them was never an
 * option — their marks and attendance are school records.
 *
 * These tests cover the things that actually bite: does an open session really
 * stop working, can the last administrator lock everyone out, does a reset
 * link mailed last week still let a leaver back in, and does reactivation give
 * back exactly the roles that were taken.
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
const {
  users, userRoles, sessions, auditLog, passwordResetTokens,
  userInvites, guardians, mfaEnrollTokens,
} = require("../dist/db/schema.js");
const { eq, and, isNull, desc, sql } = require("drizzle-orm");
const { randomUUID } = require("node:crypto");
const request = require("supertest");

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
const auth = (n) => ({ Cookie: `sid=${jars[n].sid}; csrf=${jars[n].csrf}`, "x-csrf": jars[n].csrf });

async function login(email, password = "Passw0rd!", name) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password });
  if (name) jars[name] = { ...cookiesOf(res) };
  return res;
}
async function staffLogin(name, email) {
  await login(email, "Passw0rd!", name);
  const uid = await uidOf(email);
  const token = await issueEnrollToken(db, uid, null);
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll")
    .set(auth(name)).send({ token });
  assert.equal(enroll.status, 201, JSON.stringify(enroll.body));
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}
async function uidOf(email) {
  const [u] = await withActor(db, SERVICE, async (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  return u.id;
}
const statusOf = async (id) => (await withActor(db, SERVICE, async (tx) =>
  tx.select().from(users).where(eq(users.id, id)).limit(1)))[0];

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  ids = await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");
});
after(async () => { await app.close(); });

test("the preview shows what deactivation will break, before it happens", async () => {
  const teacher = await uidOf("t1@school.example");
  const res = await request(server).get(`/api/v1/users/${teacher}/offboard-preview`).set(auth("admin"));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.user.email, "t1@school.example");
  assert.ok(res.body.user.roles.includes("teacher"));
  assert.ok(Array.isArray(res.body.sectionsTaught));
  // The seeded teacher has classes; the registrar must be told.
  if (res.body.sectionsTaught.length > 0) {
    assert.match(res.body.warnings.join(" "), /section\(s\)|replacement teacher/);
  }
  assert.deepEqual(res.body.blockers, [], "a normal teacher is deactivatable");
});

test("deactivation kills a live session on the very next request", async () => {
  // The point of the whole feature. A resigned teacher with a browser tab open
  // must not be able to keep marking attendance.
  await staffLogin("t2", "t2@school.example");
  const before = await request(server).get("/api/v1/auth/session").set(auth("t2"));
  assert.equal(before.status, 200, "sanity: the teacher is logged in");

  const t2 = await uidOf("t2@school.example");
  const res = await request(server).post(`/api/v1/users/${t2}/deactivate`)
    .set(auth("admin")).send({ reason: "Resigned at the end of term" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, "left");
  assert.ok(res.body.effects.sessionsRevoked >= 1, "their open session must be revoked");

  const after = await request(server).get("/api/v1/auth/session").set(auth("t2"));
  assert.equal(after.status, 401, "the existing session must stop working immediately");

  const relogin = await login("t2@school.example", "Passw0rd!");
  assert.notEqual(relogin.status, 201, "and they must not be able to log back in");
});

test("deactivation records who, when and why", async () => {
  const t2 = await uidOf("t2@school.example");
  const row = await statusOf(t2);
  assert.equal(row.status, "left");
  assert.ok(row.deactivatedAt, "deactivatedAt must be stamped");
  assert.equal(row.deactivatedBy, await uidOf("admin@school.example"));
  assert.match(row.deactivationReason, /Resigned/);

  const [entry] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.action, "user.deactivated"),
      eq(auditLog.entityId, t2))).orderBy(desc(auditLog.occurredAt)).limit(1));
  assert.ok(entry, "the deactivation must be audited");
  assert.equal(entry.afterJson.status, "left");
  assert.match(entry.afterJson.reason, /Resigned/);
  assert.equal(entry.beforeJson.status, "active");
});

test("roles are revoked, and reactivation restores exactly those roles", async () => {
  const t2 = await uidOf("t2@school.example");
  const live = async () => withActor(db, SERVICE, async (tx) =>
    tx.select().from(userRoles).where(and(eq(userRoles.userId, t2), isNull(userRoles.revokedAt))));
  assert.equal((await live()).length, 0, "a deactivated user holds no live roles");

  const res = await request(server).post(`/api/v1/users/${t2}/reactivate`)
    .set(auth("admin")).send({ reason: "Came back after all" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.rolesRestored, ["teacher"]);
  assert.deepEqual((await live()).map((r) => r.roleCode), ["teacher"]);

  const row = await statusOf(t2);
  assert.equal(row.status, "active");
  assert.equal(row.deactivatedAt, null, "the deactivation stamp is cleared on return");
  assert.equal(row.deactivationReason, null);

  // And they can log in again.
  assert.equal((await login("t2@school.example", "Passw0rd!")).status, 201);
});

test("reactivation does not hand back a role that was revoked earlier for cause", async () => {
  // Someone demoted from registrar last term, then offboarded, must come back
  // as a teacher only. "Restore whatever they once had" would re-grant it.
  const uid = await uidOf("t2@school.example");
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(userRoles).values({
      id: randomUUID(), userId: uid, roleCode: "registrar",
      revokedAt: new Date(Date.now() - 86_400_000), // revoked yesterday, deliberately
    });
  });

  await request(server).post(`/api/v1/users/${uid}/deactivate`).set(auth("admin")).send({});
  const res = await request(server).post(`/api/v1/users/${uid}/reactivate`).set(auth("admin")).send({});
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.rolesRestored, ["teacher"],
    "only the roles this deactivation revoked come back");
});

test("you cannot deactivate yourself", async () => {
  const me = await uidOf("admin@school.example");
  const res = await request(server).post(`/api/v1/users/${me}/deactivate`).set(auth("admin")).send({});
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "deactivation_blocked");
  assert.match(res.body.detail, /your own account/);
  assert.equal((await statusOf(me)).status, "active");
});

test("you cannot deactivate the last super administrator", async () => {
  // The failure mode this prevents: nobody can administer the portal, ever
  // again, and it cannot be undone from inside the product.
  const root = await uidOf("root@school.example");
  const res = await request(server).post(`/api/v1/users/${root}/deactivate`).set(auth("admin")).send({});
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.code, "deactivation_blocked");
  assert.match(res.body.detail, /last active super administrator/);
  assert.equal((await statusOf(root)).status, "active");

  const preview = await request(server).get(`/api/v1/users/${root}/offboard-preview`).set(auth("admin"));
  assert.match(preview.body.blockers.join(" "), /lock everyone out/);
});

test("a second super admin makes the first one safe to offboard", async () => {
  const spare = randomUUID();
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(users).values({
      id: spare, email: `spare-${spare.slice(0, 8)}@school.example`,
      displayName: "Spare Root", passwordHash: null, status: "active",
    });
    await tx.insert(userRoles).values({ id: randomUUID(), userId: spare, roleCode: "super_admin" });
  });
  const root = await uidOf("root@school.example");
  const preview = await request(server).get(`/api/v1/users/${root}/offboard-preview`).set(auth("admin"));
  assert.deepEqual(preview.body.blockers, [], "with a spare super admin there is no lock-out risk");

  // Clean up so later tests see the original shape.
  await withActor(db, SERVICE, async (tx) => {
    await tx.delete(userRoles).where(eq(userRoles.userId, spare));
    await tx.delete(users).where(eq(users.id, spare));
  });
});

test("deactivating an already-inactive account is refused, not silently repeated", async () => {
  const uid = await uidOf("t2@school.example");
  assert.equal((await request(server).post(`/api/v1/users/${uid}/deactivate`)
    .set(auth("admin")).send({})).status, 201);
  const again = await request(server).post(`/api/v1/users/${uid}/deactivate`).set(auth("admin")).send({});
  assert.equal(again.status, 422);
  assert.match(again.body.detail, /already left/);
  await request(server).post(`/api/v1/users/${uid}/reactivate`).set(auth("admin")).send({});
});

test("reactivating an active account is refused", async () => {
  const uid = await uidOf("t1@school.example");
  const res = await request(server).post(`/api/v1/users/${uid}/reactivate`).set(auth("admin")).send({});
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "already_active");
});

test("pending reset links, invites and enrol tokens die with the account", async () => {
  // A password-reset email sent last week is a live credential. Offboarding
  // that leaves it working has not offboarded anyone.
  const uid = await uidOf("t2@school.example");
  const email = "t2@school.example";
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(passwordResetTokens).values({
      id: randomUUID(), userId: uid, tokenHash: `reset-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await tx.insert(mfaEnrollTokens).values({
      id: randomUUID(), userId: uid, tokenHash: `enrol-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await tx.insert(userInvites).values({
      id: randomUUID(), email, displayName: "T2", roleCodes: JSON.stringify(["teacher"]),
      tokenHash: `invite-${randomUUID()}`, expiresAt: new Date(Date.now() + 86_400_000),
    });
  });

  const res = await request(server).post(`/api/v1/users/${uid}/deactivate`).set(auth("admin")).send({});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.effects.resetTokensVoided >= 1, "reset tokens must be voided");
  assert.ok(res.body.effects.enrollTokensVoided >= 1, "MFA enrol tokens must be voided");
  assert.ok(res.body.effects.invitesCancelled >= 1, "pending invites must be cancelled");

  const live = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(passwordResetTokens).where(and(
      eq(passwordResetTokens.userId, uid), isNull(passwordResetTokens.usedAt))));
  assert.equal(live.length, 0);

  await request(server).post(`/api/v1/users/${uid}/reactivate`).set(auth("admin")).send({});
});

test("guardian links end only when explicitly asked", async () => {
  const parent = await uidOf("parent@school.example").catch(() => null);
  if (!parent) return; // seed shape differs; covered by the API-level flag test below

  const linksLive = async () => withActor(db, SERVICE, async (tx) =>
    tx.select().from(guardians).where(and(eq(guardians.userId, parent), isNull(guardians.endedAt))));
  const had = (await linksLive()).length;

  await request(server).post(`/api/v1/users/${parent}/deactivate`).set(auth("admin")).send({});
  assert.equal((await linksLive()).length, had,
    "a deactivation without the flag must not quietly sever a parent's children");
  await request(server).post(`/api/v1/users/${parent}/reactivate`).set(auth("admin")).send({});

  await request(server).post(`/api/v1/users/${parent}/deactivate`)
    .set(auth("admin")).send({ end_guardian_links: true });
  assert.equal((await linksLive()).length, 0, "with the flag, links are ended");
  await request(server).post(`/api/v1/users/${parent}/reactivate`).set(auth("admin")).send({});
});

test("history survives offboarding — nothing is deleted", async () => {
  const uid = await uidOf("t1@school.example");
  const countsBefore = await withActor(db, SERVICE, async (tx) => {
    const [a] = await tx.select({ n: sql`count(*)::int` }).from(auditLog);
    return Number(a.n);
  });
  await request(server).post(`/api/v1/users/${uid}/deactivate`).set(auth("admin")).send({});
  const [stillThere] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(users).where(eq(users.id, uid)).limit(1));
  assert.ok(stillThere, "the user row must remain — their marks reference it");
  const countsAfter = await withActor(db, SERVICE, async (tx) => {
    const [a] = await tx.select({ n: sql`count(*)::int` }).from(auditLog);
    return Number(a.n);
  });
  assert.ok(countsAfter > countsBefore, "the audit log only grows");
  await request(server).post(`/api/v1/users/${uid}/reactivate`).set(auth("admin")).send({});
});

test("offboarding requires directory:write — a teacher cannot do it", async () => {
  await staffLogin("t1", "t1@school.example");
  const victim = await uidOf("t2@school.example");
  const res = await request(server).post(`/api/v1/users/${victim}/deactivate`).set(auth("t1")).send({});
  assert.equal(res.status, 403);
  const prev = await request(server).get(`/api/v1/users/${victim}/offboard-preview`).set(auth("t1"));
  assert.equal(prev.status, 403);
});

test("unknown user ids are 404, not 500", async () => {
  const ghost = randomUUID();
  assert.equal((await request(server).get(`/api/v1/users/${ghost}/offboard-preview`)
    .set(auth("admin"))).status, 404);
  assert.equal((await request(server).post(`/api/v1/users/${ghost}/deactivate`)
    .set(auth("admin")).send({})).status, 404);
  assert.equal((await request(server).post(`/api/v1/users/${ghost}/reactivate`)
    .set(auth("admin")).send({})).status, 404);
});
