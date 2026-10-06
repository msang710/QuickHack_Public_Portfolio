import assert from "node:assert/strict";
import test from "node:test";
import { runNetworkLab } from "../../tools/field-validation/lab.mjs";

test("network lab records measured samples separately from configured delay", async () => {
  const calls = [];
  const report = await runNetworkLab({
    runId: "lab-1",
    profiles: { client: { delayMs: 40 }, external: { delayMs: 120, lossPercent: 1 } },
  }, {
    execute: async (command) => {
      calls.push(command);
      if (command.args.includes("ping")) return "64 bytes: icmp_seq=1 ttl=64 time=41.5 ms\n64 bytes: icmp_seq=2 ttl=64 time=43.5 ms\n";
      return "qdisc netem";
    },
  });
  assert.equal(report.evidenceClass, "NETWORK_ONLY");
  assert.equal(report.applicationTrafficVerified, false);
  assert.equal(report.network.client.configuredDelayMs, 40);
  assert.equal(report.network.client.measuredP50RttMs, 41.5);
  assert.equal(report.network.external.configuredDelayMs, 120);
  assert.equal(report.network.external.sampleSize, 2);
  assert.equal(calls.at(-1).args[0], "netns");
  assert.equal(calls.at(-1).args[1], "del");
});

test("network lab rejects out-of-range profiles before changing the host", async () => {
  let called = false;
  await assert.rejects(runNetworkLab({ runId: "lab-2", profiles: { client: { delayMs: -1 } } }, {
    execute: async () => { called = true; },
  }), /delayMs/);
  assert.equal(called, false);
});
