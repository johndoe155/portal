import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { config } from "../config";

/**
 * Notification preferences and one-click unsubscribe.
 *
 * Every bulk email already advertised `List-Unsubscribe:
 * <ORIGIN/account/notifications>`, a page that did not exist. A dead
 * unsubscribe link is not a cosmetic bug: Gmail and Yahoo's bulk-sender rules
 * require a working one-click unsubscribe, and a header that 404s is a
 * reputation problem on top of ignoring a recipient who asked to be left
 * alone.
 *
 * So: real preferences, a real page, and a real RFC 8058 one-click endpoint
 * that works from the mail client without signing in.
 */

/** The categories a recipient may switch off. */
export const OPTIONAL_KINDS = [
  "absence_recorded",
  "grade_released",
  "message_received",
  "daily_digest",
] as const;
export type OptionalKind = (typeof OPTIONAL_KINDS)[number];

export const KIND_LABELS: Record<OptionalKind, { label: string; detail: string }> = {
  absence_recorded: {
    label: "Absence alerts",
    detail: "Sent the moment a teacher marks your child absent from a lesson.",
  },
  grade_released: {
    label: "New marks",
    detail: "Sent when a teacher publishes marks for a class.",
  },
  message_received: {
    label: "Messages from staff",
    detail: "Sent when a teacher or the office starts or replies to a thread about your child.",
  },
  daily_digest: {
    label: "Daily summary",
    detail: "One email at the end of a day on which something happened, instead of several.",
  },
};

/**
 * Security and account mail is never opt-outable. Being told your password
 * was reset, or that your account was closed, is not marketing.
 */
export function isOptional(kind: string): kind is OptionalKind {
  return (OPTIONAL_KINDS as readonly string[]).includes(kind);
}

export type Prefs = Partial<Record<OptionalKind, boolean>>;

/** Absent key means subscribed, so a new category defaults to on. */
export function wantsKind(prefs: Prefs | null | undefined, kind: string): boolean {
  if (!isOptional(kind)) return true;
  return (prefs ?? {})[kind] !== false;
}

export function normalisePrefs(input: unknown): Prefs {
  const out: Prefs = {};
  const obj = (input ?? {}) as Record<string, unknown>;
  for (const k of OPTIONAL_KINDS) {
    if (typeof obj[k] === "boolean") out[k] = obj[k] as boolean;
  }
  return out;
}

export async function getPrefs(tx: Db, userId: string): Promise<Prefs> {
  const [row] = await tx.select({ p: users.notificationPrefs }).from(users)
    .where(eq(users.id, userId)).limit(1);
  return normalisePrefs(row?.p);
}

/**
 * Filter a set of recipients down to those who still want this kind.
 *
 * Done at enqueue time rather than at send time so an opted-out recipient
 * never produces an outbox row at all — otherwise the dead-letter screen
 * fills with mail nobody intended to send.
 */
export async function recipientsWanting(
  tx: Db, userIds: string[], kind: string,
): Promise<string[]> {
  if (!isOptional(kind) || userIds.length === 0) return userIds;
  const out: string[] = [];
  for (const id of userIds) {
    if (wantsKind(await getPrefs(tx, id), kind)) out.push(id);
  }
  return out;
}

/* ── One-click unsubscribe (RFC 8058) ─────────────────────────────────────── */

/**
 * A mail client POSTs the List-Unsubscribe URL with no cookies, so the link
 * has to carry its own authority. HMAC over (userId, kind) with the app
 * secret: unguessable, verifiable without state, and scoped to one category
 * for one person — it cannot be replayed to unsubscribe anybody else.
 */
export function unsubscribeToken(userId: string, kind: string): string {
  const mac = createHmac("sha256", config.appSecret)
    .update(`unsub:${userId}:${kind}`).digest("base64url");
  return `${userId}.${kind}.${mac}`;
}

export function verifyUnsubscribeToken(
  token: string,
): { userId: string; kind: OptionalKind } | null {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [userId, kind, mac] = parts;
  if (!isOptional(kind)) return null;
  const expected = createHmac("sha256", config.appSecret)
    .update(`unsub:${userId}:${kind}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { userId, kind };
}

/** Absolute URL a mail client can POST to without a session. */
export function unsubscribeUrl(userId: string, kind: string): string {
  return `${config.publicWebOrigin}/api/v1/notifications/unsubscribe` +
    `?t=${encodeURIComponent(unsubscribeToken(userId, kind))}`;
}
