import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixturePlan } from "../../tools/load-validation/fixture-plan.mjs";
import { DEFAULT_LOAD_PROFILE, ordersPerMinute, profileDigest, validateLoadProfile } from "../../tools/load-validation/profile.mjs";
import { summarizeLoadRun } from "../../tools/load-validation/report.mjs";

function tinyProfile() {
  return { ...structuredClone(DEFAULT_LOAD_PROFILE), runId: "test-load", days: 2, ordersPerDay: 10, skuCount: 8,
    activePackingOrders: 10, workerCount: 2, phases: [{ id: "tiny", durationSeconds: 60, orderMultiplier: 1, scored: true }] };
}

test("fixture identities and sample selection are deterministic across server and mock generators", () => {
  const profile = tinyProfile();
  const first = createFixturePlan(profile);
  const second = createFixturePlan(profile);
  assert.equal(first.counts.historicalOrderCount, 20);
  assert.equal(first.counts.totalOrderCount, 30);
  assert.deepEqual(first.order(0).skuIndexes, second.order(0).skuIndexes);
  assert.equal(first.order(20).status, "INSTRUCT");
  assert.equal(first.order(19).status, "DELIVERED");
  assert.equal(first.order(30).status, "ACCEPT");
  assert.equal(first.sku(0).warrantyKey, "1Y");
  assert.notEqual(first.sku(0).skuCode, first.sku(1).skuCode);
  assert.equal(profileDigest(profile), profileDigest(structuredClone(profile)));
  assert.throws(() => first.order(130));
});

test("profile rejects unsafe names and impossible fixture size", () => {
  assert.throws(() => validateLoadProfile({ ...tinyProfile(), runId: "../other" }));
  assert.throws(() => validateLoadProfile({ ...tinyProfile(), days: 366, ordersPerDay: 10_000 }));
  assert.ok(Math.abs(ordersPerMinute(DEFAULT_LOAD_PROFILE, 5) - 104.16666666666667) < 1e-9);
});

test("report requires load coverage, trace evidence, duplicate rejection, and independent oracle", () => {
  const profile = tinyProfile();
  const events = [
    { type: "resource", database: { deadlocks: "0" } },
    { type: "arrival", phaseId: "tiny", outcome: "APPENDED" },
    { type: "request", phaseId: "tiny", route: "/api/inventory/devices", method: "GET", outcome: "SUCCESS", status: 200, durationMs: 12, traceId: "read" },
    { type: "request", phaseId: "tiny", route: "/api/mobile/packing-check", method: "POST", outcome: "SUCCESS", status: 200, durationMs: 20, traceId: "write", businessCode: "MATCH" },
    { type: "request", phaseId: "tiny", route: "/api/mobile/packing-check", method: "POST", outcome: "SUCCESS", status: 200, durationMs: 20, traceId: "retry", expectedDuplicate: true, duplicateRejected: true },
  ];
  assert.equal(summarizeLoadRun(profile, "tiny", events).verdict, "INCONCLUSIVE");
  assert.equal(summarizeLoadRun(profile, "tiny", events, { verdict: "PASS" }).verdict, "PASS");
  events[2].durationMs = profile.criteria.readP95Ms + 1;
  const targetMiss = summarizeLoadRun(profile, "tiny", events, { verdict: "PASS" });
  assert.equal(targetMiss.verdict, "TARGET_MISSED");
  assert.deepEqual(targetMiss.fatalReasons, []);
  events[2].durationMs = 12;
  assert.equal(summarizeLoadRun(profile, "tiny", events, { verdict: "PASS", findings: { packedActiveCount: 0 } }, { nextPack: 1 }).verdict, "FAIL");
  events[4].duplicateRejected = false;
  assert.equal(summarizeLoadRun(profile, "tiny", events, { verdict: "PASS" }).verdict, "FAIL");
  events[4].duplicateRejected = true;
  events[2].outcome = "TIMEOUT";
  events[3].outcome = "TIMEOUT";
  assert.deepEqual(summarizeLoadRun(profile, "tiny", events, { verdict: "PASS" }).fatalReasons, ["NO_SUCCESSFUL_REQUESTS"]);
});
