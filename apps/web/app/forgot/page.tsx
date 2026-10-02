import ForgotForm from "./forgot-form";

/** review-4 #1: per-request CSP nonce requires per-request rendering —
 * a statically cached page would bake in the build-time nonce and every
 * hydration script would be blocked by the live CSP header. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Forgot password — School Portal" };

export default function ForgotPage() {
  return (
    <div className="container" style={{ maxWidth: 420, paddingTop: 48 }}>
      <h1>Reset your password</h1>
      <p className="muted">
        Enter your school email. If an account exists, we’ll send a reset link
        (valid for one hour).
      </p>
      <ForgotForm />
      <p className="muted" style={{ marginTop: 14 }}><a href="/login">← Back to sign in</a></p>
    </div>
  );
}
