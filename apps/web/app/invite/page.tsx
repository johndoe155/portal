import { Suspense } from "react";
import InviteForm from "./invite-form";

/** review-4 #1: per-request CSP nonce requires per-request rendering —
 * a statically cached page would bake in the build-time nonce and every
 * hydration script would be blocked by the live CSP header. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Accept your invite — School Portal" };

export default function InvitePage() {
  return (
    <div className="container" style={{ maxWidth: 420, paddingTop: 48 }}>
      <h1>Welcome to the School Portal</h1>
      <p className="muted">
        Choose your password to activate your account. Minimum 12 characters
        with upper-case, lower-case and digits.
      </p>
      <Suspense fallback={<div className="card muted">Loading…</div>}>
        <InviteForm />
      </Suspense>
    </div>
  );
}
