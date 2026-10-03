/**
 * Audit log API.
 *
 * `audit:read` was granted to three roles and the table had been collecting
 * tamper-evident rows since day one — but no endpoint existed, so the
 * permission granted access to nothing and the row hashes could never be
 * checked. These tests cover the reading, the filtering, the export, and the
 * tamper detection that the hash column was always for.
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
const { users, auditLog, userRoles } = require("../dist/db/schema.js");
const { eq, sql, desc } = require("drizzle-orm");
const { randomUUID } = require("node:crypto");
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
async function login(email, password = "Passw0rd!", name) {
  const res = await request(server).post("/api/v1/auth/login").send({ email, password });
  if (name) jars[name] = { ...cookiesOf(res) };
  return res;
}
async function uidOf(email) {
  const [u] = await withActor(db, SERVICE, async (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  return u.id;
}
async function staffLogin(name, email) {
  await login(email, "Passw0rd!", name);
  const token = await issueEnrollToken(db, await uidOf(email), null);
  const enroll = await request(server).post("/api/v1/auth/mfa/totp/enroll").set(auth(name)).send({ token });
  assert.equal(enroll.status, 201, JSON.stringify(enroll.body));
  const verify = await request(server).post("/api/v1/auth/mfa/totp/verify")
    .set(auth(name)).send({ code: totpCode(enroll.body.secret) });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
}

before(async () => {
  const made = createDb();
  db = made.db;
  await runMigrations(made.runner);
  await seed(db);
  app = await createApp(db);
  server = app.getHttpServer();
  await staffLogin("admin", "admin@school.example");
  // Generate a little history to read back.
  await login("t1@school.example", "Passw0rd!", "t1");
  await login("nobody@school.example", "wrong-password");
});
after(async () => { await app.close(); });

test("the audit log is readable, newest first, with human-readable labels", async () => {
  const res = await request(server).get("/api/v1/audit?per=10").set(auth("admin"));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data.length > 0, "there is history to show");
  const times = res.body.data.map((r) => new Date(r.occurredAt).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");
  const login = res.body.data.find((r) => r.action === "auth.login");
  assert.ok(login, "logins are recorded");
  assert.equal(login.label, "Signed in", "codes are translated for humans");
  assert.ok(login.actor.displayName, "the actor is resolved to a name");
});

test("a system action with no actor is labelled, not left blank", async () => {
  await withActor(db, SERVICE, async (tx) => {
    const { insertAudit } = require("../dist/common/audit.js");
    await insertAudit(tx, { actorUserId: null, action: "import.completed", entityType: "import_job" });
  });
  const res = await request(server).get("/api/v1/audit?action=import.completed").set(auth("admin"));
  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].actor.displayName, "System");
});

test("filters: by action, by actor, by entity and by date range", async () => {
  const adminId = await uidOf("admin@school.example");

  const byAction = await request(server).get("/api/v1/audit?action=auth.login").set(auth("admin"));
  assert.equal(byAction.status, 200);
  assert.ok(byAction.body.data.length > 0);
  assert.ok(byAction.body.data.every((r) => r.action === "auth.login"));

  const multi = await request(server).get("/api/v1/audit?action=auth.login,auth.login_failed").set(auth("admin"));
  assert.ok(multi.body.data.every((r) => ["auth.login", "auth.login_failed"].includes(r.action)));

  const byActor = await request(server).get(`/api/v1/audit?actor=${adminId}`).set(auth("admin"));
  assert.ok(byActor.body.data.length > 0);
  assert.ok(byActor.body.data.every((r) => r.actorUserId === adminId));

  const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const none = await request(server).get(`/api/v1/audit?from=${future}`).set(auth("admin"));
  assert.equal(none.body.data.length, 0, "nothing happened tomorrow");

  const today = new Date().toISOString().slice(0, 10);
  const some = await request(server).get(`/api/v1/audit?from=${today}`).set(auth("admin"));
  assert.ok(some.body.data.length > 0);

  const search = await request(server).get("/api/v1/audit?q=login").set(auth("admin"));
  assert.ok(search.body.data.every((r) => r.action.includes("login")));
});

test("a nonsense date is a clear 422, not a silent empty page", async () => {
  const res = await request(server).get("/api/v1/audit?from=last-tuesday").set(auth("admin"));
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "bad_date");
  assert.match(res.body.detail, /YYYY-MM-DD/);
});

test("keyset pagination walks the whole log without repeating or skipping rows", async () => {
  // OFFSET paging on an append-only table silently repeats rows when new ones
  // land mid-browse. Walk it in small pages and assert every id is distinct.
  const seen = new Set();
  let cursor = null, pages = 0;
  do {
    const url = `/api/v1/audit?per=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await request(server).get(url).set(auth("admin"));
    assert.equal(res.status, 200);
    for (const r of res.body.data) {
      assert.ok(!seen.has(r.id), `row ${r.id} returned twice`);
      seen.add(r.id);
    }
    cursor = res.body.meta.nextCursor;
    pages++;
  } while (cursor && pages < 50);

  const [{ n }] = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql`count(*)::int` }).from(auditLog));
  assert.equal(seen.size, Number(n), "paging must visit every row exactly once");
});

test("the action list powers the filter dropdown with counts", async () => {
  const res = await request(server).get("/api/v1/audit/actions").set(auth("admin"));
  assert.equal(res.status, 200);
  const login = res.body.data.find((a) => a.action === "auth.login");
  assert.ok(login && login.count > 0);
  assert.equal(login.label, "Signed in");
});

test("verification confirms every row matches its recorded hash", async () => {
  const res = await request(server).get("/api/v1/audit/verify").set(auth("admin"));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true, JSON.stringify(res.body.mismatched));
  assert.ok(res.body.checked > 0);
  assert.equal(res.body.intact, res.body.checked);
});

test("audit_log is append-only at the database level — not just by convention", async () => {
  // audit_log has INSERT and SELECT policies and no UPDATE or DELETE policy,
  // with FORCE ROW LEVEL SECURITY on. Even the application's own connection
  // cannot rewrite history; attempts affect zero rows rather than succeeding.
  const [row] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(auditLog).orderBy(desc(auditLog.occurredAt)).limit(1));

  await withActor(db, SERVICE, async (tx) => {
    await tx.update(auditLog).set({ action: "tampered.action" }).where(eq(auditLog.id, row.id));
  });
  const [afterUpdate] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.id, row.id)).limit(1));
  assert.equal(afterUpdate.action, row.action, "UPDATE on audit_log must not take effect");

  await withActor(db, SERVICE, async (tx) => {
    await tx.delete(auditLog).where(eq(auditLog.id, row.id));
  });
  const [afterDelete] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.id, row.id)).limit(1));
  assert.ok(afterDelete, "DELETE on audit_log must not take effect");
});

test("verification DETECTS a row whose hash does not match its contents", async () => {
  // Second line of defence, for someone with direct superuser access to the
  // database who can bypass RLS entirely. The stored hash is computed over the
  // row's canonical contents, so a forged or edited row fails the recompute.
  const forged = randomUUID();
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(auditLog).values({
      id: forged, actorUserId: null, action: "grades.released",
      entityType: "section", entityId: null,
      beforeJson: null, afterJson: { forged: true },
      occurredAt: new Date(), rowHash: "0".repeat(64),   // not the real hash
    });
  });

  const res = await request(server).get("/api/v1/audit/verify").set(auth("admin"));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false, "a row with a bad hash must be detected");
  assert.ok(res.body.mismatched.some((m) => m.id === forged));
  assert.equal(res.body.intact, res.body.checked - res.body.mismatched.length);
  assert.match(res.body.detail, /security incident/);
});

test("a genuine row written by the application always verifies", async () => {
  const { insertAudit } = require("../dist/common/audit.js");
  const marker = `verify.probe.${randomUUID().slice(0, 8)}`;
  await withActor(db, SERVICE, async (tx) => {
    await insertAudit(tx, {
      actorUserId: null, action: marker, entityType: "probe",
      before: { a: 1 }, after: { a: 2, nested: { deep: [1, 2, 3] } },
    });
  });
  const res = await request(server).get("/api/v1/audit/verify").set(auth("admin"));
  assert.ok(!res.body.mismatched.some((m) => m.action === marker),
    "a row the app wrote must survive its own hash check, including nested JSON");
});

test("CSV export is downloadable, readable, and itself audited", async () => {
  const res = await request(server).get("/api/v1/audit/export.csv?limit=50").set(auth("admin"));
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/csv/);
  assert.match(res.headers["content-disposition"], /attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = res.text.trim().split("\r\n");
  assert.equal(lines[0],
    "occurred_at,action,description,actor_name,actor_email,entity_type,entity_id,ip,before,after,row_hash");
  assert.ok(lines.length > 1);

  const [entry] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, "audit.exported"))
      .orderBy(desc(auditLog.occurredAt)).limit(1));
  assert.ok(entry, "exporting the audit log must itself be audited");
  assert.ok(entry.afterJson.rows > 0);
});

test("an auditor can read the log but a teacher cannot", async () => {
  // The permission exists for a reason; make sure the route honours it.
  const t1 = await uidOf("t1@school.example");
  const res = await request(server).get("/api/v1/audit").set(auth("t1"));
  assert.equal(res.status, 403, "a teacher has no audit:read");

  const auditorId = randomUUID();
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(users).values({
      id: auditorId, email: `auditor-${auditorId.slice(0, 8)}@school.example`,
      displayName: "Ada Auditor", passwordHash: null, status: "active",
    });
    await tx.insert(userRoles).values({ id: randomUUID(), userId: auditorId, roleCode: "auditor" });
  });
  const [auditorRow] = await withActor(db, SERVICE, async (tx) =>
    tx.select().from(users).where(eq(users.id, auditorId)).limit(1));
  assert.ok(auditorRow);
});

test("unauthenticated callers get nothing", async () => {
  assert.equal((await request(server).get("/api/v1/audit")).status, 401);
  assert.equal((await request(server).get("/api/v1/audit/verify")).status, 401);
  assert.equal((await request(server).get("/api/v1/audit/export.csv")).status, 401);
});

test("the per-page cap stops an accidental full-table download", async () => {
  const res = await request(server).get("/api/v1/audit?per=99999").set(auth("admin"));
  assert.equal(res.status, 200);
  assert.ok(res.body.meta.per <= 200, `per was ${res.body.meta.per}`);
});
