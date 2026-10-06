import { performance } from "node:perf_hooks";
import { createFixturePlan } from "./fixture-plan.mjs";
import { ordersPerMinute } from "./profile.mjs";
import { appendCoupangOrders } from "./seed-mock.mjs";
import { measuredRequest } from "./collector.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export async function runLoadPhase({ profile: input, phaseId, baseUrl, credentials, mockPool, serverPool, write, signal, clock = performance }) {
  const plan = createFixturePlan(input);
  const { profile } = plan;
  const phase = profile.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new TypeError(`Unknown phase: ${phaseId}`);
  if (credentials.length !== profile.workerCount) throw new Error("One credential per virtual worker is required.");
  const target = new URL(baseUrl);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(target.hostname))) {
    throw new Error("Target must use HTTPS, except for a loopback-only test server.");
  }
  const startPackResult = await serverPool.query("SELECT count(*)::int AS value FROM inventory WHERE pg_no LIKE 'LV%' AND inventory_status='PACKED'");
  const startArrivalResult = await mockPool.query("SELECT count(*)::int AS value FROM mock_orders");
  let nextPack = startPackResult.rows[0].value;
  let nextArrival = startArrivalResult.rows[0].value;
  if (nextArrival < plan.counts.totalOrderCount) throw new Error("Mock fixture is incomplete.");
  const requestedArrivals = Math.floor(ordersPerMinute(profile, phase.orderMultiplier) * phase.durationSeconds / 60);
  if (nextArrival + requestedArrivals > plan.counts.totalOrderCount + profile.ordersPerDay * 10) throw new Error("Fixture live-arrival capacity is exhausted.");
  const deadline = clock.now() + phase.durationSeconds * 1_000;
  let sequence = 0;
  let duplicateSequence = 0;
  const failures = [];
  const emit = async (event) => write({ ...event, runId: profile.runId });
  const arrivalTask = (async () => {
    const interval = phase.durationSeconds * 1_000 / Math.max(requestedArrivals, 1);
    for (let slot = 0; slot < requestedArrivals; slot += 1) {
      if (signal?.aborted) break;
      const scheduledAt = deadline - phase.durationSeconds * 1_000 + slot * interval;
      await wait(scheduledAt - clock.now());
      if (signal?.aborted) break;
      const index = nextArrival++;
      try {
        await appendCoupangOrders(mockPool, profile, index, 1);
        await emit({ type: "arrival", phaseId, index, scheduledAtMs: Math.round(scheduledAt), lagMs: Math.round(clock.now() - scheduledAt), outcome: "APPENDED", at: new Date().toISOString() });
      } catch (error) {
        failures.push(error);
        await emit({ type: "arrival", phaseId, index, outcome: "FAILED", errorCode: error.code ?? error.name, at: new Date().toISOString() });
        break;
      }
    }
  })();
  const workers = credentials.map((credential, worker) => (async () => {
    while (clock.now() < deadline && !signal?.aborted) {
      const current = sequence++;
      const isWrite = current % 5 === 0;
      let request;
      if (isWrite) {
        const packIndex = nextPack++;
        if (packIndex >= profile.activePackingOrders) {
          failures.push(new Error("Active packing fixture exhausted."));
          break;
        }
        const order = plan.order(plan.counts.historicalOrderCount + packIndex);
        request = {
          path: "/api/mobile/packing-check", method: "POST", businessId: order.orderId,
          body: { scannedValues: [order.orderId, order.pgNo(0)], appInstanceId: credential.appInstanceId, deviceToken: credential.deviceToken },
        };
      } else {
        request = current % 2 === 0
          ? { path: "/api/inventory/devices?context=INVENTORY&limit=20", method: "GET", businessId: null }
          : { path: "/api/coupang/orders?limit=20", method: "GET", businessId: null };
      }
      const event = await measuredRequest({ baseUrl, ...request, credential, phaseId, runId: profile.runId, worker });
      await emit(event);
      if (isWrite && ++duplicateSequence % 100 === 0 && !signal?.aborted) {
        const retry = await measuredRequest({ baseUrl, ...request, credential, phaseId, runId: profile.runId, worker, attempt: 2 });
        await emit({ ...retry, expectedDuplicate: true, duplicateRejected: retry.businessCode === "PACKING_STATUS_REQUIRED" });
      }
      await wait(Math.min(5_000, deadline - clock.now()));
    }
  })());
  await Promise.all([...workers, arrivalTask]);
  if (failures.length) throw failures[0];
  return { phaseId, startPack: startPackResult.rows[0].value, nextPack, nextArrival, requestedArrivals };
}
