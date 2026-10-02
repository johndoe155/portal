import { sql } from "drizzle-orm";
import type { Db } from "./client";

export interface Actor { userId: string | null; role: string; }

export const SERVICE: Actor = { userId: null, role: "service" };

/**
 * Two-gate authorization, gate 2 (ADR-003): every transaction pins the actor
 * into Postgres session settings; RLS policies then re-check every predicate.
 */
export async function withActor<T>(db: Db, actor: Actor, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // Drop privileges: RLS binds only on non-superuser connections (superusers bypass it).
    await tx.execute(sql`SET LOCAL ROLE portal_app`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${actor.userId ?? ""}, true),
                        set_config('app.role', ${actor.role}, true)`);
    return fn(tx as Db);
  });
}
