import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { once } from "node:events";
import { createMockFieldServer } from "../../tools/field-validation/mock-server.mjs";
import { runScenarioConfig } from "../../tools/field-validation/cli.mjs";

test("HTTP runner compares a real mock field state after packing and retry", async () => {
  const config = JSON.parse(await readFile(new URL("../../tools/field-validation/scenarios/packing-retry.json", import.meta.url), "utf8"));
  const server = createMockFieldServer(config);
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const result = await runScenarioConfig({ ...config, baseUrl: `http://127.0.0.1:${server.address().port}` }, { sourceRevision: "test-revision" });
    assert.equal(result.oracle.ok, true);
    assert.equal(result.sampleSize, 2);
    assert.equal(result.requests[1].outcome, "SUCCESS");
    assert.equal(result.traceMissingCount, 0);
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.equal(result.access.find((item) => item.provider === "NETWORK_RTT").status, "NOT_RUN");
  } finally {
    server.close();
  }
});
