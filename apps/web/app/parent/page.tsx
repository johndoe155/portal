import Link from "next/link";
import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";

interface Child { studentUserId: string; admissionNo: string; gradeLevel: number; displayName: string; relationship: string
  verified?: string | null;
}

export default async function ParentHome() {
  const session = await requireRole("parent");
  const res = await apiGet<{ data: Child[] }>("/parent/children");
  const children = res?.data ?? [];
  return (
    <Shell session={session}>
      <h1>My children</h1>
      <p className="muted">Read-only view of released grades and attendance for each linked child.</p>
      {children.length === 0 && <div className="card muted">No children linked to your account yet.</div>}
      <div className="grid cols2">
        {children.map((c) => (
          <Link className="card" key={c.studentUserId} href={!c.verified ? "/parent/verify" : `/parent/${c.studentUserId}`} style={{ display: "block", color: "inherit" }}>
            <h2 style={{ marginTop: 0 }}>{c.displayName}</h2>
            <div className="muted">{c.admissionNo} · Grade {c.gradeLevel} · your {c.relationship}</div>
            {!c.verified ? (
              <div style={{ marginTop: 8, color: "#b45309" }}>
                Link pending — check your email for the school&apos;s verification link, or ask the office to confirm it.
              </div>
            ) : (
              <div style={{ marginTop: 8 }}>View grades &amp; attendance →</div>
            )}
          </Link>
        ))}
      </div>
    </Shell>
  );
}
