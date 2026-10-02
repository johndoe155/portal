// Round-4 live verification (review-4 #2 + #3) against the running stack:
//   web :3000 → api :8080 → real Postgres 17 + mock Paystack :9311
// 1. pending checkout reuse: re-initiating an unpaid invoice returns the SAME
//    reference + checkout_url (no second Paystack Initialize call)
// 2. remaining-balance: after a partial cash payment, initiate charges only the
//    remainder; after full settlement, initiate is refused (invoice_not_payable)
import { createHmac } from "node:crypto";

const WEB = "http://127.0.0.1:3000";
const SECRET = "sk_test_dev_secret";
const hmac = (b) => createHmac("sha512", SECRET).update(b).digest("hex");

// simpler jar (matches smoke.mjs)
function jar2() {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    feed: (setCookies) => { for (const c of setCookies) { const [kv] = c.split(";"); const i = kv.indexOf("="); m.set(kv.slice(0, i).trim(), kv.slice(i + 1)); } },
    header: () => [...m].map(([k, v]) => `${k}=${v}`).join("; "),
    _map: m,
  };
}
async function req2(j, path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  const cookie = j.header(); if (cookie) headers.cookie = cookie;
  if (opts.body) headers["content-type"] = "application/json";
  const csrf = j._map.get("portal_csrf") ?? j._map.get("csrf"); if (csrf) headers["x-csrf"] = csrf;
  const res = await fetch(WEB + path, { ...opts, headers, redirect: "manual" });
  j.feed(res.headers.getSetCookie?.() ?? []);
  const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? (pass++, console.log("PASS", name)) : (fail++, console.log("FAIL", name, extra)); };

const { totpCode } = await import("../../api/dist/crypto/totp.js");

const ja = jar2();
await req2(ja, "/", {}); // pick up csrf cookie
const login = await req2(ja, "/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email: "admin@school.example", password: "Passw0rd!" }) });
ok("admin login", login.status === 200 || login.status === 201, JSON.stringify(login.body).slice(0, 120));

// staff sessions are MFA-gated (SEED_DEMO dev tokens + enroll + verify)
const devTok = await req2(ja, "/api/v1/health/dev-enroll-tokens", {});
const enroll = await req2(ja, "/api/v1/auth/mfa/totp/enroll", { method: "POST", body: JSON.stringify({ token: devTok.body.tokens["admin@school.example"] }) });
const verify = await req2(ja, "/api/v1/auth/mfa/totp/verify", { method: "POST", body: JSON.stringify({ code: totpCode(enroll.body.secret) }) });
ok("MFA enrolled + verified", verify.status === 201 && verify.body.mfaVerified === true, JSON.stringify(verify.body).slice(0, 120));

const terms = await req2(ja, "/api/v1/terms", {});
const TERM_ID = terms.body?.data?.[0]?.id;
const users = await req2(ja, "/api/v1/users", {});
const student = users.body?.data?.find((u) => u.email === "s1@school.example");
ok("fixtures resolved", !!TERM_ID && !!student?.id, JSON.stringify(users.body).slice(0, 160));

// invoice for 500_000 kobo (₦5,000)
const inv = await req2(ja, "/api/v1/fees/invoices", { method: "POST", body: JSON.stringify({ student_user_id: student.id, term_id: TERM_ID, label: `R4 Live ${Date.now()}`, amount_kobo: 500000 }) });
ok("invoice created (500000 kobo)", inv.status === 201, JSON.stringify(inv.body).slice(0, 140));
const INV = inv.body.id;

// admin records a 200_000 kobo cash payment → 300_000 remains
const cash = await req2(ja, `/api/v1/fees/invoices/${INV}/payments`, { method: "POST", body: JSON.stringify({ channel: "cash", amount_kobo: 200000, reference: `CASH-${Date.now()}` }) });
ok("partial cash payment recorded (200000)", cash.status === 201 || cash.status === 200, JSON.stringify(cash.body).slice(0, 140));

// review-4 #3: initiate must charge only the REMAINING 300_000
const init1 = await req2(ja, `/api/v1/fees/invoices/${INV}/initiate`, { method: "POST" });
ok("initiate after partial cash → 201", init1.status === 201, JSON.stringify(init1.body).slice(0, 160));
const REF = init1.body?.reference, URL1 = init1.body?.checkout_url, AC1 = init1.body?.access_code;

// review-4 #2: re-initiate while pending returns the SAME stored checkout (no new Initialize call)
const init2 = await req2(ja, `/api/v1/fees/invoices/${INV}/initiate`, { method: "POST" });
ok("re-initiate reuses stored checkout (same reference+url)",
  init2.status === 201 && init2.body.reference === REF && init2.body.checkout_url === URL1 && init2.body.access_code === AC1,
  `${init2.status} ${JSON.stringify(init2.body).slice(0, 160)}`);

// webhook settles the remaining 300_000 → invoice paid
const whBody = JSON.stringify({ event: "charge.success", data: { reference: REF, amount: 300000, currency: "NGN" } });
const wh = await fetch(`${WEB}/api/v1/webhooks/paystack`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": hmac(whBody) }, body: whBody });
const whJson = await wh.json();
ok("webhook settles remaining balance", wh.status === 201 && whJson.applied === true, `${wh.status} ${JSON.stringify(whJson)}`);

// review-4 #3: fully paid invoice refuses further initiation
const init3 = await req2(ja, `/api/v1/fees/invoices/${INV}/initiate`, { method: "POST" });
ok("initiate on settled invoice → 409 invoice_not_payable",
  init3.status === 409 && init3.body?.code === "invoice_not_payable",
  `${init3.status} ${JSON.stringify(init3.body).slice(0, 160)}`);

/* ── review-4 #5: invite management (list / resend / revoke) live ── */
const invEmail = `r4inv${Date.now()}@school.example`;
const invt = await req2(ja, "/api/v1/invites", { method: "POST", body: JSON.stringify({ email: invEmail, display_name: "R4 Invitee", roles: ["student"], grade_level: 10 }) });
ok("invite issued (dev sink returns token+url)", inv.status === 201 && !!invt.body.inviteToken && !!invt.body.inviteId, JSON.stringify(invt.body).slice(0, 140));
const list = await req2(ja, "/api/v1/invites", {});
ok("pending invites listed", list.status === 200 && list.body.data.some((r) => r.email === invEmail), JSON.stringify(list.body).slice(0, 160));
const resend = await req2(ja, `/api/v1/invites/${invt.body.inviteId}/resend`, { method: "POST" });
ok("resend rotates token (new token ≠ old)", resend.status === 201 && !!resend.body.inviteToken && resend.body.inviteToken !== invt.body.inviteToken, JSON.stringify(resend.body).slice(0, 140));
const stale = await req2(ja, "/api/v1/auth/invite/accept", { method: "POST", body: JSON.stringify({ token: invt.body.inviteToken, password: "R4!Passw0rd123" }) });
ok("old token dead after resend", stale.status === 401, `${stale.status} ${JSON.stringify(stale.body).slice(0, 120)}`);
const revoke = await req2(ja, `/api/v1/invites/${invt.body.inviteId}/revoke`, { method: "POST" });
ok("revoke succeeds", revoke.status === 200 || revoke.status === 201, JSON.stringify(revoke.body).slice(0, 120));
const afterRevoke = await req2(ja, "/api/v1/auth/invite/accept", { method: "POST", body: JSON.stringify({ token: resend.body.inviteToken, password: "R4!Passw0rd123" }) });
ok("revoked invite cannot be accepted", afterRevoke.status === 401, `${afterRevoke.status} ${JSON.stringify(afterRevoke.body).slice(0, 120)}`);
const reinv = await req2(ja, "/api/v1/invites", { method: "POST", body: JSON.stringify({ email: invEmail, display_name: "R4 Invitee", roles: ["student"], grade_level: 10 }) });
ok("revoke unblocks re-invite (row reused)", reinv.status === 201 && reinv.body.inviteId === invt.body.inviteId, `${reinv.status} ${JSON.stringify(reinv.body).slice(0, 140)}`);
const adminPage = await req2(ja, "/admin/users", {});
// the panel is a client component — prove it's wired in by finding its code in
// the page's JS chunks (heading + the /invites management calls)
let panelWired = adminPage.status === 200;
if (panelWired) {
  const srcs = [...String(adminPage.body).matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1]);
  let found = false;
  for (const s of [...new Set(srcs)]) {
    const js = await (await fetch(WEB + s)).text();
    if (js.includes("Pending invites") && js.includes("/invites/")) { found = true; break; }
  }
  panelWired = found;
}
ok("admin users page ships the pending-invites panel", panelWired, `status ${adminPage.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
