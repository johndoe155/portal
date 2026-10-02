import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { withActor, SERVICE } from "../db/actor";
import { mfaEnrollTokens } from "../db/schema";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const ENROLL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Direct (SERVICE) issuance of a single-use MFA enrollment token.
 * Callers: the admin endpoint (POST /users/:id/mfa-enroll-token), the ops CLI
 * (scripts/mfa-token.mjs — the bootstrap path for the first admin), and the
 * test harness. The raw token is returned exactly once; only its hash is kept.
 */
export async function issueEnrollToken(
  db: Db, userId: string, createdBy: string | null,
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await withActor(db, SERVICE, async (tx) => {
    await tx.insert(mfaEnrollTokens).values({
      id: randomUUID(), userId, tokenHash: sha(token),
      expiresAt: new Date(Date.now() + ENROLL_TTL_MS), createdBy,
    });
  });
  return token;
}
