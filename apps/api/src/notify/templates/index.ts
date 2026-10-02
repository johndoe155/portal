/**
 * One renderer per notification kind.
 *
 * Previously every email body was `JSON.stringify(payload, null, 2)` — a
 * parent resetting their password received a JSON blob with a URL buried in
 * it. Each kind now gets real copy, a real call to action, and an explicit
 * statement of what to do if the message was unexpected.
 *
 * Adding a kind: add a case here and a golden test in
 * test/email-templates.test.mjs. An unknown kind still renders a sane generic
 * message rather than throwing — a template bug must never block the outbox.
 */
import {
  type BrandContext, type Block, type RenderedEmail,
  renderLayout, humanDate, humanDuration, safeUrl,
} from "./layout";

export type { BrandContext, RenderedEmail };

/**
 * Context resolved by the worker before rendering: IDs in the stored payload
 * (section_id, thread_id, student_user_id) are turned into human names, because
 * "Absence recorded in 7f3a-…-c21" helps nobody.
 */
export interface RenderContext {
  brand: BrandContext;
  recipientName: string;
  timezone: string;
  /** Resolved display names, best-effort — templates degrade gracefully. */
  resolved?: {
    studentName?: string | null;
    sectionName?: string | null;
    courseTitle?: string | null;
    threadSubject?: string | null;
  };
}

/** Headers applied to every automated message (RFC 3834 + bulk-mail hygiene). */
function baseHeaders(brand: BrandContext, bulk: boolean): Record<string, string> {
  const h: Record<string, string> = { "Auto-Submitted": "auto-generated" };
  if (bulk) {
    // Digests and alerts are preference-driven, so they carry an unsubscribe
    // affordance. Security mail (resets, invites, MFA) deliberately does not:
    // you cannot opt out of being told your password changed.
    h["List-Unsubscribe"] = `<${brand.webOrigin}/account/notifications>`;
    h["X-Auto-Response-Suppress"] = "OOF, AutoReply";
  }
  return h;
}

export function renderEmail(kind: string, payload: Record<string, unknown>, ctx: RenderContext): RenderedEmail {
  const { brand, recipientName } = ctx;
  const school = brand.schoolName;
  const r = ctx.resolved ?? {};

  switch (kind) {
    /* ── security / account lifecycle ──────────────────────────────────── */

    case "password_reset": {
      const link = safeUrl(payload.link) ?? `${brand.webOrigin}/forgot`;
      const ttl = humanDuration(Number(payload.ttlMs ?? 3_600_000));
      return {
        subject: `Reset your ${school} password`,
        ...renderLayout({
          brand, heading: "Reset your password", greeting: recipientName,
          reason: `You received this because a password reset was requested for your ${school} portal account.`,
          blocks: [
            { p: `We received a request to reset the password for your ${school} portal account. Choose a new password using the button below.` },
            { button: { label: "Choose a new password", url: link } },
            { note: `This link can be used once and expires in ${ttl}.` },
            { p: "If you did not request this, you can safely ignore this email — your password has not changed. If it keeps happening, tell the school office: someone may be trying to access your account." },
          ],
        }),
        headers: baseHeaders(brand, false),
      };
    }

    case "user_invite": {
      const link = safeUrl(payload.acceptUrl);
      const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
      const roleText = roles.map(prettyRole).join(", ");
      return {
        subject: `You've been invited to the ${school} portal`,
        ...renderLayout({
          brand, heading: `Welcome to ${school}`, greeting: recipientName,
          reason: `You received this because a ${school} administrator invited you to the school portal.`,
          blocks: [
            { p: `An administrator has created an account for you on the ${school} portal. Accept the invitation to set your password and sign in.` },
            ...(roleText ? [{ p: `Your access level: ${roleText}.` } as Block] : []),
            ...(link ? [{ button: { label: "Accept invitation", url: link } } as Block] : []),
            { note: "This invitation expires in 7 days. If it lapses, ask the school office to send a new one." },
            { p: "If you were not expecting this invitation, please ignore it and let the school office know." },
          ],
        }),
        headers: baseHeaders(brand, false),
      };
    }

    case "mfa_enroll_token": {
      const token = String(payload.token ?? "");
      const hours = Number(payload.expiresHours ?? 24);
      // The /mfa screen accepts ?token= and prefills the field, so staff can
      // click straight through instead of copying a 32-character string.
      const link = safeUrl(payload.enrollUrl)
        ?? (token ? `${brand.webOrigin}/mfa?token=${encodeURIComponent(token)}` : null);
      return {
        subject: `Set up two-factor authentication for ${school}`,
        ...renderLayout({
          brand, heading: "Set up two-factor authentication", greeting: recipientName,
          reason: `You received this because ${school} requires two-factor authentication on staff accounts.`,
          blocks: [
            { p: `${school} protects staff accounts with two-factor authentication (2FA). You'll need an authenticator app — Microsoft Authenticator, Google Authenticator, 1Password or similar — on your phone.` },
            { p: "Use the link below, then scan the QR code or paste the setup key into your authenticator app. Enter the 6-digit code it shows to finish." },
            ...(link ? [{ button: { label: "Set up 2FA now", url: link } } as Block] : []),
            ...(token ? [{ p: "If you prefer to enter it by hand, your one-time setup token is:" } as Block, { code: token } as Block] : []),
            { note: `This token can be used once and expires in ${hours} hours. Keep it private — treat it like a password.` },
            { p: "Once set up, you'll be asked for a code from your authenticator app each time you sign in. If you lose your phone, contact the school office for a reset." },
          ],
        }),
        headers: baseHeaders(brand, false),
      };
    }

    case "guardian_verify": {
      const link = safeUrl(payload.verifyUrl);
      const student = r.studentName ?? (payload.student_name as string | undefined);
      return {
        subject: `Confirm your parent access — ${school}`,
        ...renderLayout({
          brand, heading: "Confirm your parent access", greeting: recipientName,
          reason: `You received this because a ${school} administrator linked this address to a pupil's record.`,
          blocks: [
            {
              p: student
                ? `${school} has linked your email address to ${student}'s record on the school portal. Confirm the link to see their attendance, grades, fees and messages.`
                : `${school} has linked your email address to a pupil's record on the school portal. Confirm the link to see their attendance, grades, fees and messages.`,
            },
            ...(link ? [{ button: { label: "Confirm and view my child", url: link } } as Block] : []),
            { note: "Until you confirm, no pupil information is visible to this account. This link expires in 7 days." },
            { p: "If you do not recognise this request, do not confirm it — contact the school office immediately so they can remove the link." },
          ],
        }),
        headers: baseHeaders(brand, false),
      };
    }

    case "account_deactivated": {
      return {
        subject: `Your ${school} portal access has ended`,
        ...renderLayout({
          brand, heading: "Your portal access has ended", greeting: recipientName,
          reason: `You received this because your ${school} portal account was deactivated.`,
          blocks: [
            { p: `Your access to the ${school} portal has been deactivated and any active sessions have been signed out.` },
            { p: "Your records are retained by the school in line with its retention policy. If you believe this is a mistake, contact the school office." },
          ],
        }),
        headers: baseHeaders(brand, false),
      };
    }

    /* ── day-to-day school notifications ───────────────────────────────── */

    case "absence_recorded": {
      const when = humanDate(payload.date, ctx.timezone);
      const student = r.studentName ?? "your child";
      const where = r.courseTitle ?? r.sectionName;
      return {
        subject: `Absence recorded for ${r.studentName ?? "your child"} — ${when}`,
        ...renderLayout({
          brand, heading: "Absence recorded", greeting: recipientName,
          reason: `You received this because you are a registered guardian at ${school}.`,
          blocks: [
            {
              p: where
                ? `${student} was marked absent from ${where} on ${when}.`
                : `${student} was marked absent on ${when}.`,
            },
            { p: "If this is unexpected, or you have already told the school, please contact the office so the register can be corrected." },
            { button: { label: "View attendance", url: `${brand.webOrigin}/parent` } },
          ],
        }),
        headers: baseHeaders(brand, true),
      };
    }

    case "grade_released": {
      const when = humanDate(payload.date, ctx.timezone);
      const where = r.courseTitle ?? r.sectionName;
      return {
        subject: where ? `New grades published — ${where}` : "New grades published",
        ...renderLayout({
          brand, heading: "New grades published", greeting: recipientName,
          reason: `You received this because you follow this pupil's progress at ${school}.`,
          blocks: [
            { p: where ? `New grades for ${where} were published on ${when}.` : `New grades were published on ${when}.` },
            { button: { label: "View grades", url: `${brand.webOrigin}/` } },
            { note: "Grades are provisional until the end-of-term report card is issued." },
          ],
        }),
        headers: baseHeaders(brand, true),
      };
    }

    case "message_received": {
      const subject = r.threadSubject ?? String(payload.subject ?? "");
      const threadId = String(payload.thread_id ?? "");
      const url = threadId ? `${brand.webOrigin}/parent/messages/${encodeURIComponent(threadId)}` : `${brand.webOrigin}/parent/messages`;
      return {
        subject: subject ? `New message from ${school}: ${subject}` : `New message from ${school}`,
        ...renderLayout({
          brand, heading: "You have a new message", greeting: recipientName,
          reason: `You received this because you are a registered guardian at ${school}.`,
          blocks: [
            { p: subject ? `A member of staff has sent you a message: "${subject}".` : "A member of staff has sent you a message on the school portal." },
            { p: "For your privacy, the message itself is only readable in the portal." },
            { button: { label: "Read the message", url } },
          ],
        }),
        headers: baseHeaders(brand, true),
      };
    }

    case "daily_digest": {
      const when = humanDate(payload.date, ctx.timezone);
      const absences = Number(payload.absences ?? 0);
      const grades = Number(payload.gradesReleased ?? 0);
      const items: string[] = [];
      if (absences) items.push(`${absences} absence${absences === 1 ? "" : "s"} recorded`);
      if (grades) items.push(`${grades} grade update${grades === 1 ? "" : "s"} published`);
      return {
        subject: `Your ${school} daily summary — ${when}`,
        ...renderLayout({
          brand, heading: "Your daily summary", greeting: recipientName,
          reason: `You received this because daily summaries are enabled for your ${school} account.`,
          blocks: [
            { p: `Here's what happened on ${when}:` },
            { list: items.length ? items : ["No new activity."] },
            { button: { label: "Open the portal", url: brand.webOrigin } },
          ],
        }),
        headers: baseHeaders(brand, true),
      };
    }

    /* ── fallback ──────────────────────────────────────────────────────── */

    default: {
      // Unknown kind: never leak the raw payload (it may hold a token), never
      // throw (that would dead-letter a legitimate notification).
      return {
        subject: `A notification from ${school}`,
        ...renderLayout({
          brand, heading: `A notification from ${school}`, greeting: recipientName,
          reason: `You received this because you have a ${school} portal account.`,
          blocks: [
            { p: "There is an update waiting for you on the school portal." },
            { button: { label: "Open the portal", url: brand.webOrigin } },
          ],
        }),
        headers: baseHeaders(brand, true),
      };
    }
  }
}

function prettyRole(code: string): string {
  return String(code).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Kinds that must never be dropped silently — used by delivery alerting. */
export const CRITICAL_KINDS = new Set([
  "password_reset", "user_invite", "mfa_enroll_token", "guardian_verify",
]);
