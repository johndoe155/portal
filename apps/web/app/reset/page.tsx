import { Suspense } from "react";
import ResetForm from "./reset-form";

/** review-4 #1: per-request CSP nonce requires per-request rendering —
 * a statically cached page would bake in the build-time nonce and every
 * hydration script would be blocked by the live CSP header. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Choose a new password — School Portal" };

export default function ResetPage() {
  return (
    <div className="container" style={{ maxWidth: 420, paddingTop: 48 }}>
      <h1>Choose a new password</h1>
      <p className="muted">
        Minimum 12 characters with upper-case, lower-case and digits.
        Signing in elsewhere will be signed out.
      </p>
      <Suspense fallback={<div className="card muted">Loading…</div>}>
        <ResetForm />
      </Suspense>
    </div>
  );
}
