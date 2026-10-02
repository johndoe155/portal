const API = process.env.API_INTERNAL ?? "http://127.0.0.1:8080";

export interface SchoolView {
  name: string;
  logo_url?: string | null;
  primary_color?: string;
  accent_color?: string;
  contact_email?: string | null;
  dpo_email?: string | null;
  address?: string | null;
  phone?: string | null;
  timezone?: string;
  currency?: string;
  mail_sender?: string | null;
}

/** phase 6: the school's identity for server-rendered chrome (login, legal, nav). */
export async function getSchool(): Promise<SchoolView> {
  try {
    const res = await fetch(`${API}/api/v1/school`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as SchoolView;
  } catch {
    return { name: "School Portal" };
  }
}
