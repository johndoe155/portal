"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { SessionView } from "@/lib/session";
import { api } from "@/lib/client";

interface Tab { href: string; label: string; perm?: string }

/**
 * Navigation is keyed by AREA (admin/teacher/student/parent), but a session
 * carries a ROLE ("school_admin", "registrar", "auditor", …). Indexing the
 * tab table directly with the role silently fell through to the student tabs,
 * so every administrator saw "Dashboard | Grades" and had no way to reach the
 * admin console at all. Roles are mapped to their area explicitly here.
 */
const ROLE_AREA: Record<string, string> = {
  super_admin: "admin", school_admin: "admin", registrar: "admin",
  auditor: "admin", counselor: "admin",
  teacher: "teacher", teacher_assistant: "teacher",
  student: "student", parent: "parent",
};

/**
 * `perm` hides a tab the role cannot use. An auditor has audit:read but not
 * fees:read, and a link that only ever produces "Forbidden" is worse than no
 * link — it looks like something is broken.
 */
const TABS: Record<string, Tab[]> = {
  admin: [
    { href: "/admin", label: "Overview" },
    { href: "/admin/users", label: "Users", perm: "directory:read" },
    { href: "/admin/students", label: "Students", perm: "directory:read" },
    { href: "/admin/sections", label: "Sections", perm: "academics:read" },
    { href: "/admin/academics", label: "Academics", perm: "academics:read" },
    { href: "/admin/fees", label: "Fees", perm: "fees:read" },
    { href: "/admin/transport", label: "Transport", perm: "transport:read" },
    { href: "/admin/import", label: "Import", perm: "directory:write" },
    { href: "/admin/reports", label: "Reports", perm: "directory:read" },
    { href: "/admin/notifications", label: "Email", perm: "audit:read" },
    { href: "/admin/audit", label: "Activity log", perm: "audit:read" },
    { href: "/admin/retention", label: "Retention", perm: "settings:write" },
    { href: "/admin/school", label: "School", perm: "settings:write" },
  ],
  teacher: [
    { href: "/teacher", label: "Sections" },
    { href: "/teacher/messages", label: "Messages" },
  ],
  student: [{ href: "/student", label: "Dashboard" }, { href: "/student/grades", label: "Grades" }],
  parent: [{ href: "/parent", label: "Children" }, { href: "/parent/messages", label: "Messages" }],
};

export default function Shell({ session, children }: { session: SessionView; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const area = ROLE_AREA[session.activeRole] ?? "student";
  const perms = new Set(session.permissions ?? []);
  const tabs = (TABS[area] ?? []).filter((t) => !t.perm || perms.has(t.perm));
  // phase 6: brand comes from school settings (public endpoint)
  const [brand, setBrand] = useState("School Portal");
  useEffect(() => {
    fetch("/api/v1/school").then((r) => r.ok ? r.json() : null)
      .then((s) => { if (s?.name) setBrand(s.name); }).catch(() => {});
  }, []);
  async function logout() {
    try { await api("/auth/logout", { method: "POST" }); } finally { router.push("/login"); router.refresh(); }
  }
  return (
    <>
      <header className="topbar">
        <span className="brand">{brand}</span>
        <span className="muted">{session.activeRole.replace("_", " ")}</span>
        <span className="spacer" />
        <span className="who">{session.displayName}</span>
        {/* Account self-service. Both pages existed only as URLs before — the
            email-preferences page in particular was linked from the
            List-Unsubscribe header of every bulk message we send. */}
        <Link className="btn ghost" href="/account/notifications"
              style={{ minHeight: 36, padding: "4px 12px" }}>Emails</Link>
        <Link className="btn ghost" href="/account/password"
              style={{ minHeight: 36, padding: "4px 12px" }}>Password</Link>
        <button className="btn ghost" onClick={logout} style={{ minHeight: 36, padding: "4px 12px" }}>Sign out</button>
      </header>
      <div className="container">
        {session.mfaGraceUntil && (
          /* Grace is dated and self-closing. Somebody has to be told the date
             before the morning it shuts, or the first they know of it is a
             sign-in that stops working. */
          <div className="alert warn" role="status" style={{ marginTop: 12 }}>
            <strong>Set up two-factor sign-in.</strong>{" "}
            Your account has no second factor yet. Staff sign-in without one stops working after{" "}
            {new Date(session.mfaGraceUntil).toLocaleDateString(undefined,
              { day: "numeric", month: "long", year: "numeric" })}.{" "}
            Ask the office for an enrolment token, then <Link href="/mfa">set it up</Link>.
          </div>
        )}
        <nav className="tabbar" aria-label="Primary">
          {tabs.map((t) => (
            <Link key={t.href} href={t.href} className={pathname === t.href || pathname.startsWith(t.href + "/") ? "on" : ""}>
              {t.label}
            </Link>
          ))}
        </nav>
        {children}
      </div>
    </>
  );
}
