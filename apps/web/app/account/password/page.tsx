import { redirect } from "next/navigation";
import { checkSession, ROLE_HOME } from "@/lib/session";
import ChangePasswordForm from "./change-password-form";

export const metadata = { title: "Change password — School Portal" };

export default async function ChangePasswordPage() {
  const check = await checkSession();
  if (check.kind === "anon") redirect("/login");
  if (check.kind === "mfa") redirect("/mfa");
  return (
    <div className="container" style={{ maxWidth: 460, paddingTop: 32 }}>
      <h1>Change password</h1>
      <p className="muted">
        After changing your password, every other device is signed out.
        Minimum 12 characters with upper-case, lower-case and digits.
      </p>
      <ChangePasswordForm home={ROLE_HOME[check.session.activeRole] ?? "/student"} />
    </div>
  );
}
