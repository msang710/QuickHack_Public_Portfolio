import assert from "node:assert/strict";
import test from "node:test";
import { parseScenarioConfig, runScenarioConfig } from "../../tools/field-validation/cli.mjs";

test("CLI requires an isolated scenario and exact expected state", () => {
  const config = parseScenarioConfig({
    runId: "r", seed: "s", scenarioId: "pack", environment: "isolated",
    baseUrl: "http://127.0.0.1:3000", snapshotPath: "/state",
    actions: [{ id: "scan", method: "POST", path: "/pack", body: { pgNo: "{{PG_NO}}" } }],
    expectedState: { packedPgNos: ["{{PG_NO}}"] },
  });
  assert.equal(config.actions.length, 1);
  assert.throws(() => parseScenarioConfig({ ...config, expectedState: undefined }), /expectedState/);
  assert.throws(() => parseScenarioConfig({ ...config, baseUrl: "https://example.com" }), /loopback/);
  assert.throws(() => parseScenarioConfig({ ...config, networkProfile: "latency-200ms" }), /baseline.*network/i);
});

test("CLI passes an ephemeral session cookie without recording it", async () => {
  const headers = [];
  const result = await runScenarioConfig({
    runId: "r", seed: "s", scenarioId: "pack", environment: "isolated",
    baseUrl: "http://127.0.0.1:3000", snapshotPath: "/state",
    actions: [{ id: "scan", method: "POST", path: "/pack" }], expectedState: {},
  }, {
    sourceRevision: "abc", cookie: "session=secret",
    fetchImpl: async (_url, init) => {
      headers.push(init.headers);
      return new Response(JSON.stringify({}), { status: 200, headers: { "x-quickhack-trace-id": "trace" } });
    },
  });
  assert.equal(headers[0].Cookie, "session=secret");
  assert.equal(JSON.stringify(result).includes("session=secret"), false);
  assert.equal(result.verdict, "INCONCLUSIVE");
  assert.equal(result.access.find((item) => item.provider === "DELIVERYAPI").status, "NOT_RUN");
});

test("runner fails a business-code mismatch even on HTTP 200", async () => {
  const result = await runScenarioConfig({
    runId: "r", seed: "s", scenarioId: "pack", environment: "isolated",
    baseUrl: "http://127.0.0.1:3000", snapshotPath: "/state",
    actions: [{ id: "scan", method: "POST", path: "/pack", expectedCode: "MATCH" }], expectedState: {},
  }, {
    sourceRevision: "abc",
    fetchImpl: async () => new Response(JSON.stringify({ code: "MODEL_MISMATCH" }), {
      status: 200, headers: { "x-quickhack-trace-id": "trace" },
    }),
  });
  assert.equal(result.requests[0].outcome, "FAILED");
  assert.equal(result.verdict, "FAIL");
});
