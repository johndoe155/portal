import { redirect } from "next/navigation";
import { checkSession } from "@/lib/session";
import Shell from "@/components/shell";
import ChangeForm from "./change-form";

export const metadata = { title: "Change password" };

/** review-6 #3: landing page for accounts on an admin/CSV-issued temporary password. */
export default async function ChangePasswordPage() {
  const check = await checkSession();
  if (check.kind === "anon") redirect("/login");
  if (check.kind === "mfa") redirect("/mfa");
  return (
    <Shell session={check.session}>
      <h1>Choose your own password</h1>
      <p className="muted">
        Your account was created with a temporary password. For your safety the portal stays
        locked until you replace it with one only you know.
      </p>
      <ChangeForm forced={check.session.mustChangePassword === true} />
    </Shell>
  );
}
