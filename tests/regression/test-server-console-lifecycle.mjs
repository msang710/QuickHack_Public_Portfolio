import assert from "node:assert/strict";
import { createServer } from "node:net";
import { assertPortAvailable, createLifecycleQueue, waitForOwnedReady } from "../../tools/server-console-lifecycle.mjs";

const child = { pid: 12345, exitCode: null, signalCode: null };
let current = child;
let probes = 0;
await waitForOwnedReady({ id: "backend", child, current: () => current, probe: async () => ++probes === 3, timeoutMs: 100, pollMs: 1 });
assert.equal(probes, 3);

await assert.rejects(
  () => waitForOwnedReady({ id: "backend", child, current: () => current, probe: async () => false, timeoutMs: 5, pollMs: 1 }),
  (error) => error.code === "CHILD_START_TIMEOUT" && error.child === "backend"
);
child.exitCode = 1;
await assert.rejects(
  () => waitForOwnedReady({ id: "backend", child, current: () => current, probe: async () => true }),
  (error) => error.code === "CHILD_EXITED_BEFORE_READY"
);
child.exitCode = null;
current = { ...child };
await assert.rejects(
  () => waitForOwnedReady({ id: "backend", child, current: () => current, probe: async () => true }),
  (error) => error.code === "CHILD_EXITED_BEFORE_READY"
);

const occupied = createServer();
await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
const port = occupied.address().port;
try {
  await assert.rejects(() => assertPortAvailable("backend", port), (error) => error.code === "SERVER_PORT_IN_USE");
} finally {
  await new Promise((resolve) => occupied.close(resolve));
}
await assertPortAvailable("backend", port);

const queue = createLifecycleQueue();
const order = [];
const first = queue(async () => {
  order.push("start");
  await new Promise((resolve) => setTimeout(resolve, 5));
  order.push("ready");
});
const second = queue(async () => { order.push("toggle"); throw Object.assign(new Error("expected"), { code: "EXPECTED" }); });
const third = queue(async () => { order.push("stop"); });
await first;
await assert.rejects(second, (error) => error.code === "EXPECTED");
await third;
assert.deepEqual(order, ["start", "ready", "toggle", "stop"]);

console.log("Server console owned readiness, port conflict, and lifecycle queue verified.");
