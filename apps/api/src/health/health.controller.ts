import { Controller, Get, Inject, NotFoundException, Res } from "@nestjs/common";
import type { Response } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { devEnrollTokens } from "../seed";
import { outboxStats } from "../notify/notify.service";
import { mailConfigured } from "../notify/mailer";
import { backupFreshness } from "../ops/backup-heartbeat";

/**
 * Liveness/readiness for load balancers and container healthchecks.
 * Public (whitelisted in session.middleware) — exposes no PII.
 */
@Controller("health")
export class HealthController {
  private startedAt = Date.now();

  constructor(@Inject(DB_TOKEN) private db: Db) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    let dbUp = false;
    try {
      await withActor(this.db, SERVICE, async (tx) => {
        await tx.execute(sql`SELECT 1`);
        dbUp = true;
      });
    } catch { /* db stays false */ }
    // review-2 ops: 503 when the DB is unreachable so container healthchecks
    // (and load balancers) actually fail instead of reporting a healthy API
    // with a dead database behind it.
    if (!dbUp) res.status(503);

    // Outbox + backup freshness are the two things that fail silently in a
    // school deployment: mail stops leaving and nobody notices until a parent
    // cannot reset a password; backups stop running and nobody notices until
    // a restore is needed. Both are surfaced here for monitoring to alert on.
    let outbox: Record<string, unknown> | null = null;
    if (dbUp) {
      try { outbox = await outboxStats(this.db); } catch { outbox = null; }
    }

    // `status` is LIVENESS only — it drives container healthchecks and load
    // balancer rotation, so it must not flip because email is misconfigured.
    // Operational concerns go in `warnings`, which monitoring alerts on
    // separately. Conflating the two gets a healthy API restart-looped for a
    // missing SMTP password.
    const warnings: string[] = [];
    if (!mailConfigured()) warnings.push("SMTP not configured — no email is being delivered");
    if (outbox && (outbox.dead as number) > 0) warnings.push(`${outbox.dead} undelivered notification(s) need attention`);
    const backup = backupFreshness();
    if (backup.stale) {
      warnings.push(backup.lastBackupAt
        ? `last successful backup was ${backup.ageHours}h ago`
        : "backups are configured but none has ever completed");
    }

    return {
      status: dbUp ? "ok" : "degraded",
      db: dbUp ? "up" : "down",
      mail: mailConfigured() ? "configured" : "not-configured",
      outbox,
      backup,
      warnings,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      version: process.env.APP_VERSION ?? "dev",
    };
  }

  /**
   * DEV ONLY — raw MFA enrollment tokens for the seeded demo staff, so the
   * smoke suite can exercise the controlled enrollment flow end-to-end.
   * 404 unless SEED_DEMO=true and NODE_ENV != production. In real deployments
   * tokens travel admin → user out-of-band (email/hand-off), never via HTTP.
   */
  @Get("dev-enroll-tokens")
  devEnrollTokenList() {
    if (process.env.NODE_ENV === "production" || process.env.SEED_DEMO !== "true") {
      throw new NotFoundException({ code: "not_found" });
    }
    return { tokens: devEnrollTokens };
  }
}
