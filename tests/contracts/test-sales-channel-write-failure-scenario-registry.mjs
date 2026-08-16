import assert from "node:assert/strict";
import {
  SALES_CHANNEL_WRITE_FAILURE_SCENARIO,
  runSalesChannelWriteFailureScenarios,
  salesChannelWriteFailureScenarioIds,
} from "../integration/postgresql/sales-channel-write-failure-scenario-registry.mjs";

const expectedScenarioIds = [
  "changed-not-applied-command-replaces-snapshot",
  "changed-rejected-command-replaces-snapshot",
  "concurrent-changed-retries-have-one-winner",
  "retry-snapshot-failure-rolls-back",
];
assert.deepEqual(salesChannelWriteFailureScenarioIds, expectedScenarioIds);
assert.deepEqual(
  Object.values(SALES_CHANNEL_WRITE_FAILURE_SCENARIO),
  expectedScenarioIds
);

const api = Object.freeze({ marker: "registry-contract" });
const calls = [];
const implementations = Object.fromEntries(
  salesChannelWriteFailureScenarioIds.map((scenarioId) => [
    scenarioId,
    async (receivedApi) => calls.push([scenarioId, receivedApi]),
  ])
);
const executed = await runSalesChannelWriteFailureScenarios(api, implementations);
assert.deepEqual(executed, expectedScenarioIds);
assert.deepEqual(
  calls,
  expectedScenarioIds.map((scenarioId) => [scenarioId, api])
);

const missingImplementation = { ...implementations };
delete missingImplementation[expectedScenarioIds[0]];
await assert.rejects(
  runSalesChannelWriteFailureScenarios(api, missingImplementation),
  /registry mismatch: missing=\[changed-not-applied-command-replaces-snapshot\]/
);

await assert.rejects(
  runSalesChannelWriteFailureScenarios(api, {
    ...implementations,
    "undeclared-scenario": async () => undefined,
  }),
  /unknown=\[undeclared-scenario\]/
);

await assert.rejects(
  runSalesChannelWriteFailureScenarios(api, {
    ...implementations,
    [expectedScenarioIds[1]]: null,
  }),
  /must be implemented by a function/
);

const failFastCalls = [];
const failingImplementations = Object.fromEntries(
  salesChannelWriteFailureScenarioIds.map((scenarioId, index) => [
    scenarioId,
    async () => {
      failFastCalls.push(scenarioId);
      if (index === 1) throw new Error("forced scenario failure");
    },
  ])
);
await assert.rejects(
  runSalesChannelWriteFailureScenarios(api, failingImplementations),
  /forced scenario failure/
);
assert.deepEqual(failFastCalls, expectedScenarioIds.slice(0, 2));

console.log(
  "Sales-channel PostgreSQL failure scenario registry coverage and fail-fast execution verified."
);
