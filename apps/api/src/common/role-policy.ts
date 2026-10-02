import { ForbiddenException } from "@nestjs/common";

/**
 * Role-grant hierarchy (review-2 blocker #1 — privilege escalation).
 *
 * `directory:write` alone must NOT let a caller mint accounts above their own
 * tier: a registrar or school admin could otherwise create a super_admin.
 * The rule: a caller may grant only roles at or below their own tier, and
 * only a super_admin may ever grant super_admin.
 */
const GRANTABLE: Record<string, string[]> = {
  super_admin: [
    "super_admin", "school_admin", "registrar", "counselor",
    "teacher", "teacher_assistant", "student", "parent", "auditor",
  ],
  school_admin: [
    "school_admin", "registrar", "counselor",
    "teacher", "teacher_assistant", "student", "parent", "auditor",
  ],
  registrar: ["teacher", "teacher_assistant", "student", "parent"],
  // every other role holds no directory:write, so these stay empty
};

export function grantableRoles(callerRole: string): string[] {
  return GRANTABLE[callerRole] ?? [];
}

/** Throws 403 role_above_your_tier if any requested role outranks the caller. */
export function assertCanGrant(callerRole: string, requested: string[]): void {
  const allowed = new Set(grantableRoles(callerRole));
  for (const r of requested) {
    if (!allowed.has(r)) {
      throw new ForbiddenException({
        code: "role_above_your_tier",
        title: "Role grant refused",
        detail: `your role (${callerRole}) cannot grant '${r}'`,
      });
    }
  }
}
