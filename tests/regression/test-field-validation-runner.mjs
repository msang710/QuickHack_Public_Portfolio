import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createRunManifest } from "../../tools/field-validation/manifest.mjs";
import { materializeScenario, runHttpScenario } from "../../tools/field-validation/runner.mjs";

test("scenario inputs resolve deterministic fixture identifiers", () => {
  const manifest = createRunManifest({ runId: "r", seed: "seed", scenarioId: "pack", sourceRevision: "abc", environment: "isolated", networkProfile: "baseline" });
  const resolved = materializeScenario({ actions: [{ body: { pgNo: "{{PG_NO}}", orderId: "{{ORDER_ID}}" } }] }, manifest);
  assert.match(resolved.actions[0].body.pgNo, /^[A-Z]{2}\d{10}$/);
  assert.match(resolved.actions[0].body.orderId, /^FV-/);
  assert.notEqual(resolved.actions[0].body.pgNo, "{{PG_NO}}");
});

test("runner calls an isolated API, reads independent state and reports a duplicate debit", async () => {
  let debits = 0;
  const server = createServer((request, response) => {
    if (request.url === "/pack") {
      debits += 1;
      response.setHeader("x-quickhack-trace-id", `trace-${debits}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ packed: true }));
      return;
    }
    if (request.url === "/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ packedPgNos: ["AB1234567890"], inventoryDebits: { AB1234567890: debits } }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const report = await runHttpScenario({
      manifest: createRunManifest({ runId: "r1", seed: "s1", scenarioId: "duplicate-pack", sourceRevision: "abc", environment: "isolated", networkProfile: "baseline" }),
      baseUrl,
      actions: [{ id: "a", method: "POST", path: "/pack" }, { id: "b", method: "POST", path: "/pack" }],
      snapshotPath: "/state",
      expectedState: { packedPgNos: ["AB1234567890"], inventoryDebits: { AB1234567890: 1 } },
    });
    assert.equal(report.sampleSize, 2);
    assert.equal(report.oracle.ok, false);
    assert.equal(report.oracle.mismatches[0].path, "inventoryDebits.AB1234567890");
    assert.equal(report.verdict, "FAIL");
  } finally {
    server.close();
  }
});

test("runner rejects public destinations before any request", async () => {
  await assert.rejects(runHttpScenario({
    manifest: createRunManifest({ runId: "r1", seed: "s1", scenarioId: "s", sourceRevision: "abc", environment: "isolated", networkProfile: "baseline" }),
    baseUrl: "https://example.com", actions: [], snapshotPath: "/state", expectedState: {},
  }), /loopback/);
});
