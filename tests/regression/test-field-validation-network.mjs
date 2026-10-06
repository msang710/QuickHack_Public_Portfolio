import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedNetworkPlan, createDisposableTopology, measureSegmentRtt, parsePingRtt, runIsolatedNetworkProfile, withDisposableTopology } from "../../tools/field-validation/network-control.mjs";

test("network plan only shapes disposable validation interfaces", () => {
  const plan = createIsolatedNetworkPlan({ runId: "run-17", segment: "external", delayMs: 150, jitterMs: 20, lossPercent: 2 });
  assert.match(plan.namespace, /^qhfv-/);
  assert.match(plan.interfaceName, /^fv/);
  assert.equal(plan.apply[0].file, "ip");
  assert.deepEqual(plan.apply[0].args.slice(0, 3), ["netns", "exec", plan.namespace]);
  assert.deepEqual(plan.apply[0].args.slice(3, 7), ["tc", "qdisc", "replace", "dev"]);
  assert.equal(plan.cleanup[0].args[7], plan.interfaceName);
  assert.throws(() => createIsolatedNetworkPlan({ runId: "x", segment: "public-wlan", delayMs: 1 }), /segment/);
});

test("network profile cleans up after a failing run", async () => {
  const calls = [];
  const plan = createIsolatedNetworkPlan({ runId: "run-17", segment: "client", delayMs: 10 });
  await assert.rejects(runIsolatedNetworkProfile(plan, {
    execute: async (command) => { calls.push(command); },
    run: async () => { throw new Error("scenario failed"); },
  }), /scenario failed/);
  assert.deepEqual(calls, [...plan.apply, ...plan.inspect, ...plan.cleanup]);
});

test("profile runner stores measured RTT alongside configured netem values", async () => {
  const plan = createIsolatedNetworkPlan({ runId: "run-17", segment: "client", delayMs: 40 });
  const result = await runIsolatedNetworkProfile(plan, {
    execute: async () => "qdisc netem",
    measure: async () => [42, 46],
    run: async () => "ok",
  });
  assert.deepEqual(result.rttSamplesMs, [42, 46]);
  assert.equal(result.profile.delayMs, 40);
});

test("disposable topology creates only named veth pairs and removes them on failure", async () => {
  const topology = createDisposableTopology("run-17");
  assert.equal(topology.setup.some((item) => item.args.includes("wlan0")), false);
  assert.equal(topology.segments.client.namespace.startsWith("qhfv-c-"), true);
  assert.equal(topology.segments.external.namespace.startsWith("qhfv-e-"), true);
  const calls = [];
  await assert.rejects(withDisposableTopology(topology, {
    execute: async (item) => { calls.push(item); },
    run: async () => { throw new Error("scenario stopped"); },
  }), /scenario stopped/);
  assert.deepEqual(calls, [...topology.setup, ...topology.cleanup]);
});

test("RTT parser records actual ping samples through the disposable namespace", async () => {
  const output = "64 bytes from 10.253.17.1: icmp_seq=1 ttl=64 time=12.3 ms\n64 bytes from 10.253.17.1: icmp_seq=2 ttl=64 time=19.8 ms\n";
  assert.deepEqual(parsePingRtt(output), [12.3, 19.8]);
  const topology = createDisposableTopology("run-17");
  const commands = [];
  const result = await measureSegmentRtt(topology.segments.client, {
    execute: async (command) => { commands.push(command); return output; },
  });
  assert.deepEqual(result.samplesMs, [12.3, 19.8]);
  assert.deepEqual(commands[0].args.slice(0, 3), ["netns", "exec", topology.segments.client.namespace]);
});
