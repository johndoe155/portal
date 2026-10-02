import { redirect } from "next/navigation";
import { Suspense } from "react";
import { checkSession, ROLE_HOME } from "@/lib/session";
import { getSchool } from "@/lib/school";
import LoginForm from "./login-form";
import LinkAccountForm from "./link-account-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const check = await checkSession();
  if (check.kind === "authed") redirect(ROLE_HOME[check.session.activeRole] ?? "/student");
  if (check.kind === "mfa") redirect("/mfa");
  const sp = await searchParams;
  // review-4 #4: arriving from the SSO callback with sso_link_required —
  // the work identity is trusted, the account exists; prove the password once
  // to link them.
  const linkToken = sp.sso_error === "sso_link_required" ? sp.link_token : undefined;
  // phase 6: the portal speaks with the school's identity (settings row)
  const school = await getSchool();
  return (
    <div className="container" style={{ maxWidth: 420, paddingTop: 48 }}>
      {school.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={school.logo_url} alt="" style={{ height: 56, marginBottom: 8 }} />
      ) : null}
      <h1>{school.name}</h1>
      {linkToken ? (
        <Suspense>
          <LinkAccountForm linkToken={linkToken} />
        </Suspense>
      ) : (
        <>
          <p className="muted">Sign in with your school account. Staff and admin accounts require two-factor authentication.</p>
          <LoginForm />
          {school.contact_email ? (
            <p className="muted" style={{ marginTop: 18 }}>
              Trouble signing in? Contact <a href={`mailto:${school.contact_email}`}>{school.contact_email}</a>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
