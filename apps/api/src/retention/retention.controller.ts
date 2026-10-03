import {
  Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "../db/client";
import { DB_TOKEN } from "../db/token";
import { withActor, SERVICE } from "../db/actor";
import { retentionRuns, users, userRoles } from "../db/schema";
import { Perm } from "../common/guards";
import { insertAudit } from "../common/audit";
import { assertCanGrant } from "../common/role-policy";
import {
  runRetention, retentionWindows, previewErasure, anonymiseUser,
} from "./retention.service";

/**
 * Retention and erasure — the admin side of the promises in /legal/retention
 * and the privacy policy.
 *
 * Both pages describe behaviour the product did not have: a purge schedule
 * that never ran, and an erasure right with no way to exercise it. These
 * endpoints make the published policy operable, and visible enough that the
 * school can show a regulator it is actually happening.
 */
@Controller()
export class RetentionController {
  constructor(@Inject(DB_TOKEN) private db: Db) {}

  /** Current windows, recent runs, and whether the schedule is actually running. */
  @Get("admin/retention")
  @Perm("settings:write")
  async status(@Req() req: Request) {
    const p = req.principal!;
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const runs = await tx.select().from(retentionRuns)
        .orderBy(desc(retentionRuns.startedAt)).limit(20);
      const last = runs.find((r) => !r.dryRun && r.ok);
      const ageHours = last?.finishedAt
        ? (Date.now() - last.finishedAt.getTime()) / 3_600_000 : null;
      return {
        windows: retentionWindows(),
        // A purge that has not run in two days means the worker is not running
        // — the single most likely way this quietly stops being true.
        lastRun: last ? {
          id: last.id, finishedAt: last.finishedAt, counts: last.counts,
          ageHours: Math.round((ageHours ?? 0) * 10) / 10,
        } : null,
        stale: last == null || (ageHours ?? Infinity) > 48,
        runs: runs.map((r) => ({
          id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, dryRun: r.dryRun,
          trigger: r.trigger, counts: r.counts, ok: r.ok, error: r.error,
        })),
      };
    });
  }

  /**
   * Preview or run a purge by hand.
   *
   * `dry_run` defaults to true — the preview is the common case, and a purge
   * triggered by a mis-click is not recoverable.
   */
  @Post("admin/retention/run")
  @Perm("settings:write")
  async run(@Req() req: Request, @Body() body: unknown) {
    const p = req.principal!;
    const b = (body ?? {}) as { dry_run?: boolean };
    const dryRun = b.dry_run !== false;
    return runRetention(this.db, {
      dryRun, trigger: "manual", actorUserId: p.userId,
    });
  }

  /* ── Erasure (right to be forgotten, with the statutory carve-out) ─────── */

  /**
   * Exactly what erasure would remove and what the school is required to keep.
   * The policy's carve-out is meaningless to a parent unless they can see it.
   */
  @Get("users/:id/erasure-preview")
  @Perm("directory:write")
  async erasurePreview(@Req() req: Request, @Param("id") id: string) {
    const preview = await withActor(this.db, SERVICE, (tx) => previewErasure(tx, id));
    if (preview.blockers.includes("That account does not exist.")) {
      throw new NotFoundException({ code: "not_found", title: "No such user" });
    }
    return preview;
  }

  /**
   * Erase a person. Irreversible by design.
   *
   * Requires the account's email as confirmation, so this cannot be the
   * accidental outcome of a stray click in a user list.
   */
  @Post("users/:id/erasure")
  @Perm("directory:write")
  async erase(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = req.principal!;
    const b = (body ?? {}) as { confirm_email?: string; reason?: string };

    return withActor(this.db, SERVICE, async (tx) => {
      const preview = await previewErasure(tx, id);
      if (preview.blockers.includes("That account does not exist.")) {
        throw new NotFoundException({ code: "not_found", title: "No such user" });
      }
      if (preview.blockers.length) {
        throw new UnprocessableEntityException({
          code: "erasure_blocked", title: "This account cannot be erased",
          detail: preview.blockers.join(" "),
        });
      }
      // Erasing someone more senior than you is not a thing an administrator
      // should be able to do quietly.
      const held = await tx.select({ code: userRoles.roleCode }).from(userRoles)
        .where(and(eq(userRoles.userId, id), isNull(userRoles.revokedAt)));
      if (held.length) assertCanGrant(p.activeRole, held.map((r) => r.code));

      if ((b.confirm_email ?? "").trim().toLowerCase() !== preview.user.email.toLowerCase()) {
        throw new UnprocessableEntityException({
          code: "confirmation_mismatch",
          title: "Type the account's email address to confirm",
          detail: "Erasure cannot be undone, so it needs the exact email address of the account.",
        });
      }

      const before = { email: preview.user.email, displayName: preview.user.displayName };
      const { tombstone } = await anonymiseUser(
        tx, id, new Date(), p.userId,
        b.reason?.slice(0, 500) ?? "Data-subject erasure request");

      await insertAudit(tx, {
        actorUserId: p.userId, action: "user.erased", entityType: "user", entityId: id,
        // The audit log is the one place the prior identity survives — it is
        // append-only and itself under a 7-year statutory window, and an
        // unattributable erasure would defeat the point of having a log.
        before, after: { tombstone, retained: preview.retains, reason: b.reason ?? null },
        ip: req.ip,
      });

      return {
        ok: true, userId: id, tombstone,
        erased: preview.erases.filter((e) => e.count > 0),
        retained: preview.retains,
        detail:
          "Identifying information has been removed. Records the school is required to keep were " +
          "retained without a named subject, and processing of them is now marked restricted.",
      };
    });
  }

  /** Everyone erased so far — a regulator will ask. */
  @Get("admin/erasures")
  @Perm("settings:write")
  async erasures(@Req() req: Request, @Query("limit") limit?: string) {
    const p = req.principal!;
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return withActor(this.db, { userId: p.userId, role: p.activeRole }, async (tx) => {
      const rows = await tx.select({
        id: users.id, anonymizedAt: users.anonymizedAt, anonymizedBy: users.anonymizedBy,
        note: users.erasureNote, restricted: users.processingRestricted,
      }).from(users).orderBy(desc(users.anonymizedAt)).limit(n);
      return { data: rows.filter((r) => r.anonymizedAt != null) };
    });
  }
}
