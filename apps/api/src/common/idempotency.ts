import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "../db/client";
import { withActor, SERVICE } from "../db/actor";
import { idempotencyKeys } from "../db/schema";

/**
 * Idempotency-Key on risky writes (Phase 3 §1.4, review-2 ops fix).
 *
 * Scoped per (key, user_id, path) so two users reusing the same key don't
 * collide, and the same key on a different endpoint is independent.
 *
 * Atomic claim: INSERT … ON CONFLICT DO NOTHING RETURNING — if the row was
 * already there, a concurrent duplicate is in flight (409) or done (replay).
 * This eliminates the old lookup-then-store race where two concurrent requests
 * with the same key could both miss the SELECT and both execute the side effect.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

export function requireIdempotencyKey(req: Request): string {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8) {
    throw new BadRequestException({ code: "idempotency_key_required",
      detail: "Idempotency-Key header (>=8 chars) required on this endpoint" });
  }
  return key.slice(0, 200);
}

export type ClaimResult =
  | { status: "claimed" }
  | { status: "replay"; body: unknown }
  | { status: "conflict" };

/** Atomically claim the idempotency slot. Returns claimed/replay/conflict. */
export async function claimIdempotency(
  db: Db, key: string, userId: string, req: Request,
): Promise<ClaimResult> {
  return withActor(db, SERVICE, async (tx) => {
    // Sweep expired keys (cheap, indexed)
    await tx.delete(idempotencyKeys)
      .where(lt(idempotencyKeys.createdAt, new Date(Date.now() - TTL_MS)));
    // Atomic claim: INSERT succeeds only if no row exists for this (key, user, path)
    const [inserted] = await tx.insert(idempotencyKeys).values({
      key, userId, path: req.path, method: req.method, status: "processing",
    }).onConflictDoNothing().returning({ key: idempotencyKeys.key });
    if (inserted) return { status: "claimed" as const };
    // Row already exists — check if it's done or still processing
    const [existing] = await tx.select({ status: idempotencyKeys.status, body: idempotencyKeys.body })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.path, req.path))).limit(1);
    if (!existing) return { status: "claimed" as const }; // race: row deleted between
    if (existing.status === "done") return { status: "replay" as const, body: existing.body };
    return { status: "conflict" as const };
  });
}

/** Mark the claimed slot as done with the response body. */
export async function completeIdempotency(
  db: Db, key: string, userId: string, req: Request, statusCode: number, body: unknown,
): Promise<void> {
  await withActor(db, SERVICE, async (tx) => {
    await tx.update(idempotencyKeys)
      .set({ status: "done", statusCode, body: body as Record<string, unknown> })
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.path, req.path)));
  });
}

/**
 * review-3 #4: release a claimed slot when the handler FAILED. Without this
 * the row stays `processing` and every client retry with the same key gets
 * 409 idempotency_in_progress until the 24 h TTL sweep — a failed save would
 * be unretryable for a day. Only deletes rows still in `processing` (a
 * completed slot is never clobbered). Best-effort: a release failure must
 * not mask the original error — TTL sweep is the backstop.
 */
export async function releaseIdempotency(
  db: Db, key: string, userId: string, req: Request,
): Promise<void> {
  try {
    await withActor(db, SERVICE, async (tx) => {
      await tx.delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.path, req.path), eq(idempotencyKeys.status, "processing")));
    });
  } catch { /* best-effort — the TTL sweep will reclaim it */ }
}
