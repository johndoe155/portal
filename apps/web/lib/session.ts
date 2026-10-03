import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ROLE_HOME } from "./roles";
export { ROLE_HOME };

export interface SessionView {
  userId: string; email: string; displayName: string;
  roles: string[]; activeRole: string; permissions: string[];
  mfaVerified: boolean; mfaRequired: boolean;
  /** review-6 #3: temporary password from admin/CSV — must change before use */
  mustChangePassword?: boolean;
}
export type SessionCheck =
  | { kind: "authed"; session: SessionView }
  | { kind: "mfa"; session: SessionView | null }
  | { kind: "anon" };

const API = process.env.API_INTERNAL ?? "http://127.0.0.1:8080";

export async function checkSession(): Promise<SessionCheck> {
  const jar = await cookies();
  const sid = jar.get("sid")?.value;
  if (!sid) return { kind: "anon" };
  const cookie = [`sid=${sid}`];
  const csrf = jar.get("csrf")?.value;
  if (csrf) cookie.push(`csrf=${csrf}`);
  const res = await fetch(`${API}/api/v1/auth/session`, {
    headers: { cookie: cookie.join("; ") }, cache: "no-store",
  });
  if (res.ok) {
    const session = (await res.json()) as SessionView;
    // GET /auth/session is MFA-exempt on the API, so the gate is decided here:
    if (session.mfaRequired && !session.mfaVerified) return { kind: "mfa", session };
    return { kind: "authed", session };
  }
  return { kind: "anon" };
}

/** server-side data fetch with the viewer's cookie (RSC path) */
export async function apiGet<T>(path: string): Promise<T | null> {
  const jar = await cookies();
  const sid = jar.get("sid")?.value;
  if (!sid) return null;
  const cookie = [`sid=${sid}`];
  const csrf = jar.get("csrf")?.value;
  if (csrf) cookie.push(`csrf=${csrf}`);
  const res = await fetch(`${API}/api/v1${path}`, {
    headers: { cookie: cookie.join("; ") }, cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** Server-only page gate: redirects anon → /login, MFA-pending → /mfa, wrong role → its home. */
export async function requireRole(...allowed: string[]): Promise<SessionView> {
  const check = await checkSession();
  if (check.kind === "anon") redirect("/login");
  if (check.kind === "mfa") redirect("/mfa");
  // review-6 #3: forced password change beats every page (the API 403s anyway)
  if (check.session.mustChangePassword) redirect("/change");
  const home = ROLE_HOME[check.session.activeRole] ?? "/student";
  if (!allowed.includes(check.session.activeRole)) redirect(home);
  return check.session;
}

/**
 * The school's identity, read without a session.
 *
 * The legal pages are public and must show the school's real DPO and contact
 * addresses — a privacy policy that says "contact the DPO (configured at
 * deployment)" is not a policy anyone can act on.
 */
export interface PublicSchool {
  name: string;
  contact_email?: string | null;
  dpo_email?: string | null;
  address?: string | null;
  phone?: string | null;
}
export async function publicSchool(): Promise<PublicSchool> {
  try {
    const res = await fetch(`${API}/api/v1/school`, { cache: "no-store" });
    if (!res.ok) return { name: "School Portal" };
    return (await res.json()) as PublicSchool;
  } catch {
    return { name: "School Portal" };
  }
}
