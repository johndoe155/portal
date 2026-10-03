export interface SsoProvider {
  name: string;            // "entra" | "google" | "mock" ...
  issuer: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  jwksUrl?: string;        // RS256 verification (real IdPs)
  hmacSecret?: string;     // HS256 verification (dev/mock IdP only)
  jitRole?: string;        // auto-provision role for unknown users; empty = disabled
  /**
   * review-2: Entra ID id_tokens do NOT carry `email_verified` — requiring it
   * there would reject every login. Google always emits it. Default true;
   * set SSO_<NAME>_REQUIRE_EMAIL_VERIFIED=false only for IdPs that manage
   * mailbox verification server-side (Entra: emails are tenant-controlled).
   */
  requireEmailVerified?: boolean;
}

/** SSO_<NAME>_{ISSUER,AUTH_URL,TOKEN_URL,CLIENT_ID,CLIENT_SECRET,SCOPES,JWKS_URL,HMAC_SECRET,JIT_ROLE} */
function parseSsoProviders(): Record<string, SsoProvider> {
  const out: Record<string, SsoProvider> = {};
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^SSO_([A-Z0-9]+)_(.+)$/.exec(k);
    if (!m || !v) continue;
    const name = m[1].toLowerCase();
    const p = (out[name] ??= {
      name, issuer: "", authUrl: "", tokenUrl: "", clientId: "", clientSecret: "", scopes: "openid email profile",
    });
    switch (m[2]) {
      case "ISSUER": p.issuer = v; break;
      case "AUTH_URL": p.authUrl = v; break;
      case "TOKEN_URL": p.tokenUrl = v; break;
      case "CLIENT_ID": p.clientId = v; break;
      case "CLIENT_SECRET": p.clientSecret = v; break;
      case "SCOPES": p.scopes = v; break;
      case "JWKS_URL": p.jwksUrl = v; break;
      case "HMAC_SECRET": p.hmacSecret = v; break;
      case "JIT_ROLE": p.jitRole = v; break;
      case "REQUIRE_EMAIL_VERIFIED": p.requireEmailVerified = v === "true"; break;
    }
  }
  // HS256-signed id_tokens are for the local mock IdP only. A symmetric secret
  // in production would let anyone who ever sees it mint identity tokens.
  if (process.env.NODE_ENV === "production" && process.env.SSO_ALLOW_INSECURE !== "true") {
    for (const p of Object.values(out)) {
      if (p.hmacSecret) {
        throw new Error(
          `SSO_${p.name.toUpperCase()}_HMAC_SECRET (HS256 mock-IdP path) is forbidden in production; ` +
          `configure JWKS_URL for RS256 instead (or set SSO_ALLOW_INSECURE=true to override deliberately)`,
        );
      }
    }
  }
  // review-3 #3: skipping email_verified is only defensible when the IdP
  // tenant fully controls its mailboxes. A multi-tenant Entra issuer
  // (`common`/`organizations`) would accept ANY Microsoft account's claims —
  // combined with the email_verified exemption that is an account-takeover
  // path, so refuse to boot rather than misconfigure silently.
  for (const p of Object.values(out)) {
    if (p.requireEmailVerified === false &&
        /login\.microsoftonline\.com\/(?:common|organizations)(?:\/|$)/i.test(p.issuer)) {
      throw new Error(
        `SSO_${p.name.toUpperCase()}: REQUIRE_EMAIL_VERIFIED=false requires a SINGLE-TENANT issuer ` +
        `(https://login.microsoftonline.com/{tenant-id}/v2.0) — 'common'/'organizations' accept ` +
        `external accounts and are refused with the email_verified exemption`,
      );
    }
  }
  return out;
}

const DEV_APP_SECRET = "dev-only-secret-change-me-32chars!";

/**
 * APP_SECRET sources the AES-256 PII encryption key AND the SSO-state HMAC key.
 * Production refuses to boot without a strong, non-placeholder value — a leaked
 * or default secret would let anyone forge SSO state and decrypt PII at rest.
 */
function resolveAppSecret(isProduction: boolean): string {
  const v = process.env.APP_SECRET;
  if (isProduction) {
    if (!v) throw new Error("APP_SECRET is required in production (AES-256 PII key + SSO state HMAC source)");
    if (v.length < 32) throw new Error("APP_SECRET must be at least 32 characters in production");
    if (v === DEV_APP_SECRET) throw new Error("APP_SECRET must not be the dev placeholder in production");
    return v;
  }
  if (!v) console.warn("[config] APP_SECRET not set — using the DEV placeholder. Never deploy this.");
  return v ?? DEV_APP_SECRET;
}


/**
 * The origin the browser actually reaches the portal on.
 *
 * Every link in every email is built from this. The worker renders those
 * emails in its own process, so if PUBLIC_WEB_ORIGIN is set on the API but
 * not on the worker, the portal looks fine and every "Open the portal" button
 * a parent receives points at http://127.0.0.1:3000 — their own machine.
 * That is exactly what happened in docker-compose.
 *
 * A loopback default is useful in dev and indefensible in production, so
 * production refuses to boot without a real one rather than silently sending
 * thousands of dead links.
 */
function resolvePublicWebOrigin(isProduction: boolean): string {
  const v = process.env.PUBLIC_WEB_ORIGIN?.trim().replace(/\/+$/, "");
  if (isProduction) {
    if (!v) {
      throw new Error(
        "PUBLIC_WEB_ORIGIN is required in production — every link in every email is built " +
        "from it. Set it on the API *and* the worker.");
    }
    if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(v)) {
      throw new Error(
        `PUBLIC_WEB_ORIGIN is a loopback address (${v}). Emails would link recipients to their ` +
        "own machine. Set it to the address the school's browsers use.");
    }
    if (!/^https:\/\//i.test(v)) {
      throw new Error(`PUBLIC_WEB_ORIGIN must be https in production (got ${v}).`);
    }
  }
  return v || "http://127.0.0.1:3000";
}

const isProduction = process.env.NODE_ENV === "production";

export const config = {
  isProduction,
  port: Number(process.env.PORT ?? 8080),
  /** false in dev/tests (http); true in prod behind TLS */
  cookieSecure: process.env.COOKIE_SECURE !== "false",
  /** staff MFA step-up enforcement; off only for local demo */
  mfaEnforce: process.env.MFA_ENFORCE !== "false",
  appSecret: resolveAppSecret(isProduction),
  sessionTtlHoursStaff: 12,
  sessionTtlHoursUser: 24,
  sidCookie: "sid",
  csrfCookie: "csrf",
  /** Paystack webhook HMAC SHA-512 secret; unset ⇒ webhook returns 503 */
  paystackSecret: process.env.PAYSTACK_SECRET ?? "",
  /** Paystack REST base (override points at a mock in tests). */
  paystackApiBase: process.env.PAYSTACK_API_BASE ?? "https://api.paystack.co",
  /** review-5 #4: a stored Paystack checkout is reused only while fresh;
   *  older pendings get a fresh reference + Initialize on the next attempt. */
  paystackCheckoutTtlMs: Number(process.env.PAYSTACK_CHECKOUT_TTL_MS ?? "") || 30 * 60_000,
  /** Web origin the browser lives on — email links, SSO redirects, cookie scope. */
  publicWebOrigin: resolvePublicWebOrigin(isProduction),
  sso: parseSsoProviders(),
  ssoStateTtlMs: 10 * 60 * 1000,
  /** Behind a load balancer: set to the number of trusted proxies (express
   *  `trust proxy`) so req.ip is the real client, not the LB. */
  trustProxy: process.env.TRUST_PROXY ? (Number(process.env.TRUST_PROXY) || 1) : false,
  /** Sliding-window limits on auth-sensitive public routes.
   *  review-2 #3: per-IP caps are generous because a whole school shares one
   *  public IP; the tight limits are per-account (email/userId). */
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 15 * 60_000),
    loginMax: Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10),          // per email
    loginIpMax: Number(process.env.RATE_LIMIT_LOGIN_IP_MAX ?? 500),    // per IP (school NAT)
    totpMax: Number(process.env.RATE_LIMIT_TOTP_MAX ?? 10),            // per user
    forgotEmailMax: Number(process.env.RATE_LIMIT_FORGOT_EMAIL_MAX ?? 3), // per email
    accountOpsIpMax: Number(process.env.RATE_LIMIT_ACCT_OPS_IP_MAX ?? 100), // per IP
    generalMax: Number(process.env.RATE_LIMIT_GENERAL_MAX ?? 100),
  },
  /** Login lockout after repeated failures (DB-backed, survives restarts). */
  lockout: { maxFailures: 5, durationMs: 15 * 60_000 },
};
export type Config = typeof config;
