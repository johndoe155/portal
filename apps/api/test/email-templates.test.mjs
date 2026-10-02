/**
 * Email template golden tests.
 *
 * The bug these exist to prevent: every email body used to be
 * `JSON.stringify(payload, null, 2)`. The assertions below are deliberately
 * about *user-visible quality*, not implementation:
 *   - no raw JSON ever reaches a recipient;
 *   - every actionable mail contains a real, clickable, absolute link;
 *   - attacker-influenced data (display names, from a school's CSV) is escaped;
 *   - secrets never leak into a mail that shouldn't carry them;
 *   - both MIME parts exist and say the same thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { renderEmail, CRITICAL_KINDS } = require("../dist/notify/templates/index.js");
const { esc, safeUrl, humanDuration } = require("../dist/notify/templates/layout.js");
const { isPermanentFailure, parseSmtpUrl, resolveFrom } = require("../dist/notify/mailer.js");
const { nextAttemptDelayMs } = require("../dist/notify/notify.service.js");

const BRAND = {
  schoolName: "Greenfield High School",
  logoUrl: "https://cdn.school.ng/logo.png",
  primaryColor: "#15803d",
  contactEmail: "office@school.ng",
  dpoEmail: "dpo@school.ng",
  webOrigin: "https://portal.school.ng",
};
const CTX = { brand: BRAND, recipientName: "Amara Okafor", timezone: "Africa/Lagos" };

const ALL_KINDS = [
  ["password_reset", { link: "https://portal.school.ng/reset?token=abc123" }],
  ["user_invite", { display_name: "Amara", acceptUrl: "https://portal.school.ng/invite?token=t1", roles: ["teacher"] }],
  ["mfa_enroll_token", { token: "ENROLLTOKEN123", expiresHours: 24 }],
  ["guardian_verify", { display_name: "Amara", verifyUrl: "https://portal.school.ng/parent/verify?token=v1" }],
  ["absence_recorded", { student_user_id: "u1", date: "2026-10-02", section_id: "s1" }],
  ["grade_released", { section_id: "s1", date: "2026-10-02" }],
  ["message_received", { thread_id: "t1", subject: "Parents evening" }],
  ["daily_digest", { date: "2026-10-02", absences: 2, gradesReleased: 1 }],
  ["account_deactivated", {}],
  ["totally_unknown_kind", { secret: "should-not-appear" }],
];

test("every template renders both MIME parts with a subject", () => {
  for (const [kind, payload] of ALL_KINDS) {
    const out = renderEmail(kind, payload, CTX);
    assert.ok(out.subject && out.subject.length > 3, `${kind}: subject`);
    assert.ok(out.text && out.text.length > 50, `${kind}: text part`);
    assert.ok(out.html && out.html.includes("<!DOCTYPE html>"), `${kind}: html part`);
    assert.ok(out.html.includes(BRAND.schoolName), `${kind}: branded`);
    assert.ok(!/undefined|null|\[object Object\]/.test(out.subject), `${kind}: clean subject`);
  }
});

test("no email is a raw JSON dump (the original bug)", () => {
  for (const [kind, payload] of ALL_KINDS) {
    const { text, html } = renderEmail(kind, payload, CTX);
    // The old body looked like: {\n  "link": "https://…"\n}
    assert.ok(!/^\s*\{[\s\S]*"\w+":/m.test(text), `${kind}: text contains a JSON object`);
    assert.ok(!text.includes('":'), `${kind}: text has JSON key syntax`);
    assert.ok(!html.includes('&quot;:'), `${kind}: html has escaped JSON syntax`);
  }
});

test("actionable emails carry a real absolute link", () => {
  const cases = [
    ["password_reset", { link: "https://portal.school.ng/reset?token=abc123" }, "/reset?token=abc123"],
    ["user_invite", { acceptUrl: "https://portal.school.ng/invite?token=t1" }, "/invite?token=t1"],
    ["guardian_verify", { verifyUrl: "https://portal.school.ng/parent/verify?token=v1" }, "/parent/verify?token=v1"],
  ];
  for (const [kind, payload, fragment] of cases) {
    const { text, html } = renderEmail(kind, payload, CTX);
    assert.ok(text.includes(`https://portal.school.ng${fragment}`), `${kind}: link in text`);
    assert.ok(html.includes(`href="https://portal.school.ng${fragment}"`), `${kind}: anchor in html`);
    // The raw URL is also printed, for clients that strip buttons.
    assert.ok(html.includes("copy this address into your browser"), `${kind}: plain-link fallback`);
  }
});

test("mfa enrolment deep-links to the prefilled enrolment screen", () => {
  const { text, html } = renderEmail("mfa_enroll_token", { token: "TOK-123", expiresHours: 24 }, CTX);
  assert.ok(text.includes("https://portal.school.ng/mfa?token=TOK-123"), "deep link in text");
  assert.ok(html.includes("/mfa?token=TOK-123"), "deep link in html");
  assert.ok(text.includes("TOK-123"), "manual-entry fallback token present");
  assert.ok(/24 hours/.test(text), "expiry stated in words");
});

test("expiry windows are stated in plain English, not milliseconds", () => {
  const { text } = renderEmail("password_reset", { link: "https://portal.school.ng/reset?token=x", ttlMs: 3600000 }, CTX);
  assert.ok(/expires in 1 hour/.test(text), text.slice(0, 400));
  assert.equal(humanDuration(3_600_000), "1 hour");
  assert.equal(humanDuration(86_400_000), "24 hours");
  assert.equal(humanDuration(7 * 86_400_000), "7 days");
});

test("attacker-influenced display names are escaped in HTML", () => {
  // Display names come from a CSV the school uploads — treat as hostile.
  const evil = '<script>alert("xss")</script>';
  const { html, text } = renderEmail("user_invite",
    { acceptUrl: "https://portal.school.ng/invite?token=t" },
    { ...CTX, recipientName: evil });
  assert.ok(!html.includes("<script>"), "raw script tag must not survive");
  assert.ok(html.includes("&lt;script&gt;"), "escaped form present");
  assert.ok(text.includes(evil), "plain text is not HTML, so it may contain the literal");
});

test("a hostile school name cannot break out of the HTML layout", () => {
  const { html } = renderEmail("daily_digest", { date: "2026-10-02" },
    { ...CTX, brand: { ...BRAND, schoolName: '"><img src=x onerror=alert(1)>' } });
  assert.ok(!html.includes("<img src=x"), "injected tag must be escaped");
  assert.ok(html.includes("&lt;img"), "escaped form present");
});

test("non-http link schemes are never rendered as anchors", () => {
  const { html, text } = renderEmail("password_reset", { link: "javascript:alert(1)" }, CTX);
  assert.ok(!html.includes("javascript:"), "javascript: URL must not become an href");
  assert.ok(!text.includes("javascript:"), "nor appear in the text part");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,x"), null);
  assert.equal(safeUrl("https://ok.example/x"), "https://ok.example/x");
});

test("unknown kinds degrade gracefully and never leak the payload", () => {
  const { subject, text } = renderEmail("some_future_kind", { token: "SUPERSECRET", link: "x" }, CTX);
  assert.ok(subject.includes("Greenfield High School"));
  assert.ok(!text.includes("SUPERSECRET"), "payload must not leak through the fallback");
  assert.ok(text.includes("https://portal.school.ng"), "still points the user at the portal");
});

test("resolved names replace raw UUIDs in day-to-day alerts", () => {
  const raw = renderEmail("absence_recorded",
    { student_user_id: "7f3a1b2c-0000-4000-8000-000000000001", date: "2026-10-02", section_id: "abc" }, CTX);
  assert.ok(!raw.text.includes("7f3a1b2c"), "UUID must never reach a parent");

  const resolved = renderEmail("absence_recorded",
    { student_user_id: "7f3a1b2c", date: "2026-10-02", section_id: "abc" },
    { ...CTX, resolved: { studentName: "Chidi Okafor", courseTitle: "Mathematics" } });
  assert.ok(resolved.text.includes("Chidi Okafor"), "student named");
  assert.ok(resolved.text.includes("Mathematics"), "subject named");
  assert.ok(resolved.subject.includes("Chidi Okafor"));
  // The plain-text part soft-wraps at 72 columns, so normalise whitespace
  // before matching — the date may legitimately straddle a line break.
  const flat = resolved.text.replace(/\s+/g, " ");
  assert.ok(flat.includes("Friday, 2 October 2026"), `date humanised: ${flat.slice(0, 200)}`);
});

test("security mail has no unsubscribe header; bulk mail does", () => {
  for (const kind of ["password_reset", "user_invite", "mfa_enroll_token", "guardian_verify"]) {
    const { headers } = renderEmail(kind, { link: "https://portal.school.ng/x", token: "t" }, CTX);
    assert.ok(!headers["List-Unsubscribe"], `${kind}: must not be unsubscribable`);
    assert.equal(headers["Auto-Submitted"], "auto-generated");
    assert.ok(CRITICAL_KINDS.has(kind), `${kind} should be flagged critical`);
  }
  for (const kind of ["daily_digest", "absence_recorded", "grade_released"]) {
    const { headers } = renderEmail(kind, { date: "2026-10-02" }, CTX);
    assert.ok(headers["List-Unsubscribe"], `${kind}: should offer unsubscribe`);
  }
});

test("every email explains why it was received and who to contact", () => {
  for (const [kind, payload] of ALL_KINDS) {
    const { text, html } = renderEmail(kind, payload, CTX);
    assert.ok(/You received this because/.test(text), `${kind}: text reason`);
    assert.ok(html.includes("You received this because"), `${kind}: html reason`);
    assert.ok(text.includes("office@school.ng"), `${kind}: contact address`);
  }
});

test("missing optional branding degrades without crashing", () => {
  const bare = { schoolName: "X", primaryColor: "not-a-colour", webOrigin: "https://p.example" };
  for (const [kind, payload] of ALL_KINDS) {
    const out = renderEmail(kind, payload, { brand: bare, recipientName: "A", timezone: "UTC" });
    assert.ok(out.html.includes("#1d4ed8"), `${kind}: falls back to the default accent`);
    assert.ok(!out.html.includes("not-a-colour"), `${kind}: rejects an invalid colour`);
  }
});

/* ── retry / SMTP classification ───────────────────────────────────────── */

test("permanent SMTP failures are distinguished from transient ones", () => {
  for (const e of [
    { responseCode: 550, message: "550 5.1.1 no such user" },
    new Error("Recipient address rejected: user unknown"),
    new Error("recipient not found"),
    { responseCode: 553, message: "mailbox unavailable" },
  ]) assert.equal(isPermanentFailure(e), true, `should be permanent: ${e.message}`);

  for (const e of [
    { responseCode: 421, message: "421 service not available" },
    new Error("ECONNREFUSED"),
    new Error("Connection timeout"),
    { responseCode: 450, message: "450 4.2.1 mailbox busy" },
  ]) assert.equal(isPermanentFailure(e), false, `should be transient: ${e.message}`);
});

test("backoff grows and stays jittered within bounds", () => {
  const expected = [1, 5, 15, 60, 240, 720];
  for (let attempt = 1; attempt <= 6; attempt++) {
    const base = expected[attempt - 1] * 60_000;
    for (let i = 0; i < 25; i++) {
      const d = nextAttemptDelayMs(attempt);
      assert.ok(d >= base * 0.8 - 1 && d <= base * 1.2 + 1, `attempt ${attempt}: ${d} outside ±20% of ${base}`);
      assert.ok(d >= 30_000, "never retries faster than 30s");
    }
  }
  // Beyond the table, the delay is clamped to the last bucket, not unbounded.
  assert.ok(nextAttemptDelayMs(99) <= 720 * 60_000 * 1.2 + 1);
});

test("SMTP_URL parsing picks the right port, TLS mode and credentials", () => {
  const implicit = parseSmtpUrl("smtps://user:p%40ss@smtp.example.com:465");
  assert.deepEqual(implicit, {
    host: "smtp.example.com", port: 465, secure: true,
    requireTLS: false, auth: { user: "user", pass: "p@ss" },
  });

  const starttls = parseSmtpUrl("smtp://api:key@smtp.example.com:587");
  assert.equal(starttls.secure, false);
  assert.equal(starttls.port, 587);
  assert.equal(starttls.requireTLS, true, "STARTTLS must be required, not optional");

  assert.equal(parseSmtpUrl("smtps://h.example").port, 465, "default implicit-TLS port");
  assert.equal(parseSmtpUrl("smtp://h.example").port, 587, "default submission port");
  assert.throws(() => parseSmtpUrl("not a url"), /not a valid URL/);
});

test("From address prefers the school setting over the env default", () => {
  process.env.MAIL_FROM = "Fallback <fallback@example.com>";
  assert.equal(resolveFrom("School <school@example.ng>"), "School <school@example.ng>");
  assert.equal(resolveFrom(null), "Fallback <fallback@example.com>");
  delete process.env.MAIL_FROM;
  assert.match(resolveFrom(null), /portal@school\.example/);
});

test("escape helper covers the characters that matter", () => {
  assert.equal(esc(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(42), "42");
});
