import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { scenarioFixture } from "./manifest.mjs";

function json(body, status = 200, traceId = randomUUID()) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-quickhack-trace-id": traceId },
  });
}

export function createMockFieldHandler({ runId, seed, scenarioId }) {
  const fixture = scenarioFixture({ seed, scenarioId });
  const state = { orderId: fixture.orderId, pgNo: fixture.pgNo, inventoryStatus: "PACKING", transitions: 0, auditCount: 0 };
  return async function handle(request) {
    if (request.headers.get("x-quickhack-validation-run-id") !== runId
        || request.headers.get("x-quickhack-validation-scenario-id") !== scenarioId) {
      return json({ code: "WRONG_RUN" }, 400);
    }
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/_field/snapshot") return json({ ...state });
    if (request.method !== "POST" || path !== "/api/mobile/packing-check") return json({ code: "NOT_FOUND" }, 404);
    let input;
    try { input = await request.json(); } catch { return json({ code: "INVALID_JSON" }, 400); }
    if (!Array.isArray(input?.scannedValues) || input.scannedValues.length !== 2) return json({ code: "INVALID_SCAN" }, 400);
    state.auditCount += 1;
    const [orderId, pgNo] = input.scannedValues;
    if (orderId !== fixture.orderId || pgNo !== fixture.pgNo) return json({ code: "MODEL_MISMATCH" });
    if (state.inventoryStatus === "PACKED") return json({ code: "ALREADY_PACKED" });
    state.inventoryStatus = "PACKED";
    state.transitions += 1;
    return json({ code: "MATCH" });
  };
}

export function createMockFieldServer(config) {
  const handle = createMockFieldHandler(config);
  return createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 65_536) { outgoing.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        body: ["GET", "HEAD"].includes(incoming.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500).end();
    }
  });
}

async function main() {
  const [command, path] = process.argv.slice(2);
  if (command !== "serve" || !path) throw new Error("Usage: node tools/field-validation/mock-server.mjs serve <scenario.json>");
  const config = JSON.parse(await readFile(path, "utf8"));
  const port = new URL(config.baseUrl).port;
  if (!port || !Number.isSafeInteger(Number(port)) || Number(port) < 1024) throw new TypeError("A loopback port >= 1024 is required.");
  const server = createMockFieldServer(config);
  server.listen(Number(port), "127.0.0.1", () => process.stdout.write(`Mock field listening on 127.0.0.1:${port}\n`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
