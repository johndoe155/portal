import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { withActor, SERVICE } from "./db/actor";
import {
  roles, rolePermissions, users, identities, userRoles, students, guardians,
  academicYears, terms, courses, courseSections, sectionStaff, enrollments,
  feeInvoices, exams, busRoutes, busStops, transportAssignments,
} from "./db/schema";
import { hashPassword, assertPasswordPolicy } from "./crypto/password";
import { insertAudit } from "./common/audit";
import { issueEnrollToken } from "./auth/enroll-token";

/**
 * DEV ONLY: raw MFA enrollment tokens for the demo staff accounts, keyed by
 * email. Populated by seedDemo(); exposed via GET /health/dev-enroll-tokens
 * (which 404s unless SEED_DEMO=true and NODE_ENV!=production) so the smoke
 * suite can complete the controlled enrollment flow over HTTP.
 */
export const devEnrollTokens: Record<string, string> = {};

const PERMS: Record<string, string[]> = {
  super_admin: ["directory:read","directory:write","roles:read","roles:write","academics:read","academics:write","attendance:read","attendance:write","gradebook:read","gradebook:write","fees:read","fees:write","transport:read","transport:write","comms:write","audit:read","exports:write","family:read","self:read","settings:write"],
  school_admin: ["directory:read","directory:write","roles:read","academics:read","academics:write","attendance:read","gradebook:read","fees:read","fees:write","transport:read","transport:write","comms:write","audit:read","exports:write","settings:write"],
  registrar: ["directory:read","directory:write","academics:read","academics:write","attendance:read","gradebook:read"],
  counselor: ["directory:read","attendance:read","gradebook:read"],
  teacher: ["academics:read","attendance:read","attendance:write","gradebook:read","gradebook:write","messaging:write","schedule:read","self:read"],
  teacher_assistant: ["academics:read","attendance:read","attendance:write","gradebook:read","self:read"],
  student: ["self:read"],
  parent: ["family:read", "fees:pay"],
  auditor: ["audit:read","directory:read","gradebook:read","attendance:read"],
};

/** Role + permission matrix — always seeded, idempotent. No accounts. */
export async function seedBase(db: Db): Promise<void> {
  return withActor(db, SERVICE, async (tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(roles);
    if (n > 0) return; // already seeded
    for (const [code, perms] of Object.entries(PERMS)) {
      await tx.insert(roles).values({ code, name: code.replace(/_/g, " ") });
      for (const p of perms) await tx.insert(rolePermissions).values({ roleCode: code, permission: p });
    }
  });
}

/**
 * Demo accounts + sample academic/fee/transport data. DEV/TESTS ONLY — main.ts
 * gates this behind SEED_DEMO=true and refuses it when NODE_ENV=production.
 */
export async function seedDemo(db: Db): Promise<Record<string, string>> {
  // Check if demo data exists; if so, skip the seed tx but still issue tokens
  // (dev restarts keep smoke green — tokens are in-memory and lost on restart).
  const [existing] = await withActor(db, SERVICE, async (tx) =>
    tx.select({ n: sql<number>`count(*)::int` }).from(users)
      .where(sql`lower(${users.email}) = 'root@school.example'`));
  const alreadySeeded = existing.n > 0;

  const ids = alreadySeeded ? ({} as Record<string, string>) : await withActor(db, SERVICE, async (tx) => {
    const pw = await hashPassword("Passw0rd!");
    const mk = async (email: string, name: string, role: string) => {
      const id = randomUUID();
      await tx.insert(users).values({ id, email, displayName: name, passwordHash: pw });
      await tx.insert(identities).values({ userId: id, provider: "local", subject: email });
      await tx.insert(userRoles).values({ id: randomUUID(), userId: id, roleCode: role });
      return id;
    };
    const admin = await mk("admin@school.example", "Ada Admin", "school_admin");
    const root = await mk("root@school.example", "Rita Root", "super_admin");
    const t1 = await mk("t1@school.example", "Tayo Teacher", "teacher");
    const t2 = await mk("t2@school.example", "Tola Teacher", "teacher");
    const s1 = await mk("s1@school.example", "Sola Student", "student");
    const p1 = await mk("p1@school.example", "Paula Parent", "parent");

    await tx.insert(students).values({ userId: s1, admissionNo: "STU-0001", gradeLevel: 10 });
    await tx.insert(guardians).values({
      id: randomUUID(), studentUserId: s1, userId: p1,
      relationship: "mother", verifiedAt: new Date(),
    });

    const year = randomUUID();
    await tx.insert(academicYears).values({
      id: year, name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31", isCurrent: true,
    });
    const term = randomUUID();
    await tx.insert(terms).values({ id: term, academicYearId: year, termNo: 1, name: "First Term" });

    const cMth = randomUUID(), cEng = randomUUID();
    await tx.insert(courses).values({ id: cMth, code: "MTH-101", title: "Mathematics" });
    await tx.insert(courses).values({ id: cEng, code: "ENG-101", title: "English" });

    const sec1 = randomUUID(), sec2 = randomUUID();
    await tx.insert(courseSections).values({ id: sec1, courseId: cMth, termId: term, name: "MTH-101 A" });
    await tx.insert(courseSections).values({ id: sec2, courseId: cEng, termId: term, name: "ENG-101 A" });

    await tx.insert(sectionStaff).values({ id: randomUUID(), sectionId: sec1, userId: t1, role: "teacher" });
    await tx.insert(sectionStaff).values({ id: randomUUID(), sectionId: sec2, userId: t2, role: "teacher" });
    await tx.insert(enrollments).values({ id: randomUUID(), studentUserId: s1, sectionId: sec1 });

    /* ── 5.4 demo data: fees, exam, transport ── */
    const inv = randomUUID();
    await tx.insert(feeInvoices).values({
      id: inv, studentUserId: s1, termId: term, label: "First Term Tuition",
      amountKobo: 15000000, status: "due", dueDate: "2026-10-31",  // ₦150,000.00
    });
    const exam = randomUUID();
    await tx.insert(exams).values({
      id: exam, sectionId: sec1, title: "First Term Examination",
      examDate: "2026-12-14", maxScore: "100", weightPct: "40",
    });
    const route = randomUUID();
    await tx.insert(busRoutes).values({
      id: route, name: "Route A — GRA Phase 2", driverName: "Chuka N.",
      driverPhone: "+234 803 000 0001", capacity: 30,
    });
    const stop = randomUUID();
    await tx.insert(busStops).values({
      id: stop, routeId: route, name: "Abuloma Junction", pickupTime: "07:10", seq: 3,
    });
    await tx.insert(transportAssignments).values({
      id: randomUUID(), studentUserId: s1, routeId: route, stopId: stop, termId: term,
    });

    return { admin, root, t1, t2, s1, p1, sec1, sec2, term, inv, exam, route, stop };
  });

  // Issue dev MFA enrollment tokens for the demo staff AFTER the seed tx
  // (issueEnrollToken opens its own transaction; PGlite is single-connection
  // so nesting would deadlock). Lookup-by-email so this also works when the
  // demo data was seeded by an earlier boot (dev restarts keep smoke green).
  // ALWAYS runs, even if the seed was skipped (alreadySeeded=true).
  for (const email of ["admin@school.example", "root@school.example",
    "t1@school.example", "t2@school.example"]) {
    const [u] = await withActor(db, SERVICE, async (tx) =>
      tx.select({ id: users.id }).from(users)
        .where(sql`lower(${users.email}) = lower(${email})`).limit(1));
    if (u) devEnrollTokens[email] = await issueEnrollToken(db, u.id, null);
  }

  return ids;
}

/** Test-compat alias: role matrix + demo data in one call. */
export async function seed(db: Db): Promise<Record<string, string>> {
  await seedBase(db);
  return seedDemo(db);
}

/**
 * One-time super_admin bootstrap from the environment — the only supported way
 * to create the first account (demo seeding is forbidden in production).
 * Idempotent: no-op when the email already exists. Requires a policy-strong
 * password; production refuses to boot without it.
 */
export async function ensureBootstrapAdmin(db: Db): Promise<void> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD are required in production");
    }
    return;
  }
  assertPasswordPolicy(password);
  await withActor(db, SERVICE, async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users)
      .where(sql`lower(${users.email}) = lower(${email})`).limit(1);
    if (existing) return;
    const id = randomUUID();
    await tx.insert(users).values({
      id, email, displayName: process.env.BOOTSTRAP_ADMIN_NAME ?? "Bootstrap Admin",
      passwordHash: await hashPassword(password),
    });
    await tx.insert(identities).values({ userId: id, provider: "local", subject: email });
    await tx.insert(userRoles).values({ id: randomUUID(), userId: id, roleCode: "super_admin" });
    await insertAudit(tx, { actorUserId: null, action: "auth.bootstrap_admin",
      entityType: "user", entityId: id });
  });
}

/** main.ts entry point: base always, demo only when explicitly enabled (never in production). */
export async function seedFromEnv(db: Db): Promise<void> {
  await seedBase(db);
  const demo = process.env.SEED_DEMO === "true";
  if (demo && process.env.NODE_ENV === "production") {
    throw new Error("SEED_DEMO=true is forbidden when NODE_ENV=production");
  }
  if (demo) await seedDemo(db);
  await ensureBootstrapAdmin(db);
}
