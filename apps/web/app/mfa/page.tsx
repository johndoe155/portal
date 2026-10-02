import { redirect } from "next/navigation";
import { checkSession } from "@/lib/session";
import MfaForm from "./mfa-form";

export default async function MfaPage() {
  const check = await checkSession();
  if (check.kind === "anon") redirect("/login");
  if (check.kind === "authed") redirect("/");
  return (
    <div className="container" style={{ maxWidth: 420, paddingTop: 48 }}>
      <h1>Two-factor verification</h1>
      <p className="muted">
        Signed in as {check.session?.email ?? "staff account"}. Staff and admin sessions require a
        TOTP code from your authenticator app before any portal data is shown.
      </p>
      <MfaForm activeRole={check.session?.activeRole ?? "teacher"} />
    </div>
  );
}
