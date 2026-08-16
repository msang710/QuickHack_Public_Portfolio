import assert from "node:assert/strict";
import {
  assertServiceKind,
  assertServiceOperation,
  serviceLifecycleSnapshot,
  serviceOperationResult,
} from "../../quickhack_shared/platform/service-lifecycle-contract.mjs";

assert.equal(assertServiceKind("postgresql"), "POSTGRESQL");
assert.equal(assertServiceOperation("status"), "STATUS");
assert.throws(() => assertServiceKind("arbitrary-unit"), (error) => error.code === "SERVICE_TARGET_INVALID");
assert.throws(() => assertServiceOperation("delete"), (error) => error.code === "SERVICE_OPERATION_INVALID");

assert.deepEqual(
  serviceLifecycleSnapshot({
    serviceKind: "APPLICATION",
    state: "ACTIVE",
    installed: true,
    enabled: true,
    mainPid: 413,
    result: "success\nignored-line-break",
    subState: "running",
  }),
  {
    serviceKind: "APPLICATION",
    state: "ACTIVE",
    installed: true,
    enabled: true,
    mainPid: 413,
    result: "success ignored-line-break",
    subState: "running",
    recovery: { code: "", message: "" },
  }
);

const unknown = serviceOperationResult({
  operation: "STATUS",
  snapshot: { serviceKind: "POSTGRESQL", state: "localized-running-value" },
});
assert.equal(unknown.snapshot.state, "UNKNOWN");
assert.equal(unknown.changed, false);
assert.equal(JSON.stringify(unknown).includes("password"), false);

console.log("Finite QuickHack service lifecycle contract verified.");
