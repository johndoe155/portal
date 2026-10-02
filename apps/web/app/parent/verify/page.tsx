import { redirect } from "next/navigation";
import { checkSession } from "@/lib/session";
import Shell from "@/components/shell";
import VerifyForm from "./verify-form";

export const metadata = { title: "Verify guardian link" };

/** phase 6: landing page for emailed guardian verification links (/parent/verify?token=…). */
export default async function ParentVerify({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const check = await checkSession();
  const sp = await searchParams;
  if (check.kind === "anon") redirect(`/login?next=${encodeURIComponent(`/parent/verify?token=${sp.token ?? ""}`)}`);
  if (check.kind === "mfa") redirect("/mfa");
  return (
    <Shell session={check.session}>
      <h1>Guardian link verification</h1>
      <p className="muted">You received this link from the school to confirm access to your child&apos;s records. Confirm below — the link works once, for your account.</p>
      <VerifyForm token={sp.token ?? ""} />
    </Shell>
  );
}
