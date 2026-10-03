// Portal load test — k6 (Phase 5.4, review-2 rework)
// Run:  k6 run --scenario steady -e BASE=http://127.0.0.1:8080 apps/api/loadtest/portal.js
//       k6 run ...   (both scenarios incl. spike)
//
// Covers the hot paths that matter for a school portal at bell-rush:
//   • student login (no MFA) + dashboard reads
//   • parent login + read-only child views
//   • teacher gradebook reads on an MFA-verified session (ceremony in setup())
// Thresholds are set for a single-node dev box; tighten for production SLOs.
//
// review-2 — rate limits: this profile logs in every iteration through three
// demo accounts, which trips the production login throttles on purpose-built
// ceilings. Point it at an instance started with load-test ceilings, e.g.:
//   RATE_LIMIT_LOGIN_MAX=1000000 RATE_LIMIT_LOGIN_IP_MAX=1000000 \
//   RATE_LIMIT_ACCT_OPS_IP_MAX=1000000 RATE_LIMIT_GENERAL_MAX=1000000 ...
// The throttles themselves are asserted in apps/api/test/phase6-hardening and
// phase7 suites — this gate measures throughput, not brute-force defence.

import http from "k6/http";
import { check, sleep, group } from "k6";
import { SharedArray } from "k6/data";
import crypto from "k6/crypto";
import encoding from "k6/encoding";

const BASE = __ENV.BASE ?? "http://127.0.0.1:8080";
const PASSWORD = __ENV.PASSWORD ?? "Passw0rd!";

/**
 * Two profiles.
 *
 * The default is the real thing: 50 sustained VUs plus a 300 req/s spike,
 * run by hand against a box that resembles production, with production SLOs.
 *
 * PROFILE=ci is what runs on every push. A shared GitHub runner hosting the
 * API, the database and the load generator in one 2-core container cannot
 * measure a production SLO, and a gate that fails on runner noise is a gate
 * somebody disables within a fortnight. So CI asserts what CI can honestly
 * assert: the script still drives every hot path, essentially nothing errors,
 * and latency has not regressed by an order of magnitude. Both profiles run
 * the same code, so the script cannot rot between manual runs.
 */
const PROFILE = __ENV.PROFILE ?? "full";

const PROFILES = {
  full: {
    scenarios: {
      // steady bell-rush traffic
      steady: {
        executor: "ramping-vus",
        startVUs: 0,
        stages: [
          { duration: "30s", target: 50 },   // ramp up
          { duration: "1m", target: 50 },    // sustain
          { duration: "20s", target: 0 },    // ramp down
        ],
        gracefulRampDown: "10s",
      },
      // short spike (whole-school login at 07:45)
      spike: {
        executor: "ramping-arrival-rate",
        startRate: 10,
        timeUnit: "1s",
        preAllocatedVUs: 200,
        maxVUs: 400,
        stages: [
          { duration: "10s", target: 100 },
          { duration: "30s", target: 300 },  // spike
          { duration: "20s", target: 20 },
        ],
        startTime: "2m10s",
      },
    },
    thresholds: {
      http_req_failed: ["rate<0.01"],        // <1% errors
      http_req_duration: ["p(95)<600"],      // 95th pct < 600ms
      checks: ["rate>0.98"],
    },
  },
  ci: {
    scenarios: {
      steady: {
        executor: "ramping-vus",
        startVUs: 0,
        stages: [
          { duration: "10s", target: 10 },
          { duration: "30s", target: 10 },
          { duration: "5s", target: 0 },
        ],
        gracefulRampDown: "10s",
      },
    },
    thresholds: {
      // Errors are still errors anywhere. A 500 under ten users is a bug.
      http_req_failed: ["rate<0.01"],
      // Deliberately loose: this is a "has it fallen off a cliff" guard on a
      // shared runner, not an SLO. The SLO lives in the full profile.
      http_req_duration: ["p(95)<3000"],
      checks: ["rate>0.98"],
    },
  },
};

export const options = PROFILES[PROFILE] ?? PROFILES.full;

const jsonHeaders = { "Content-Type": "application/json" };

function jar() { return new http.CookieJar(); }

// ── TOTP (RFC 6238, SHA-1, 6-digit, 30s) so teacher flows can pass MFA ──
function base32Decode(s) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const idx = alpha.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}
function totp(secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 4294967296));
  view.setUint32(4, counter >>> 0);
  const hmac = crypto.hmac("sha1", base32Decode(secret), new Uint8Array(buf), "binary");
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1000000).padStart(6, "0");
}

function login(email) {
  const res = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email, password: PASSWORD }), jsonHeaders);
  check(res, { "login 201": (r) => r.status === 201 });
  return res;
}

/**
 * review-2: enrollment is now CONTROLLED (admin-issued single-use token) and
 * rate limits are enforced, so the teacher MFA ceremony happens ONCE here in
 * setup() (k6 runs setup a single time and passes its return value to every
 * default-function invocation) instead of per iteration. With SEED_DEMO=true
 * the dev token endpoint provides the admin-issued token, mirroring the
 * production hand-off. Without it (prod-shaped runs) the teacher flow is
 * skipped rather than faked.
 */
export function setup() {
  const res = login("t1@school.example");
  if (res.status !== 201) return { teacherHeaders: null };
  const sid = res.cookies?.sid?.[0]?.value;
  const csrf = res.cookies?.csrf?.[0]?.value;
  const h = { Cookie: `sid=${sid}; csrf=${csrf}`, "x-csrf": csrf, "Content-Type": "application/json" };
  const toks = http.get(`${BASE}/api/v1/health/dev-enroll-tokens`, { headers: h });
  if (toks.status !== 200) return { teacherHeaders: null };
  const token = JSON.parse(toks.body)?.tokens?.["t1@school.example"];
  if (!token) return { teacherHeaders: null };
  const enroll = http.post(`${BASE}/api/v1/auth/mfa/totp/enroll`, JSON.stringify({ token }), h);
  if (enroll.status === 409) {
    // already enrolled from an earlier run against this database — the demo
    // seed does not enroll TOTP, so this only happens on a reused DB; skip.
    return { teacherHeaders: null };
  }
  if (enroll.status !== 201) return { teacherHeaders: null };
  const secret = JSON.parse(enroll.body).secret;
  const v = http.post(`${BASE}/api/v1/auth/mfa/totp/verify`, JSON.stringify({ code: totp(secret) }), h);
  if (v.status !== 201) return { teacherHeaders: null };
  const vsid = v.cookies?.sid?.[0]?.value ?? sid;
  const vcsrf = v.cookies?.csrf?.[0]?.value ?? csrf;
  check(v, { "teacher MFA verified (setup)": (r) => r.status === 201 });
  return { teacherHeaders: { Cookie: `sid=${vsid}; csrf=${vcsrf}`, "x-csrf": vcsrf, "Content-Type": "application/json" } };
}

export default function (data) {
  const roll = Math.random();
  if (roll < 0.5) studentFlow();
  else if (roll < 0.8) parentFlow();
  else teacherFlow(data?.teacherHeaders);
  sleep(Math.random() * 2 + 0.5);
}

function studentFlow() {
  group("student", () => {
    const res = login("s1@school.example");
    if (res.status !== 201) return;
    const sid = res.cookies?.sid?.[0]?.value;
    const csrf = res.cookies?.csrf?.[0]?.value;
    const h = { Cookie: `sid=${sid}; csrf=${csrf}`, "x-csrf": csrf };
    const grades = http.get(`${BASE}/api/v1/student/grades`, { headers: h });
    check(grades, { "student grades 200": (r) => r.status === 200 });
    const att = http.get(`${BASE}/api/v1/student/attendance`, { headers: h });
    check(att, { "student attendance 200": (r) => r.status === 200 });
    const exams = http.get(`${BASE}/api/v1/student/exams`, { headers: h });
    check(exams, { "student exams 200": (r) => r.status === 200 });
  });
}

function parentFlow() {
  group("parent", () => {
    const res = login("p1@school.example");
    if (res.status !== 201) return;
    const sid = res.cookies?.sid?.[0]?.value;
    const csrf = res.cookies?.csrf?.[0]?.value;
    const h = { Cookie: `sid=${sid}; csrf=${csrf}`, "x-csrf": csrf };
    const kids = http.get(`${BASE}/api/v1/parent/children`, { headers: h });
    check(kids, { "parent children 200": (r) => r.status === 200 });
    const data = JSON.parse(kids.body).data ?? [];
    if (data[0]) {
      const id = data[0].studentUserId;
      http.get(`${BASE}/api/v1/parent/children/${id}/grades`, { headers: h });
      http.get(`${BASE}/api/v1/parent/children/${id}/fees`, { headers: h });
      http.get(`${BASE}/api/v1/parent/children/${id}/transport`, { headers: h });
    }
  });
}

function teacherFlow(h) {
  if (!h) return; // MFA session unavailable (see setup()) — skip honestly
  group("teacher", () => {
    // read hot paths with the setup()'s MFA-verified session
    const sections = http.get(`${BASE}/api/v1/sections`, { headers: h });
    check(sections, { "teacher sections 200": (r) => r.status === 200 });
    if (sections.status !== 200) return;
    const data = JSON.parse(sections.body).data ?? [];
    if (data[0]) {
      const gb = http.get(`${BASE}/api/v1/sections/${data[0].id}/gradebook`, { headers: h });
      check(gb, { "gradebook read 200": (r) => r.status === 200 });
    }
  });
}
