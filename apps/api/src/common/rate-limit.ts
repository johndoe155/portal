import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * In-process fixed-window limiter for auth-sensitive public routes.
 *
 * Scope note: per-node memory. It absorbs bursts and casual abuse; the durable
 * brute-force defence is the DB-backed login lockout (users.locked_until),
 * which survives restarts and is shared across nodes. Multi-node deployments
 * should additionally rate-limit at the load balancer / CDN.
 */
interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

export function rateLimitCheck(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) {           // crude GC: drop expired entries
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return;
  }
  b.count += 1;
  if (b.count > max) {
    throw new HttpException(
      { type: "https://portal.school/errors/rate-limited", code: "rate_limited",
        title: "Too many requests", status: 429,
        detail: `limit ${max} per ${Math.round(windowMs / 60_000)} min`,
        retryAfterMs: b.resetAt - now },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export function rateLimitReset(key: string): void { buckets.delete(key); }
