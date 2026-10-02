/**
 * Minimal OIDC mock IdP for tests: /authorize auto-approves (identity chosen
 * via mock_email query param), /token returns an HS256 id_token.
 * Real IdPs (Entra/Google) use RS256+JWKS — the API supports both paths.
 *
 * Mirrors the production contract the API now enforces:
 *  - PKCE S256: /authorize binds the code to code_challenge; /token rejects a
 *    code_verifier that doesn't hash to it.
 *  - nonce: echoed from the authorize request into the id_token.
 *  - email_verified: always true here (the API rejects tokens without it).
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";

const HMAC_SECRET = "mock-secret";

const s256 = (v) => createHash("sha256").update(v).digest("base64url");

export function startMockIdp(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (url.pathname === "/authorize" && req.method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        const email = url.searchParams.get("mock_email") ?? "someone@example.com";
        if (!redirectUri || !state) { res.writeHead(400).end("missing params"); return; }
        // bind the code to the PKCE challenge + nonce (production behaviour)
        const code = Buffer.from(JSON.stringify({
          email,
          challenge: url.searchParams.get("code_challenge"),
          method: url.searchParams.get("code_challenge_method"),
          nonce: url.searchParams.get("nonce"),
          // Entra-flavour knobs (review-2): oid/tid stable subject identifiers
          // and the email_verified-absent case.
          oid: url.searchParams.get("mock_oid") ?? undefined,
          tid: url.searchParams.get("mock_tid") ?? undefined,
          emailVerified: url.searchParams.get("mock_email_verified") !== "false",
        })).toString("base64url");
        const sep = redirectUri.includes("?") ? "&" : "?";
        res.writeHead(302, { location: `${redirectUri}${sep}code=${code}&state=${encodeURIComponent(state)}` }).end();
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        let codeData;
        try { codeData = JSON.parse(Buffer.from(form.get("code") ?? "", "base64url").toString()); }
        catch { codeData = null; }
        const email = codeData?.email;
        if (!email) { res.writeHead(400).end("bad code"); return; }
        // PKCE verification (S256 only, as the API sends)
        if (codeData.challenge) {
          const verifier = form.get("code_verifier");
          if (!verifier || s256(verifier) !== codeData.challenge) {
            res.writeHead(400, { "content-type": "application/json" })
              .end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }));
            return;
          }
        }
        const idToken = await new SignJWT({
          email, name: `Mock ${email.split("@")[0]}`,
          nonce: codeData.nonce ?? undefined,
          // Entra never emits email_verified; mock_email_verified=false models that
          ...(codeData.emailVerified === false ? {} : { email_verified: true }),
          ...(codeData.oid ? { oid: codeData.oid } : {}),
          ...(codeData.tid ? { tid: codeData.tid } : {}),
        })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(`mock-${email}`)
          .setIssuer(`http://127.0.0.1:${port}`)
          .setAudience(form.get("client_id") ?? "mock-client")
          .setIssuedAt()
          .setExpirationTime("10m")
          .sign(new TextEncoder().encode(HMAC_SECRET));
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ access_token: "mock-at", token_type: "Bearer", id_token: idToken }));
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
