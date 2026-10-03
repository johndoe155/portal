/**
 * Minimal Paystack mock for tests/smoke: POST /transaction/initialize returns a
 * deterministic authorization_url + access_code. Run standalone for the smoke
 * suite:  node apps/api/test/mock-paystack.mjs [port]   (default 9311)
 * The API must be started with PAYSTACK_API_BASE=http://127.0.0.1:<port>.
 */
import { createServer } from "node:http";

export function startMockPaystack(port) {
  /** Every Initialize body we were sent, so tests can assert what we actually
   *  put on the wire (currency, callback_url) rather than only the response. */
  const initializeCalls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (url.pathname === "/transaction/initialize" && req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* keep {} */ }
        const auth = req.headers["authorization"] ?? "";
        if (!auth.startsWith("Bearer sk_")) {
          res.writeHead(401, { "content-type": "application/json" })
            .end(JSON.stringify({ status: false, message: "Invalid key" }));
          return;
        }
        initializeCalls.push(body);
        if (!body.amount || !body.reference) {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ status: false, message: "amount and reference are required" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          status: true, message: "Authorization URL created",
          data: {
            authorization_url: `https://checkout.mock-paystack.test/pay/${body.reference}`,
            access_code: `mock_${body.reference.slice(4, 12)}`,
            reference: body.reference,
          },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ status: false, message: "not found" }));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  server.initializeCalls = initializeCalls;
  server.lastInitialize = () => initializeCalls[initializeCalls.length - 1];
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Standalone mode — MUST be env-gated: `node --test test/` executes every file
// in this directory, and an always-on listener would hang the whole suite.
// Usage: MOCK_PAYSTACK_STANDALONE=1 node apps/api/test/mock-paystack.mjs [port]
if (process.env.MOCK_PAYSTACK_STANDALONE === "1") {
  const port = Number(process.argv[2] ?? 9311);
  startMockPaystack(port).then(() => console.log(`[mock-paystack] listening on :${port}`));
}
