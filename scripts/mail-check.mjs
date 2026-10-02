/**
 * Ops CLI — prove email works BEFORE the school goes live.
 *
 *   SMTP_URL=smtps://user:pass@smtp.example:465 \
 *   MAIL_FROM='School Portal <portal@school.ng>' \
 *     node scripts/mail-check.mjs headteacher@school.ng
 *
 * It does three things, in order, and stops at the first failure:
 *   1. parses SMTP_URL and reports what it will connect to (password redacted);
 *   2. runs the SMTP handshake + auth (nodemailer verify());
 *   3. sends a real message rendered through the portal's own templates, so
 *      what lands in the inbox is exactly what a parent would receive.
 *
 * Then check the result at https://www.mail-tester.com or inspect the received
 * headers for  spf=pass  dkim=pass  dmarc=pass.  See docs/email-setup.md.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const to = process.argv[2];
if (!to || !to.includes("@")) {
  console.error("usage: node scripts/mail-check.mjs <recipient@example.com>");
  process.exit(1);
}

let mailer, templates;
try {
  mailer = require("../apps/api/dist/notify/mailer.js");
  templates = require("../apps/api/dist/notify/templates/index.js");
} catch {
  console.error("Build the API first:  npm run build -w @portal/api");
  process.exit(1);
}

if (!process.env.SMTP_URL) {
  console.error("✗ SMTP_URL is not set.");
  console.error("  Without it the portal cannot send password resets, invites or");
  console.error("  guardian verifications. The API refuses to boot in production.");
  console.error("  Example: SMTP_URL=smtps://apikey:SECRET@smtp.provider.com:465");
  process.exit(1);
}

/* ── 1. what are we connecting to? ─────────────────────────────────────── */
let parsed;
try {
  parsed = mailer.parseSmtpUrl(process.env.SMTP_URL);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
console.log("SMTP target");
console.log(`  host      ${parsed.host}`);
console.log(`  port      ${parsed.port}`);
console.log(`  mode      ${parsed.secure ? "implicit TLS (SMTPS)" : "STARTTLS (required)"}`);
console.log(`  auth user ${parsed.auth?.user ?? "(none)"}`);
console.log(`  from      ${mailer.resolveFrom(null)}`);
console.log("");

const from = mailer.resolveFrom(null);
const fromDomain = (from.match(/@([^>\s]+)/) ?? [])[1];

/* ── 2. handshake + auth ───────────────────────────────────────────────── */
const transport = mailer.createMailer();
process.stdout.write("Verifying SMTP connection… ");
const verdict = await mailer.verifyMailer(transport);
if (!verdict.ok) {
  console.log("FAILED");
  console.error(`✗ ${verdict.error}`);
  console.error("");
  console.error("Common causes:");
  console.error("  • wrong port — 465 needs smtps://, 587 needs smtp:// (STARTTLS)");
  console.error("  • credentials rejected — many providers need an API key, not the mailbox password");
  console.error("  • outbound 25/465/587 blocked by the host's firewall");
  process.exit(1);
}
console.log("ok");

/* ── 3. send a real, templated message ─────────────────────────────────── */
const rendered = templates.renderEmail("password_reset", {
  link: `${process.env.PUBLIC_WEB_ORIGIN ?? "https://portal.school.example"}/reset?token=MAIL-CHECK-EXAMPLE`,
}, {
  brand: {
    schoolName: process.env.MAIL_CHECK_SCHOOL ?? "School Portal",
    primaryColor: "#1d4ed8",
    contactEmail: null,
    webOrigin: process.env.PUBLIC_WEB_ORIGIN ?? "https://portal.school.example",
  },
  recipientName: "Deliverability check",
  timezone: "Africa/Lagos",
});

process.stdout.write(`Sending test message to ${to}… `);
try {
  const info = await transport.sendMail({
    from,
    to,
    subject: `[test] ${rendered.subject}`,
    text: rendered.text,
    html: rendered.html,
    headers: rendered.headers,
  });
  console.log("ok");
  console.log(`  message id  ${info.messageId ?? "(none)"}`);
  if (info.accepted?.length) console.log(`  accepted    ${info.accepted.join(", ")}`);
  if (info.rejected?.length) console.log(`  rejected    ${info.rejected.join(", ")}`);
  if (info.response) console.log(`  response    ${info.response}`);
} catch (err) {
  console.log("FAILED");
  console.error(`✗ ${err.message}`);
  console.error(mailer.isPermanentFailure(err)
    ? "  This is a PERMANENT failure — the portal would not retry it."
    : "  This is a TRANSIENT failure — the portal would retry with backoff.");
  process.exit(1);
}
transport.close?.();

console.log("");
console.log("Next, and this is the part that decides whether mail reaches inboxes:");
console.log(`  1. Open the message and view its original/source headers.`);
console.log(`  2. Confirm all three:  spf=pass   dkim=pass   dmarc=pass`);
if (fromDomain) {
  console.log(`  3. Check the sending domain's DNS:`);
  console.log(`       dig +short TXT ${fromDomain}`);
  console.log(`       dig +short TXT _dmarc.${fromDomain}`);
}
console.log(`  4. Score the message at https://www.mail-tester.com (aim for 9/10+).`);
console.log("");
console.log("Exact DNS records to publish: docs/email-setup.md");
