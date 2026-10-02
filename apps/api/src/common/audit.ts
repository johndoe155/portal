import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { auditLog } from "../db/schema";

export interface AuditInput {
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

/** Canonical field order — hash verification depends on it staying stable. */
function canonicalPayload(i: AuditInput, occurredAt: Date): string {
  return JSON.stringify([i.actorUserId, i.action, i.entityType ?? null,
    i.entityId ?? null, i.before ?? null, i.after ?? null, occurredAt.toISOString()]);
}

/** Recompute a stored row's hash — used by audit verification tooling/tests. */
export function computeRowHash(i: AuditInput, occurredAt: Date): string {
  return createHash("sha256").update(canonicalPayload(i, occurredAt)).digest("hex");
}

/**
 * Tamper-evident audit rows: rowHash = sha256(canonical payload). A verifier
 * with audit:read can recompute every row's hash and detect any edit.
 * (Append-order chaining via prev_hash is deferred: audit_log SELECT is
 * admin/auditor/service-only under RLS, so a writer like a teacher cannot read
 * the previous row to chain against. See docs/production-roadmap.md.)
 */
export async function insertAudit(tx: Db, input: AuditInput): Promise<void> {
  const occurredAt = new Date();
  const rowHash = computeRowHash(input, occurredAt);
  await tx.insert(auditLog).values({
    id: randomUUID(),
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    beforeJson: (input.before ?? null) as never,
    afterJson: (input.after ?? null) as never,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    occurredAt,
    rowHash,
  });
}
