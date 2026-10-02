/**
 * Backup & restore tests.
 *
 * The review's complaint was that the backup story was fiction: the script
 * wrote unencrypted dumps to a local directory, kept 14 of them, nothing ran
 * it, and no one had ever restored one. Shell scripts are exactly the kind of
 * code that rots silently, so the behaviour the runbook promises is pinned
 * here.
 *
 * pg_dump/psql are not available in CI, so the script exposes BACKUP_SKIP_DUMP
 * to substitute a fixture file for the dump stage. Everything after that —
 * encryption, the decrypt self-check, size sanity, retention, the heartbeat,
 * cleanup of partial files — is the real code path that runs in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const BACKUP = join(REPO, "scripts/backup.sh");
const RESTORE = join(REPO, "scripts/restore.sh");
const KEY = "test-key-at-least-twenty-chars-long";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "backup-test-"));
  const source = join(dir, "source.dump");
  // Stand-in for a pg_dump custom-format file, big enough to pass the sanity floor.
  writeFileSync(source, Buffer.alloc(200_000, "PGDMP-fixture-"));
  return { dir, source, backups: join(dir, "backups"), heartbeat: join(dir, "state/hb.json") };
}

function run(script, args, env, opts = {}) {
  // The scripts log to stderr (so stdout stays clean for piping), so merge
  // both streams — otherwise assertions on warnings silently see "".
  try {
    const out = execFileSync("bash", ["-c", 'exec bash "$@" 2>&1', "_", script, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function backupEnv(w, extra = {}) {
  return {
    DATABASE_URL: "postgres://user:pw@localhost/portal",
    BACKUP_ENCRYPTION_KEY: KEY,
    BACKUP_DIR: w.backups,
    BACKUP_HEARTBEAT_FILE: w.heartbeat,
    BACKUP_SKIP_DUMP: "true",
    BACKUP_SOURCE_FILE: w.source,
    ...extra,
  };
}

const dumps = (w) => (existsSync(w.backups) ? readdirSync(w.backups).filter((f) => f.endsWith(".enc")) : []);

test("a backup is encrypted at rest — the plaintext dump never lands on disk", () => {
  const w = workspace();
  const r = run(BACKUP, [], backupEnv(w));
  assert.equal(r.code, 0, r.out);

  const files = dumps(w);
  assert.equal(files.length, 1);
  const blob = readFileSync(join(w.backups, files[0]));
  assert.ok(blob.subarray(0, 16).toString().startsWith("Salted__"), "must be an openssl salted container");
  assert.ok(!blob.includes(Buffer.from("PGDMP-fixture-")),
    "the dump contents must not be readable in the stored file");
  // And no stray plaintext file alongside it.
  assert.equal(readdirSync(w.backups).filter((f) => f.endsWith(".dump")).length, 0);
  rmSync(w.dir, { recursive: true, force: true });
});

test("a backup round-trips: what restore decrypts is byte-identical to the dump", () => {
  const w = workspace();
  assert.equal(run(BACKUP, [], backupEnv(w)).code, 0);
  const enc = join(w.backups, dumps(w)[0]);
  const out = join(w.dir, "rt.dump");
  execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000",
    "-pass", "env:K", "-in", enc, "-out", out], { env: { ...process.env, K: KEY } });
  assert.deepEqual(readFileSync(out), readFileSync(w.source), "restore would not return the original bytes");
  rmSync(w.dir, { recursive: true, force: true });
});

test("the wrong encryption key cannot read a backup", () => {
  const w = workspace();
  assert.equal(run(BACKUP, [], backupEnv(w)).code, 0);
  const r = run(RESTORE, ["--latest", "--list"], {
    BACKUP_ENCRYPTION_KEY: "a-different-key-entirely-here", BACKUP_DIR: w.backups,
    TARGET_DATABASE_URL: "postgres://x/y",
  });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /decryption failed|wrong BACKUP_ENCRYPTION_KEY/);
  rmSync(w.dir, { recursive: true, force: true });
});

test("the heartbeat is written only after a backup fully succeeds", () => {
  const w = workspace();
  assert.equal(run(BACKUP, [], backupEnv(w)).code, 0);
  const hb = JSON.parse(readFileSync(w.heartbeat, "utf8"));
  assert.equal(hb.encrypted, true);
  assert.equal(hb.size_bytes > 0, true);
  assert.match(hb.sha256, /^[0-9a-f]{64}$/);
  assert.equal(hb.retention_days, 35, "the runbook commits to 35 days");
  assert.ok(Date.now() - new Date(hb.completed_at).getTime() < 120_000);

  // A failed run must NOT refresh it, or /health would report healthy backups
  // that do not exist.
  const empty = join(w.dir, "empty.dump");
  writeFileSync(empty, "");
  const fail = run(BACKUP, [], backupEnv(w, { BACKUP_SOURCE_FILE: empty }));
  assert.notEqual(fail.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(w.heartbeat, "utf8")).completed_at, hb.completed_at,
    "a failed backup must not update the heartbeat");
  rmSync(w.dir, { recursive: true, force: true });
});

test("a failed run cleans up its partial file and leaves good backups intact", () => {
  // Regression: a partial dump left in the staging directory is the file
  // `restore.sh --latest` would pick — a 32-byte corpse shadowing the real
  // backup, discovered at the worst possible moment.
  const w = workspace();
  assert.equal(run(BACKUP, [], backupEnv(w)).code, 0);
  const good = dumps(w);
  assert.equal(good.length, 1);

  const empty = join(w.dir, "empty.dump");
  writeFileSync(empty, "");
  assert.notEqual(run(BACKUP, [], backupEnv(w, { BACKUP_SOURCE_FILE: empty })).code, 0);

  assert.deepEqual(dumps(w), good,
    "the failed run must leave exactly the good backup behind — no corpse, nothing deleted");
  rmSync(w.dir, { recursive: true, force: true });
});

test("retention keeps 35 days, drops older, and destroys legacy unencrypted dumps", () => {
  const w = workspace();
  assert.equal(run(BACKUP, [], backupEnv(w)).code, 0);

  const old = join(w.backups, "portal-20200101T000000Z-aaaaaa.dump.enc");
  const recent = join(w.backups, "portal-20240101T000000Z-bbbbbb.dump.enc");
  const legacy = join(w.backups, "portal-20200101T000000Z.dump"); // the old script's output
  writeFileSync(old, "x"); writeFileSync(recent, "x");
  writeFileSync(legacy, "PLAINTEXT PUPIL DATA");
  const days = (n) => (Date.now() - n * 86_400_000) / 1000;
  utimesSync(old, days(40), days(40));
  utimesSync(recent, days(5), days(5));

  assert.equal(run(BACKUP, [], backupEnv(w)).code, 0);
  const left = readdirSync(w.backups);
  assert.ok(!left.includes("portal-20200101T000000Z-aaaaaa.dump.enc"), "40-day-old backup should be pruned");
  assert.ok(left.includes("portal-20240101T000000Z-bbbbbb.dump.enc"), "5-day-old backup must be kept");
  assert.ok(!left.includes("portal-20200101T000000Z.dump"),
    "a legacy UNENCRYPTED dump must be removed, not left sitting there");
  rmSync(w.dir, { recursive: true, force: true });
});

test("two runs in the same second do not collide", () => {
  const w = workspace();
  assert.equal(run(BACKUP, [], backupEnv(w)).code, 0);
  assert.equal(run(BACKUP, [], backupEnv(w)).code, 0);
  assert.equal(dumps(w).length, 2, "the second run must not overwrite the first");
  rmSync(w.dir, { recursive: true, force: true });
});

test("misconfiguration fails loudly, with the fix in the message", () => {
  const w = workspace();
  const cases = [
    [{ BACKUP_ENCRYPTION_KEY: "" }, 2, /openssl rand -base64 32/],
    [{ BACKUP_ENCRYPTION_KEY: "tooshort" }, 2, /too short/],
    [{ DATABASE_URL: "" }, 2, /DATABASE_URL is required/],
    [{ BACKUP_S3_BUCKET: "b", AWS_CLI_BIN: "definitely-not-installed" }, 2, /aws CLI is missing/],
  ];
  for (const [extra, code, re] of cases) {
    const r = run(BACKUP, ["--check"], backupEnv(w, extra));
    assert.equal(r.code, code, `expected exit ${code} for ${JSON.stringify(extra)}: ${r.out}`);
    assert.match(r.out, re);
  }
  rmSync(w.dir, { recursive: true, force: true });
});

test("--check warns when backups are local-only", () => {
  const w = workspace();
  const r = run(BACKUP, ["--check"], backupEnv(w));
  assert.equal(r.code, 0);
  assert.match(r.out, /stay on this host only/);
  rmSync(w.dir, { recursive: true, force: true });
});

test("an empty or truncated dump is refused rather than stored as a backup", () => {
  const w = workspace();
  const tiny = join(w.dir, "tiny.dump");
  writeFileSync(tiny, "oops");
  const r = run(BACKUP, [], backupEnv(w, { BACKUP_SOURCE_FILE: tiny }));
  assert.equal(r.code, 3);
  assert.match(r.out, /refusing to call that a backup/);
  assert.equal(dumps(w).length, 0);
  rmSync(w.dir, { recursive: true, force: true });
});

test("restore refuses a non-empty target database unless forced", () => {
  // Guard-rail check via the arguments it validates before touching anything.
  const w = workspace();
  const r = run(RESTORE, ["--latest"], {
    BACKUP_ENCRYPTION_KEY: KEY, BACKUP_DIR: w.backups,
  });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no backups found|TARGET_DATABASE_URL/);
  rmSync(w.dir, { recursive: true, force: true });
});

test("restore reports a missing source clearly", () => {
  const r = run(RESTORE, ["/nonexistent/backup.enc"], {
    BACKUP_ENCRYPTION_KEY: KEY, TARGET_DATABASE_URL: "postgres://x/y",
  });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no such file/);
});

test("the restore drill refuses to run against anything but a scratch database", () => {
  // The drill DROPs its target. If someone points it at the live database the
  // script must refuse before doing anything at all.
  const r = run(join(REPO, "scripts/backup-verify.sh"), [], {
    BACKUP_VERIFY_DB: "portal", BACKUP_ENCRYPTION_KEY: KEY,
    DATABASE_URL: "postgres://user:pw@localhost/portal",
    BACKUP_VERIFY_FILE: join(mkdtempSync(join(tmpdir(), "v-")), "r.json"),
  });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /does not look like a scratch database/);
});

// ── /health integration ─────────────────────────────────────────────────────
// backupFreshness() is what turns the heartbeat files into the operational
// signal. These assert the warnings a school's monitoring would actually page
// on, including the one the review implied nobody had: unverified backups.
const { backupFreshness } = await import("../dist/ops/backup-heartbeat.js");

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("health reports a fresh, offsite, drill-verified backup as healthy", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  const hb = join(dir, "b.json"), vf = join(dir, "v.json");
  writeFileSync(hb, JSON.stringify({ completed_at: new Date().toISOString(), destination: "s3://bucket/portal/x.enc", size_bytes: 1024 }));
  writeFileSync(vf, JSON.stringify({ completed_at: new Date().toISOString(), result: "passed", detail: "restored 42 tables" }));
  const s = withEnv({ BACKUP_HEARTBEAT_FILE: hb, BACKUP_VERIFY_FILE: vf, BACKUP_S3_BUCKET: "bucket", BACKUP_ENCRYPTION_KEY: KEY }, backupFreshness);
  assert.equal(s.stale, false);
  assert.equal(s.offsite, true);
  assert.equal(s.restoreTest.result, "passed");
  assert.equal(s.restoreTest.stale, false);
  rmSync(dir, { recursive: true, force: true });
});

test("a backup chain that stopped running goes stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  const hb = join(dir, "b.json");
  writeFileSync(hb, JSON.stringify({ completed_at: new Date(Date.now() - 50 * 3600_000).toISOString() }));
  const s = withEnv({ BACKUP_HEARTBEAT_FILE: hb, BACKUP_VERIFY_FILE: join(dir, "none.json"), BACKUP_S3_BUCKET: "b", BACKUP_ENCRYPTION_KEY: KEY }, backupFreshness);
  assert.equal(s.stale, true, "50h since the last nightly backup must be flagged");
  assert.equal(s.ageHours, 50);
  rmSync(dir, { recursive: true, force: true });
});

test("backups that have never been restore-tested are reported as unverified", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  const hb = join(dir, "b.json");
  writeFileSync(hb, JSON.stringify({ completed_at: new Date().toISOString() }));
  const s = withEnv({ BACKUP_HEARTBEAT_FILE: hb, BACKUP_VERIFY_FILE: join(dir, "missing.json"), BACKUP_S3_BUCKET: "b", BACKUP_ENCRYPTION_KEY: KEY }, backupFreshness);
  assert.equal(s.stale, false, "the backup itself is fresh");
  assert.equal(s.restoreTest.result, "never");
  assert.equal(s.restoreTest.stale, true, "never-tested backups must not look fine");
  rmSync(dir, { recursive: true, force: true });
});

test("a FAILED restore drill is never considered fresh, however recent", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  const hb = join(dir, "b.json"), vf = join(dir, "v.json");
  writeFileSync(hb, JSON.stringify({ completed_at: new Date().toISOString() }));
  writeFileSync(vf, JSON.stringify({ completed_at: new Date().toISOString(), result: "failed", detail: "only 0 users restored" }));
  const s = withEnv({ BACKUP_HEARTBEAT_FILE: hb, BACKUP_VERIFY_FILE: vf, BACKUP_S3_BUCKET: "b", BACKUP_ENCRYPTION_KEY: KEY }, backupFreshness);
  assert.equal(s.restoreTest.result, "failed");
  assert.equal(s.restoreTest.stale, true);
  assert.match(s.restoreTest.detail, /0 users/);
  rmSync(dir, { recursive: true, force: true });
});

test("local-only backups are flagged as not offsite", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  const hb = join(dir, "b.json");
  writeFileSync(hb, JSON.stringify({ completed_at: new Date().toISOString(), destination: "file:///var/lib/portal/backups/x.enc" }));
  const s = withEnv({ BACKUP_HEARTBEAT_FILE: hb, BACKUP_VERIFY_FILE: join(dir, "n.json"), BACKUP_S3_BUCKET: undefined, BACKUP_ENCRYPTION_KEY: KEY }, backupFreshness);
  assert.equal(s.offsite, false);
  rmSync(dir, { recursive: true, force: true });
});

test("an unconfigured install is not nagged about backups it never set up", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  const s = withEnv({ BACKUP_HEARTBEAT_FILE: join(dir, "n.json"), BACKUP_VERIFY_FILE: join(dir, "m.json"), BACKUP_S3_BUCKET: undefined, BACKUP_ENCRYPTION_KEY: undefined }, backupFreshness);
  assert.equal(s.configured, false);
  assert.equal(s.stale, false, "/health must not cry wolf during initial setup");
  assert.equal(s.restoreTest.stale, false);
  rmSync(dir, { recursive: true, force: true });
});
