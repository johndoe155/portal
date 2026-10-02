"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { SessionView } from "@/lib/session";
import { api } from "@/lib/client";

const TABS: Record<string, { href: string; label: string }[]> = {
  admin: [
    { href: "/admin", label: "Overview" },
    { href: "/admin/users", label: "Users" },
    { href: "/admin/students", label: "Students" },
    { href: "/admin/sections", label: "Sections" },
    { href: "/admin/academics", label: "Academics" },
    { href: "/admin/fees", label: "Fees" },
    { href: "/admin/transport", label: "Transport" },
    { href: "/admin/import", label: "Import" },
    { href: "/admin/reports", label: "Reports" },
    { href: "/admin/school", label: "School" },
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
  const role = TABS[session.activeRole] ? session.activeRole : "student";
  const tabs = TABS[role] ?? [];
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
        <button className="btn ghost" onClick={logout} style={{ minHeight: 36, padding: "4px 12px" }}>Sign out</button>
      </header>
      <div className="container">
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
