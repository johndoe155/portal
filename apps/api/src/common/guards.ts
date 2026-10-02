import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { config } from "../config";

export const PERM_KEY = "portal.perm";
export const Perm = (perm: string) => SetMetadata(PERM_KEY, perm);

/** review-2 #7: marks an endpoint as a deliberate parent-writable exception
 *  (fees:pay). The parent read-only invariant still blocks everything else. */
export const PARENT_WRITE_KEY = "portal.parentWrite";
export const ParentWrite = () => SetMetadata(PARENT_WRITE_KEY, true);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Double-submit CSRF on mutations (Phase 3 §1.1). /auth/* exempt (rate-limited);
 *  /webhooks/* exempt — gateway callbacks carry their own HMAC signature instead. */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!MUTATING.has(req.method as string)) return true;
    const path = req.path as string;
    if (path.startsWith("/api/v1/auth") || path.startsWith("/api/v1/webhooks")) return true;
    const header = req.headers["x-csrf"];
    const cookie = req.cookies?.[config.csrfCookie];
    if (!header || !cookie || header !== cookie) {
      throw new ForbiddenException({ code: "csrf_missing", title: "CSRF token missing or mismatch" });
    }
    return true;
  }
}

/** Capability gate (gate 1a) + parent read-only invariant (Phase 3 §1.7). RLS remains gate 2. */
@Injectable()
export class PermGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const p = req.principal;
    const perm = this.reflector.getAllAndOverride<string | undefined>(PERM_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    const parentWrite = this.reflector.getAllAndOverride<boolean | undefined>(PARENT_WRITE_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (p && p.activeRole === "parent" && MUTATING.has(req.method as string) && !parentWrite) {
      throw new ForbiddenException({ code: "parent_read_only", title: "Parent accounts are read-only" });
    }
    if (perm) {
      if (!p) throw new UnauthorizedException({ code: "unauthenticated" });
      if (!p.perms.includes(perm)) {
        throw new ForbiddenException({ code: "missing_capability", detail: `requires ${perm}` });
      }
    }
    return true;
  }
}
