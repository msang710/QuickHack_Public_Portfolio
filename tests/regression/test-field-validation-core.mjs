import assert from "node:assert/strict";
import test from "node:test";
import { createRunManifest, scenarioFixture } from "../../tools/field-validation/manifest.mjs";
import { compareBusinessState } from "../../tools/field-validation/oracle.mjs";
import { summarizeRun } from "../../tools/field-validation/report.mjs";

test("scenario fixture is stable for a seed and distinct for another seed", () => {
  const first = scenarioFixture({ seed: "contest-17", scenarioId: "duplicate-pack" });
  assert.deepEqual(first, scenarioFixture({ seed: "contest-17", scenarioId: "duplicate-pack" }));
  assert.notEqual(first.pgNo, scenarioFixture({ seed: "contest-18", scenarioId: "duplicate-pack" }).pgNo);
  assert.match(first.pgNo, /^[A-Z]{2}\d{10}$/);
});

test("oracle detects an extra inventory debit and preserves uncertainty", () => {
  const expected = { packedPgNos: ["AB1234567890"], inventoryDebits: { AB1234567890: 1 }, externalWrites: { order1: "UNCERTAIN" } };
  const actual = { packedPgNos: ["AB1234567890"], inventoryDebits: { AB1234567890: 2 }, externalWrites: { order1: "UNCERTAIN" } };
  const result = compareBusinessState(expected, actual);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map((item) => item.path), ["inventoryDebits.AB1234567890"]);
});

test("report includes failures, timeouts and missing traces in denominator", () => {
  const manifest = createRunManifest({ runId: "run-1", seed: "s", scenarioId: "pack", sourceRevision: "abc", environment: "isolated", networkProfile: "baseline" });
  const report = summarizeRun({ manifest, requests: [
    { id: "a", outcome: "SUCCESS", durationMs: 10, traceId: "t1", evidenceClass: "MOCK" },
    { id: "b", outcome: "TIMEOUT", durationMs: 100, traceId: null, evidenceClass: "MOCK" },
    { id: "c", outcome: "FAILED", durationMs: 30, traceId: "t3", evidenceClass: "PROVIDER" },
    { id: "d", outcome: "UNCERTAIN", durationMs: 200, traceId: null, evidenceClass: "MOCK" },
  ], oracle: { ok: false, mismatches: [{ path: "inventoryDebits.x" }] } });
  assert.equal(report.sampleSize, 4);
  assert.equal(report.timeoutCount, 1);
  assert.equal(report.uncertainCount, 1);
  assert.equal(report.traceMissingCount, 2);
  assert.equal(report.p50Ms, 30);
  assert.equal(report.p95Ms, 200);
  assert.equal(report.maxMs, 200);
  assert.equal(report.errorRate, 0.75);
  assert.equal(report.evidence.MOCK.sampleSize, 3);
  assert.equal(report.evidence.PROVIDER.sampleSize, 1);
  assert.equal(report.verdict, "FAIL");
});

test("report keeps measured network RTT apart from configured delay and unavailable access", () => {
  const manifest = createRunManifest({ runId: "run-2", seed: "s", scenarioId: "pack", sourceRevision: "abc", environment: "isolated", networkProfile: "delay-150" });
  const report = summarizeRun({
    manifest,
    requests: [{ id: "a", outcome: "SUCCESS", durationMs: 160, traceId: "t", evidenceClass: "MOCK" }],
    oracle: { ok: true, mismatches: [] },
    network: [{ segment: "external", configuredDelayMs: 150, measuredRttMs: 158 }],
    access: [{ provider: "CAFE24", status: "ACCESS_UNVERIFIED" }],
  });
  assert.equal(report.network.external.measuredP50RttMs, 158);
  assert.equal(report.network.external.configuredDelayMs, 150);
  assert.equal(report.verdict, "INCONCLUSIVE");
});

test("report cannot claim an overall pass without an independent oracle", () => {
  const manifest = createRunManifest({ runId: "run-3", seed: "s", scenarioId: "pack", sourceRevision: "abc", environment: "isolated", networkProfile: "baseline" });
  const report = summarizeRun({ manifest, requests: [{ id: "a", outcome: "SUCCESS", durationMs: 10, traceId: "t", evidenceClass: "MOCK" }] });
  assert.equal(report.verdict, "INCONCLUSIVE");
});
