import Link from "next/link";

/** review-4 #1: dynamic so the per-request CSP nonce applies (see proxy.ts). */
export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "3rem 1rem", textAlign: "center" }}>
      <h1>Page not found</h1>
      <p className="muted">That page does not exist or has moved.</p>
      <Link className="btn" href="/login">Go to login</Link>
    </main>
  );
}
