import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { eq, and, isNull, gt } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db/client";
import { withActor, SERVICE } from "../db/actor";
import { sessions, users, userRoles, rolePermissions } from "../db/schema";
import { Principal, STAFF_ROLES, ROLE_PRIORITY } from "./principal";

const PUBLIC = new Set(["/api/v1/auth/login", "/api/v1/auth/providers", "/api/v1/auth/password/forgot", "/api/v1/auth/password/reset", "/api/v1/auth/invite/accept", "/api/v1/health"]);
const PUBLIC_PREFIXES = ["/api/v1/auth/sso/", "/api/v1/webhooks/", "/api/v1/school"]; // OIDC (5.3) + gateway webhooks (5.4, HMAC-verified) + public school identity (phase 6; GET only — PUT is @Perm-gated)
const MFA_EXEMPT = ["/api/v1/auth/mfa", "/api/v1/auth/session", "/api/v1/auth/logout", "/api/v1/health/dev-enroll-tokens"];

export function makeSessionMiddleware(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = req.cookies?.[config.sidCookie] as string | undefined;
      if (raw) {
        const tokenHash = createHash("sha256").update(raw).digest("hex");
        const principal = await withActor(db, SERVICE, async (tx) => {
          const [sess] = await tx.select().from(sessions).where(
            and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt),
                gt(sessions.expiresAt, new Date()))).limit(1);
          if (!sess) return null;
          const [user] = await tx.select().from(users).where(eq(users.id, sess.userId)).limit(1);
          if (!user || user.status !== "active") return null;
          const roleRows = await tx.select().from(userRoles)
            .where(and(eq(userRoles.userId, user.id), isNull(userRoles.revokedAt)));
          const roles = roleRows.map((r) => r.roleCode);
          if (!roles.includes(sess.activeRole)) return null;
          const permRows = await tx.select().from(rolePermissions)
            .where(eq(rolePermissions.roleCode, sess.activeRole));
          return {
            userId: user.id, sessionId: sess.id, email: user.email, displayName: user.displayName,
            roles, activeRole: sess.activeRole,
            perms: permRows.map((r) => r.permission),
            mfaVerified: sess.mfaVerifiedAt != null,
            mfaRequired: roles.some((r) => STAFF_ROLES.has(r)),
            mustChangePassword: user.mustChangePassword === true,
          } as Principal;
        });
        req.principal = principal ?? undefined;
      }

      const path = req.path;
      if (path.startsWith("/api/v1") && !PUBLIC.has(path) &&
          !PUBLIC_PREFIXES.some((x) => path.startsWith(x)) && !req.principal) {
        return res.status(401).json({ type: "https://portal.school/errors/unauthenticated",
          title: "Authentication required", status: 401, code: "unauthenticated" });
      }
      if (req.principal && config.mfaEnforce && req.principal.mfaRequired &&
          !req.principal.mfaVerified && !MFA_EXEMPT.some((m) => path.startsWith(m))) {
        return res.status(403).json({ type: "https://portal.school/errors/mfa_required",
          title: "MFA verification required", status: 403, code: "mfa_required" });
      }
      // review-6 #3: an account still on an admin/CSV-issued temporary password
      // is locked to the auth surface (login, change-password, MFA) until changed.
      if (req.principal?.mustChangePassword && !path.startsWith("/api/v1/auth")) {
        return res.status(403).json({ type: "https://portal.school/errors/password_change_required",
          title: "Password change required", status: 403, code: "password_change_required" });
      }
      next();
    } catch (err) { next(err); }
  };
}

export function defaultActiveRole(roles: string[]): string {
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return r;
  return roles[0];
}
