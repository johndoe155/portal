/**
 * Shared email layout.
 *
 * Every transactional mail the portal sends is rendered through here so the
 * school's identity (name, colour, logo, reply address) is consistent and
 * configured in ONE place: the `school_settings` row.
 *
 * Design constraints, learned the hard way by every school mail system:
 *   - table-based layout + inline styles — Outlook ignores <style> blocks and
 *     most of flexbox/grid;
 *   - a real plain-text alternative, not a stripped tag soup: some parents
 *     read mail on feature phones and some filters score text/plain absence;
 *   - every interpolation is escaped (`esc`) — a display name is attacker-
 *     influenced data (it comes from a CSV the school uploads);
 *   - links are absolute and built from PUBLIC_WEB_ORIGIN.
 */

export interface BrandContext {
  schoolName: string;
  logoUrl?: string | null;
  primaryColor: string;
  contactEmail?: string | null;
  dpoEmail?: string | null;
  webOrigin: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /** Extra SMTP headers (unsubscribe hints, auto-submitted markers). */
  headers?: Record<string, string>;
}

/** HTML-escape. Applied at every interpolation boundary without exception. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only http(s) links are ever rendered as clickable. A payload that somehow
 * carried `javascript:` or `data:` must not become an anchor href.
 */
export function safeUrl(url: unknown): string | null {
  const s = String(url ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** "1 hour" / "24 hours" / "7 days" — expiries stated in words, not millis. */
export function humanDuration(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 24) return hours === 24 ? "24 hours" : `${hours} hours`;
  if (hours >= 1) return hours === 1 ? "1 hour" : `${hours} hours`;
  const mins = Math.max(1, Math.round(ms / 60_000));
  return mins === 1 ? "1 minute" : `${mins} minutes`;
}

/** Format an ISO date as "Monday, 2 October 2026" for the reader's school tz. */
export function humanDate(value: unknown, timezone = "Africa/Lagos"): string {
  const raw = String(value ?? "");
  const d = raw ? new Date(raw.length === 10 ? `${raw}T12:00:00Z` : raw) : new Date();
  if (Number.isNaN(d.getTime())) return raw || "today";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: timezone,
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export interface Block {
  /** Paragraph of body copy. */
  p?: string;
  /** Call-to-action button. */
  button?: { label: string; url: string };
  /** Monospace fallback (the raw link, a token, a code). */
  code?: string;
  /** Bulleted list. */
  list?: string[];
  /** Muted small print. */
  note?: string;
}

/**
 * Render a message from blocks into both MIME parts at once, so the text and
 * HTML versions can never drift apart.
 */
export function renderLayout(args: {
  brand: BrandContext;
  heading: string;
  greeting?: string;
  blocks: Block[];
  /** Why this person is receiving the mail — required by anti-spam good practice. */
  reason: string;
  /**
   * Preferences page for this recipient (bulk mail only). A List-Unsubscribe
   * header alone is invisible to anyone not using Gmail or Apple Mail, so the
   * footer carries a link a human can actually see and click.
   */
  manageUrl?: string;
}): { text: string; html: string } {
  const { brand, heading, greeting, blocks, reason, manageUrl } = args;
  const accent = /^#[0-9a-f]{3,8}$/i.test(brand.primaryColor) ? brand.primaryColor : "#1d4ed8";

  /* ── plain text ──────────────────────────────────────────────────────── */
  const textParts: string[] = [];
  textParts.push(heading.toUpperCase());
  textParts.push("=".repeat(Math.min(heading.length, 64)));
  textParts.push("");
  if (greeting) textParts.push(`${greeting},`, "");
  for (const b of blocks) {
    if (b.p) textParts.push(wrapText(b.p), "");
    if (b.list) {
      for (const item of b.list) textParts.push(`  * ${item}`);
      textParts.push("");
    }
    if (b.button) {
      const url = safeUrl(b.button.url);
      if (url) textParts.push(`${b.button.label}:`, url, "");
    }
    if (b.code) textParts.push(`    ${b.code}`, "");
    if (b.note) textParts.push(wrapText(b.note), "");
  }
  textParts.push("--");
  textParts.push(brand.schoolName);
  textParts.push(reason);
  const manage = safeUrl(manageUrl);
  if (manage) textParts.push(`Change which emails you receive: ${manage}`);
  if (brand.contactEmail) textParts.push(`Questions? ${brand.contactEmail}`);
  textParts.push("This mailbox is not monitored for replies.");
  const text = textParts.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

  /* ── html ────────────────────────────────────────────────────────────── */
  const body: string[] = [];
  if (greeting) {
    body.push(`<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#111827;">${esc(greeting)},</p>`);
  }
  for (const b of blocks) {
    if (b.p) {
      body.push(`<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#111827;">${esc(b.p)}</p>`);
    }
    if (b.list) {
      body.push(
        `<ul style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:1.6;color:#111827;">` +
        b.list.map((i) => `<li style="margin:0 0 6px;">${esc(i)}</li>`).join("") +
        `</ul>`,
      );
    }
    if (b.button) {
      const url = safeUrl(b.button.url);
      if (url) {
        body.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">` +
          `<tr><td align="center" bgcolor="${esc(accent)}" style="border-radius:6px;">` +
          `<a href="${esc(url)}" style="display:inline-block;padding:12px 24px;font-family:Arial,Helvetica,sans-serif;` +
          `font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">` +
          `${esc(b.button.label)}</a></td></tr></table>`,
          `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#6b7280;">` +
          `If the button does not work, copy this address into your browser:<br>` +
          `<span style="word-break:break-all;color:#374151;">${esc(url)}</span></p>`,
        );
      }
    }
    if (b.code) {
      body.push(
        `<p style="margin:0 0 16px;padding:12px 16px;background:#f3f4f6;border-radius:6px;` +
        `font-family:'Courier New',monospace;font-size:15px;color:#111827;word-break:break-all;">` +
        `${esc(b.code)}</p>`,
      );
    }
    if (b.note) {
      body.push(`<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#6b7280;">${esc(b.note)}</p>`);
    }
  }

  const logo = safeUrl(brand.logoUrl);
  const header = logo
    ? `<img src="${esc(logo)}" alt="${esc(brand.schoolName)}" height="40" style="display:block;border:0;max-height:40px;">`
    : `<span style="font-size:20px;font-weight:bold;color:#ffffff;">${esc(brand.schoolName)}</span>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
<tr><td style="background:${esc(accent)};padding:20px 24px;">${header}</td></tr>
<tr><td style="padding:28px 24px 8px;">
<h1 style="margin:0 0 20px;font-size:21px;line-height:1.3;color:#111827;">${esc(heading)}</h1>
${body.join("\n")}
</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #e5e7eb;">
<p style="margin:0 0 6px;font-size:13px;color:#6b7280;">${esc(brand.schoolName)}</p>
<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#9ca3af;">${esc(reason)}</p>
${manage
    ? `<p style="margin:0 0 6px;font-size:12px;color:#9ca3af;"><a href="${esc(manage)}" style="color:#6b7280;">Change which emails you receive</a></p>`
    : ``}
${brand.contactEmail
    ? `<p style="margin:0;font-size:12px;color:#9ca3af;">Questions? <a href="mailto:${esc(brand.contactEmail)}" style="color:#6b7280;">${esc(brand.contactEmail)}</a> — this mailbox is not monitored for replies.</p>`
    : `<p style="margin:0;font-size:12px;color:#9ca3af;">This mailbox is not monitored for replies.</p>`}
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { text, html };
}

/** Soft-wrap plain text at 72 columns so it reads well in terminal clients. */
function wrapText(s: string, width = 72): string {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > width) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out.join("\n");
}
