import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * review-2 #2 (round-3 fix): CSP with per-request nonces.
 *
 * Next.js App Router injects inline <script> tags for hydration/flight data.
 * A static `script-src 'self'` blocks them. The fix: generate a nonce per
 * request and put it in the CSP header — BUT Next.js reads the nonce from
 * the REQUEST headers (x-nonce), not the response. Setting it only on the
 * response (the previous bug) left Next's inline scripts without a nonce
 * attribute, so `script-src 'nonce-…' 'strict-dynamic'` blocked them and
 * pages hydrated blank. The nonce must be forwarded into the request via
 * NextResponse.next({ request: { headers } }) so Next stamps every script it
 * emits; the same nonce goes into the CSP response header.
 *
 * Next 16 renamed middleware.ts → proxy.ts (middleware is deprecated and the
 * two cannot coexist); the export must be named `proxy` or default.
 *
 * Uses Web Crypto API (Edge Runtime compatible) — NOT node:crypto.
 */
export function proxy(req: NextRequest) {
  // Web Crypto API — available in Edge Runtime
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");

  // Forward the nonce to the renderer TWO ways:
  //  1. request `content-security-policy` header — this is what Next actually
  //     parses for its inline-script nonce (app-render.js reads
  //     headers['content-security-policy'] via getScriptNonceFromHeader);
  //  2. request `x-nonce` — the documented app-level handle for
  //     headers().get('x-nonce') in server components.
  // The response header (set below) is what the browser enforces.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  // HSTS only when behind TLS
  const origin = process.env.PUBLIC_WEB_ORIGIN ?? "";
  if (origin.startsWith("https:")) {
    res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
