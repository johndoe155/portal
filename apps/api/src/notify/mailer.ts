import { createTransport, type Transporter } from "nodemailer";
import { config } from "../config";

/**
 * SMTP transport.
 *
 * The old `createMailer()` fell back to nodemailer's `jsonTransport` whenever
 * SMTP_URL was unset — INCLUDING in production. The result: a production
 * deployment without SMTP_URL silently discarded every password reset, invite
 * and guardian verification, while marking them `sent`. Nobody would notice
 * until a parent phoned to say the reset link never arrived.
 *
 * Now: missing SMTP_URL is fatal in production, the same way PGlite is fatal
 * in production. Dev keeps the JSON sink.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

/** Thrown for addresses/mailboxes that will never accept mail — no retry. */
export class PermanentMailError extends Error {
  constructor(message: string) { super(message); this.name = "PermanentMailError"; }
}

export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_URL);
}

/**
 * Build the transport. In production an absent SMTP_URL throws: the API and
 * worker refuse to boot rather than pretend to send mail.
 */
export function createMailer(): Transporter {
  const url = process.env.SMTP_URL;
  if (!url) {
    if (config.isProduction) {
      throw new Error(
        "SMTP_URL is required in production — without it every password reset, " +
        "invite and guardian verification would be silently discarded. " +
        "Configure SMTP and publish SPF/DKIM/DMARC (see docs/email-setup.md), " +
        "or run scripts/mail-check.mjs to test a candidate configuration.",
      );
    }
    // dev sink: messages are captured, not sent
    return createTransport({ jsonTransport: true });
  }
  // nodemailer's URL form does not accept pool/timeout options, so the URL is
  // parsed into an options object. Pooling matters: without it every single
  // notification opens a fresh TLS handshake, which most providers throttle.
  return createTransport({
    ...parseSmtpUrl(url),
    pool: true,
    maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS ?? 3),
    maxMessages: Number(process.env.SMTP_MAX_MESSAGES ?? 100),
    // A hung SMTP socket must not wedge the worker tick forever.
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS ?? 10_000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS ?? 10_000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS ?? 30_000),
  });
}

/** smtp(s)://user:pass@host:port[?params] → nodemailer transport options. */
export function parseSmtpUrl(url: string): {
  host: string; port: number; secure: boolean;
  auth?: { user: string; pass: string };
  requireTLS?: boolean;
} {
  let u: URL;
  try { u = new URL(url); }
  catch { throw new Error(`SMTP_URL is not a valid URL: ${url.replace(/:[^:@/]+@/, ":***@")}`); }

  const secure = u.protocol === "smtps:";
  const port = Number(u.port) || (secure ? 465 : 587);
  const out: ReturnType<typeof parseSmtpUrl> = {
    host: u.hostname,
    port,
    secure,
    // Port 587 is STARTTLS: demand the upgrade rather than silently sending
    // credentials in the clear if the server declines.
    requireTLS: !secure,
  };
  if (u.username) {
    out.auth = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
  }
  return out;
}

/**
 * Prove the SMTP credentials at boot rather than at 2am. A bad host, a wrong
 * password or a blocked port surfaces in the deploy log, not in a parent's
 * missing reset email.
 */
export async function verifyMailer(mailer: Transporter): Promise<{ ok: boolean; error?: string }> {
  if (!mailConfigured()) return { ok: false, error: "SMTP_URL not configured" };
  if (process.env.SMTP_VERIFY_ON_BOOT === "false") return { ok: true };
  try {
    await mailer.verify();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Classify an SMTP failure. Retrying a 5.1.1 "no such user" forever wastes the
 * queue and looks like abuse to the receiving server; retrying a dropped
 * connection is exactly what we want.
 *
 * Reference: RFC 3463 enhanced status codes. 5xx = permanent, 4xx = transient.
 */
export function isPermanentFailure(err: any): boolean {
  if (err instanceof PermanentMailError) return true;
  const code = Number(err?.responseCode ?? err?.code);
  if (Number.isFinite(code) && code >= 500 && code < 600) return true;
  const text = String(err?.message ?? err).toLowerCase();
  return (
    /\b5\.[017]\.[0-9]\b/.test(text) ||            // 5.1.x no such user, 5.7.x rejected
    text.includes("no such user") ||
    text.includes("mailbox unavailable") ||
    text.includes("user unknown") ||
    text.includes("recipient address rejected") ||
    text.includes("address does not exist") ||
    text.includes("invalid recipient") ||
    text.includes("recipient not found") ||         // our own lookup failure
    text.includes("no recipient address")
  );
}

/** Build the From header: school setting → MAIL_FROM → dev default. */
export function resolveFrom(schoolSender?: string | null): string {
  return schoolSender || process.env.MAIL_FROM || "School Portal <portal@school.example>";
}
