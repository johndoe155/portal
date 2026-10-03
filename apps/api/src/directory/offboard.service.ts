import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql, inArray, gt, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  users, userRoles, sessions, guardians, sectionStaff, courseSections, courses,
  messageThreads, passwordResetTokens, mfaEnrollTokens, userInvites,
  students, enrollments, feeInvoices, terms,
} from "../db/schema";
import { insertAudit } from "../common/audit";

/**
 * Offboarding.
 *
 * Deleting a leaver is not an option: their marks, attendance and messages are
 * part of the school's records and in most jurisdictions must be kept for
 * years after they go. So deactivation is a reversible state change that
 * removes *access* while leaving *history* intact.
 *
 * Deactivating does all of this atomically:
 *   - status → 'inactive' (the session middleware re-reads status on every
 *     request, so live sessions stop working on the next click, not at expiry)
 *   - every session revoked
 *   - every role revoked, stamped with the same instant so reactivation can
 *     restore exactly what was taken
 *   - pending invites, password-reset and MFA-enrol tokens consumed, so a
 *     link mailed last week cannot resurrect the account
 *   - guardian links ended (both directions, as appropriate)
 *
 * What it deliberately does NOT do is reassign their teaching. That is a
 * judgement call for the registrar, so the preview surfaces it and the UI
 * shows it before you confirm, rather than the system silently orphaning a
 * class or guessing a replacement.
 */

export interface OffboardPreview {
  user: { id: string; email: string; displayName: string; status: string; roles: string[] };
  isStudent: boolean;
  activeSessions: number;
  /** Sections where they are the teacher of record — these need a replacement. */
  sectionsTaught: { id: string; name: string; courseCode: string; courseTitle: string; role: string; students: number }[];
  /** Children they can see (they are the guardian). */
  childrenLinked: { id: string; displayName: string; relationship: string }[];
  /** Their own guardians (they are the student). */
  guardiansLinked: { id: string; displayName: string; relationship: string }[];
  threadsOwned: number;
  enrollmentsActive: number;
  unpaidInvoices: { count: number; totalMinor: number };
  /** Blocking reasons — non-empty means deactivation will be refused. */
  blockers: string[];
  /** Things the admin should deal with, but which do not block. */
  warnings: string[];
}

const ADMIN_ROLES = ["super_admin", "school_admin"];

/** Count admins who can still administer the system if this user goes. */
async function remainingSuperAdmins(tx: Db, excludingUserId: string): Promise<number> {
  const rows = await tx.select({ n: sql<number>`count(distinct ${userRoles.userId})::int` })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(
      eq(userRoles.roleCode, "super_admin"),
      isNull(userRoles.revokedAt),
      eq(users.status, "active"),
      ne(users.id, excludingUserId),
    ));
  return rows[0]?.n ?? 0;
}

export async function buildOffboardPreview(
  tx: Db, targetId: string, actorUserId: string,
): Promise<OffboardPreview | null> {
  const [user] = await tx.select().from(users).where(eq(users.id, targetId)).limit(1);
  if (!user) return null;

  const roleRows = await tx.select({ roleCode: userRoles.roleCode }).from(userRoles)
    .where(and(eq(userRoles.userId, targetId), isNull(userRoles.revokedAt)));
  const roles = roleRows.map((r) => r.roleCode);

  const [studentRow] = await tx.select().from(students)
    .where(eq(students.userId, targetId)).limit(1);

  const [{ n: activeSessions }] = await tx.select({ n: sql<number>`count(*)::int` })
    .from(sessions).where(and(
      eq(sessions.userId, targetId), isNull(sessions.revokedAt),
      gt(sessions.expiresAt, new Date())));

  const sectionsTaught = await tx.select({
    id: courseSections.id, name: courseSections.name, role: sectionStaff.role,
    courseCode: courses.code, courseTitle: courses.title,
    students: sql<number>`(select count(*)::int from enrollments e
      where e.section_id = ${courseSections.id} and e.status = 'enrolled')`,
  }).from(sectionStaff)
    .innerJoin(courseSections, eq(courseSections.id, sectionStaff.sectionId))
    .innerJoin(courses, eq(courses.id, courseSections.courseId))
    .where(eq(sectionStaff.userId, targetId));

  const childrenLinked = await tx.select({
    id: users.id, displayName: users.displayName, relationship: guardians.relationship,
  }).from(guardians).innerJoin(users, eq(users.id, guardians.studentUserId))
    .where(and(eq(guardians.userId, targetId), isNull(guardians.endedAt)));

  const guardiansLinked = await tx.select({
    id: users.id, displayName: users.displayName, relationship: guardians.relationship,
  }).from(guardians).innerJoin(users, eq(users.id, guardians.userId))
    .where(and(eq(guardians.studentUserId, targetId), isNull(guardians.endedAt)));

  const [{ n: threadsOwned }] = await tx.select({ n: sql<number>`count(*)::int` })
    .from(messageThreads).where(eq(messageThreads.createdBy, targetId));

  const [{ n: enrollmentsActive }] = await tx.select({ n: sql<number>`count(*)::int` })
    .from(enrollments).where(and(
      eq(enrollments.studentUserId, targetId), eq(enrollments.status, "enrolled")));

  // Outstanding = invoiced minus what has actually been paid against those
  // invoices, so a part-paid invoice reports the remainder rather than its
  // full face value.
  const [invoice] = await tx.select({
    count: sql<number>`count(*)::int`,
    totalMinor: sql<number>`coalesce(sum(${feeInvoices.amountKobo} - coalesce((
      select sum(p.amount_kobo) from fee_payments p
      where p.invoice_id = ${feeInvoices.id} and p.status = 'success'), 0)), 0)::bigint`,
  }).from(feeInvoices).where(and(
    eq(feeInvoices.studentUserId, targetId), ne(feeInvoices.status, "paid")));

  // ── Guard rails ───────────────────────────────────────────────────────────
  const blockers: string[] = [];
  if (targetId === actorUserId) {
    blockers.push("You cannot deactivate your own account — ask another administrator.");
  }
  if (user.status !== "active") {
    blockers.push(`This account is already ${user.status}.`);
  }
  if (roles.includes("super_admin") && await remainingSuperAdmins(tx, targetId) === 0) {
    blockers.push(
      "This is the last active super administrator. Deactivating it would lock " +
      "everyone out of the portal permanently. Grant super_admin to someone else first.");
  }

  const warnings: string[] = [];
  if (sectionsTaught.length) {
    const pupils = sectionsTaught.reduce((n, s) => n + Number(s.students ?? 0), 0);
    warnings.push(
      `They are assigned to ${sectionsTaught.length} section(s) covering ${pupils} pupil(s). ` +
      "Assign a replacement teacher, or those classes will have no one able to " +
      "take attendance or enter marks.");
  }
  if (childrenLinked.length) {
    warnings.push(
      `${childrenLinked.length} child(ren) are linked to this parent. Their access ends ` +
      "immediately. If another guardian is linked they keep access; if not, nobody " +
      "at home will be able to see the child's reports.");
  }
  if (Number(invoice?.count ?? 0) > 0) {
    warnings.push(
      `${invoice.count} unpaid invoice(s) totalling ${(Number(invoice.totalMinor) / 100).toFixed(2)}. ` +
      "Deactivating does not cancel fees — settle or write them off separately.");
  }
  if (enrollmentsActive > 0) {
    warnings.push(
      `Still enrolled in ${enrollmentsActive} section(s). Their marks and attendance ` +
      "are kept, but they will stop appearing in registers for new sessions.");
  }
  if (roles.some((r) => ADMIN_ROLES.includes(r))) {
    warnings.push("This is an administrator account — check nobody depends on it for scheduled work.");
  }

  return {
    user: { id: user.id, email: user.email, displayName: user.displayName, status: user.status, roles },
    isStudent: Boolean(studentRow),
    activeSessions, sectionsTaught, childrenLinked, guardiansLinked,
    threadsOwned, enrollmentsActive,
    unpaidInvoices: { count: Number(invoice?.count ?? 0), totalMinor: Number(invoice?.totalMinor ?? 0) },
    blockers, warnings,
  };
}

/**
 * The two reasons access gets taken away, kept distinct because they mean
 * different things to the school and are reported differently:
 *   left      — they have gone (resigned, graduated, transferred out)
 *   suspended — temporary, access withdrawn pending something
 * Both are enforced identically; only the record differs.
 */
export type DeactivationMode = "left" | "suspended";

export interface DeactivateResult {
  id: string;
  status: string;
  deactivatedAt: string;
  effects: {
    sessionsRevoked: number;
    rolesRevoked: string[];
    invitesCancelled: number;
    resetTokensVoided: number;
    enrollTokensVoided: number;
    guardianLinksEnded: number;
  };
}

export async function deactivateUser(
  tx: Db, targetId: string, actor: { userId: string; role: string },
  opts: { reason?: string; endGuardianLinks?: boolean; mode?: DeactivationMode } = {},
): Promise<DeactivateResult> {
  const mode: DeactivationMode = opts.mode === "suspended" ? "suspended" : "left";
  const now = new Date();
  const [before] = await tx.select().from(users).where(eq(users.id, targetId)).limit(1);

  // Revoke sessions first: the sooner this lands, the smaller the window in
  // which a leaver's open tab can still act.
  const killed = await tx.update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, targetId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  const revokedRoles = await tx.update(userRoles)
    .set({ revokedAt: now })
    .where(and(eq(userRoles.userId, targetId), isNull(userRoles.revokedAt)))
    .returning({ roleCode: userRoles.roleCode });

  // Any outstanding link that could let them back in is consumed now. An
  // invite or reset email sent last week is a live credential otherwise.
  const invites = await tx.update(userInvites)
    .set({ expiresAt: now })
    .where(and(
      sql`lower(${userInvites.email}) = lower(${before.email})`,
      isNull(userInvites.acceptedAt), gt(userInvites.expiresAt, now)))
    .returning({ id: userInvites.id });

  const resets = await tx.update(passwordResetTokens)
    .set({ usedAt: now })
    .where(and(eq(passwordResetTokens.userId, targetId), isNull(passwordResetTokens.usedAt)))
    .returning({ id: passwordResetTokens.id });

  const enrolTokens = await tx.update(mfaEnrollTokens)
    .set({ usedAt: now })
    .where(and(eq(mfaEnrollTokens.userId, targetId), isNull(mfaEnrollTokens.usedAt)))
    .returning({ id: mfaEnrollTokens.id });

  let guardianLinksEnded = 0;
  if (opts.endGuardianLinks) {
    const ended = await tx.update(guardians).set({ endedAt: now })
      .where(and(eq(guardians.userId, targetId), isNull(guardians.endedAt)))
      .returning({ id: guardians.id });
    const endedAsStudent = await tx.update(guardians).set({ endedAt: now })
      .where(and(eq(guardians.studentUserId, targetId), isNull(guardians.endedAt)))
      .returning({ id: guardians.id });
    guardianLinksEnded = ended.length + endedAsStudent.length;
  }

  await tx.update(users).set({
    status: mode,
    deactivatedAt: now,
    deactivatedBy: actor.userId,
    deactivationReason: opts.reason?.slice(0, 500) ?? null,
    updatedAt: now,
  }).where(eq(users.id, targetId));

  await insertAudit(tx, {
    actorUserId: actor.userId,
    action: "user.deactivated",
    entityType: "user",
    entityId: targetId,
    before: { status: before.status, roles: revokedRoles.map((r) => r.roleCode) },
    after: {
      status: mode, reason: opts.reason ?? null,
      sessionsRevoked: killed.length, invitesCancelled: invites.length,
      resetTokensVoided: resets.length, enrollTokensVoided: enrolTokens.length,
      guardianLinksEnded,
    },
  });

  return {
    id: targetId, status: mode, deactivatedAt: now.toISOString(),
    effects: {
      sessionsRevoked: killed.length,
      rolesRevoked: revokedRoles.map((r) => r.roleCode),
      invitesCancelled: invites.length,
      resetTokensVoided: resets.length,
      enrollTokensVoided: enrolTokens.length,
      guardianLinksEnded,
    },
  };
}

export async function reactivateUser(
  tx: Db, targetId: string, actor: { userId: string; role: string },
  opts: { reason?: string } = {},
): Promise<{ id: string; status: string; rolesRestored: string[] }> {
  const now = new Date();
  const [before] = await tx.select().from(users).where(eq(users.id, targetId)).limit(1);

  // Restore exactly the roles that this deactivation revoked — matched on the
  // deactivation instant. Re-granting "whatever roles they once had" could
  // silently hand back a privilege that was deliberately removed earlier.
  let restored: { roleCode: string }[] = [];
  if (before.deactivatedAt) {
    restored = await tx.update(userRoles)
      .set({ revokedAt: null })
      .where(and(eq(userRoles.userId, targetId), eq(userRoles.revokedAt, before.deactivatedAt)))
      .returning({ roleCode: userRoles.roleCode });
  }

  await tx.update(users).set({
    status: "active",
    deactivatedAt: null, deactivatedBy: null, deactivationReason: null,
    updatedAt: now,
  }).where(eq(users.id, targetId));

  await insertAudit(tx, {
    actorUserId: actor.userId,
    action: "user.reactivated",
    entityType: "user",
    entityId: targetId,
    before: { status: before.status, deactivatedAt: before.deactivatedAt?.toISOString() ?? null,
      reason: before.deactivationReason ?? null },
    after: { status: "active", rolesRestored: restored.map((r) => r.roleCode), note: opts.reason ?? null },
  });

  return { id: targetId, status: "active", rolesRestored: restored.map((r) => r.roleCode) };
}
