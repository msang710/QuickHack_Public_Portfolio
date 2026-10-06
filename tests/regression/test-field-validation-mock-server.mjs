import assert from "node:assert/strict";
import test from "node:test";
import { createMockFieldHandler } from "../../tools/field-validation/mock-server.mjs";
import { scenarioFixture } from "../../tools/field-validation/manifest.mjs";

test("mock field packs exactly once across a duplicate request and records both attempts", async () => {
  const input = { seed: "contest-demo", scenarioId: "pack-retry", runId: "run-local-001" };
  const fixture = scenarioFixture(input);
  const handle = createMockFieldHandler(input);
  const headers = { "x-quickhack-validation-run-id": input.runId, "x-quickhack-validation-scenario-id": input.scenarioId };
  const body = JSON.stringify({ scannedValues: [fixture.orderId, fixture.pgNo] });
  const first = await handle(new Request("http://127.0.0.1/api/mobile/packing-check", { method: "POST", headers, body }));
  const second = await handle(new Request("http://127.0.0.1/api/mobile/packing-check", { method: "POST", headers, body }));
  assert.equal((await first.json()).code, "MATCH");
  assert.equal((await second.json()).code, "ALREADY_PACKED");
  assert.ok(first.headers.get("x-quickhack-trace-id"));
  const snapshot = await handle(new Request("http://127.0.0.1/_field/snapshot", { headers }));
  assert.deepEqual(await snapshot.json(), {
    orderId: fixture.orderId,
    pgNo: fixture.pgNo,
    inventoryStatus: "PACKED",
    transitions: 1,
    auditCount: 2,
  });
});

test("mock field rejects a mismatched PG without changing inventory", async () => {
  const input = { seed: "s", scenarioId: "mismatch", runId: "r" };
  const handle = createMockFieldHandler(input);
  const headers = { "x-quickhack-validation-run-id": "r", "x-quickhack-validation-scenario-id": "mismatch" };
  const response = await handle(new Request("http://127.0.0.1/api/mobile/packing-check", {
    method: "POST", headers, body: JSON.stringify({ scannedValues: [scenarioFixture(input).orderId, "WRONG0000000"] }),
  }));
  assert.equal((await response.json()).code, "MODEL_MISMATCH");
  const snapshot = await handle(new Request("http://127.0.0.1/_field/snapshot", { headers }));
  assert.equal((await snapshot.json()).inventoryStatus, "PACKING");
});
