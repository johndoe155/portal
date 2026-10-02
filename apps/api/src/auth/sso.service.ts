import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, createRemoteJWKSet, type JWTVerifyOptions } from "jose";
import { config, type SsoProvider } from "../config";

/**
 * OIDC authorization-code flow helpers (Phase-1 §4: Entra ID + Google Workspace).
 *
 * review-3 #2 — the PKCE code_verifier and OIDC nonce live ONLY in the
 * short-lived httpOnly `sso_flow` cookie. The `state` URL parameter is a
 * signed, self-contained correlation id (random sid + HMAC) that carries no
 * secrets: URLs leak (browser history, IdP logs, Referer), so anything
 * secret in `state` defeats PKCE. The callback binds the two together —
 * the state param must match the sid inside the cookie — which also closes
 * login CSRF (an attacker's code+state cannot complete in a victim's
 * browser that never ran /start).
 *
 * - PKCE (S256) on every authorization — blocks authorization-code injection
 * - id_token: RS256 via the IdP's JWKS in production; HS256 accepted ONLY for
 *   dev mock IdPs (config refuses hmacSecret when NODE_ENV=production)
 * - nonce + (per-provider) email_verified claims enforced in verifyIdToken
 */

export interface SsoFlowCookie { provider: string; sid: string; nonce: string; verifier: string; ts: number; }

function hmac(data: string): string {
  return createHmac("sha256", config.appSecret).update(data).digest("base64url");
}

function sign(payload: string): string {
  const b64 = Buffer.from(payload).toString("base64url");
  return `${b64}.${hmac(b64)}`;
}

function unsign<T>(signed: string): T {
  const [b64, sig] = signed.split(".");
  if (!b64 || !sig) throw new Error("malformed state");
  const expect = Buffer.from(hmac(b64));
  const got = Buffer.from(sig);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) throw new Error("state signature mismatch");
  return JSON.parse(Buffer.from(b64, "base64url").toString()) as T;
}

/**
 * Creates the flow: an opaque signed `state` for the URL (no secrets) and a
 * signed cookie payload carrying the nonce + PKCE verifier (secrets).
 */
export function createSsoFlow(provider: string):
    { state: string; cookie: string; nonce: string; verifier: string } {
  const sid = randomBytes(16).toString("base64url");
  const nonce = randomBytes(12).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const cookie = sign(JSON.stringify({
    provider, sid, nonce, verifier, ts: Date.now(),
  } satisfies SsoFlowCookie));
  return { state: sign(JSON.stringify({ sid, ts: Date.now() })), cookie, nonce, verifier };
}

/** Verify the URL `state` param; returns its sid (no secrets inside). */
export function verifyState(state: string, _expectedProvider: string): { sid: string } {
  const parsed = unsign<{ sid: string; ts: number }>(state);
  if (!parsed.sid) throw new Error("state missing sid");
  if (Date.now() - parsed.ts > config.ssoStateTtlMs) throw new Error("state expired");
  return { sid: parsed.sid };
}

/**
 * Verify the httpOnly flow cookie and bind it to the state param's sid.
 * Returns the nonce + verifier that never touched the URL.
 */
export function verifyFlowCookie(cookie: string, expectedProvider: string, sid: string):
    { nonce: string; verifier: string } {
  const parsed = unsign<SsoFlowCookie>(cookie);
  if (parsed.provider !== expectedProvider) throw new Error("state provider mismatch");
  if (Date.now() - parsed.ts > config.ssoStateTtlMs) throw new Error("state expired");
  if (parsed.sid !== sid || !parsed.nonce || !parsed.verifier) {
    throw new Error("state does not match this browser's flow");
  }
  return { nonce: parsed.nonce, verifier: parsed.verifier };
}

/**
 * review-4 #4: account linking for email_verified-exempt providers (Entra).
 * An Entra user whose portal account already exists cannot be auto-linked by
 * email (nOAuth). Instead the callback issues this short-lived signed token;
 * the user proves ownership of the portal account with their password on
 * POST /auth/sso/link, which creates the identity. No secrets inside beyond
 * the IdP claims; useless without the account password; 10 min TTL.
 */
export function signLinkToken(provider: string, sub: string, email: string): string {
  return sign(JSON.stringify({ kind: "sso-link", provider, sub, email, ts: Date.now() }));
}

export function verifyLinkToken(token: string): { provider: string; sub: string; email: string } {
  const parsed = unsign<{ kind?: string; provider: string; sub: string; email: string; ts: number }>(token);
  if (parsed.kind !== "sso-link") throw new Error("not a link token");
  if (Date.now() - parsed.ts > config.ssoStateTtlMs) throw new Error("link token expired");
  if (!parsed.provider || !parsed.sub || !parsed.email) throw new Error("malformed link token");
  return { provider: parsed.provider, sub: parsed.sub, email: parsed.email };
}

export function getProvider(name: string): SsoProvider {
  const p = config.sso[name];
  if (!p || !p.authUrl || !p.tokenUrl || !p.clientId) {
    const err: any = new Error(`SSO provider '${name}' is not configured`);
    err.code = "sso_not_configured";
    throw err;
  }
  return p;
}

/** S256 code_challenge for a PKCE verifier. */
export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizeUrl(p: SsoProvider, state: string, nonce: string, verifier: string): string {
  const u = new URL(p.authUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", redirectUri(p.name));
  u.searchParams.set("scope", p.scopes);
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", s256Challenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export const redirectUri = (name: string) =>
  `${config.publicWebOrigin}/api/v1/auth/sso/${name}/callback`;

export async function exchangeCode(p: SsoProvider, code: string, verifier: string): Promise<string> {
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: redirectUri(p.name),
      client_id: p.clientId, client_secret: p.clientSecret,
      code_verifier: verifier,   // PKCE: IdP rejects codes not bound to our verifier
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const body = await res.json() as { id_token?: string };
  if (!body.id_token) throw new Error("id_token missing from token response");
  return body.id_token;
}

export async function verifyIdToken(p: SsoProvider, idToken: string, flow: { nonce: string }) {
  const opts: JWTVerifyOptions = { issuer: p.issuer || undefined, audience: p.clientId };
  let payload;
  if (p.jwksUrl) {
    ({ payload } = await jwtVerify(idToken, createRemoteJWKSet(new URL(p.jwksUrl)), opts));
  } else if (p.hmacSecret) {
    // dev/mock only — config throws on hmacSecret in production
    ({ payload } = await jwtVerify(idToken, new TextEncoder().encode(p.hmacSecret), opts));
  } else {
    throw new Error("provider has neither jwksUrl nor hmacSecret");
  }
  if (payload.nonce !== flow.nonce) throw new Error("id_token nonce mismatch");
  // review-2: Entra ID never emits email_verified (tenant-managed mailboxes);
  // providers opt out via SSO_<NAME>_REQUIRE_EMAIL_VERIFIED=false. Default is
  // to REQUIRE it — linking a directory account on an unverified email is an
  // account-takeover vector with IdPs that allow self-registered mailboxes.
  if (p.requireEmailVerified !== false) {
    const ev = payload.email_verified;
    if (ev !== true && ev !== "true") throw new Error("email not verified by IdP");
  }
  return payload;
}

/**
 * review-2: link identities on Entra's globally-stable `oid`/`tid` when
 * present instead of `sub` alone — `sub` in v2.0 tokens is pairwise-per-app
 * and email addresses can change (marriage, rename) which would silently
 * orphan a linked directory account. `oid:tid` is immutable per tenant user.
 * Google/other IdPs fall back to `sub`.
 */
export function claimsOf(payload: { sub?: string; oid?: string; tid?: string; email?: string; name?: string }) {
  if (!payload.sub || !payload.email) throw new Error("id_token missing sub/email");
  const subject = payload.oid
    ? (payload.tid ? `${payload.oid}:${payload.tid}` : String(payload.oid))
    : String(payload.sub);
  return { sub: subject, email: String(payload.email), name: payload.name ? String(payload.name) : undefined };
}
