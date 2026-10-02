import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Monorepo root (/home/user) — Turbopack won't auto-detect a root that is the home directory. */
const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * review-2 #2: Security headers moved to middleware.ts (per-request CSP nonces).
 * next.config headers() cannot generate per-request nonces — middleware can.
 * The middleware sets CSP, XFO, nosniff, Referrer-Policy, Permissions-Policy,
 * and conditional HSTS on every response.
 */

/** BFF: /api/** is proxied to the API so the session cookie stays first-party (ADR-012). */
export default {
  turbopack: { root: monorepoRoot },
  async rewrites() {
    const api = process.env.API_INTERNAL ?? "http://127.0.0.1:8080";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
  // Security headers are now set per-request in middleware.ts (CSP nonces).
  // No static headers() needed here.
};
