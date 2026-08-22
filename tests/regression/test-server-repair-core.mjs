import assert from "node:assert/strict";
import { classifyServerRepair, createServerRepairCore } from "../../tools/server-repair-core.mjs";

function healthy(overrides = {}) {
  return {
    logDirectory: "C:\\ProgramData\\QuickHack\\demonstration-server\\logs",
    package: {
      registered: true,
      identityMatches: true,
      manifestMatches: true,
      requiredFilesRegular: true,
      contentVerified: true,
    },
    state: {
      exists: true,
      reparsePoint: false,
      runtimeConfig: "MATCH",
      acl: "READY",
      services: "READY",
      firewall: "READY",
    },
    database: {
      integrity: "PASSED",
      schema: "CURRENT",
      credentials: "READABLE",
    },
    ...overrides,
  };
}

assert.equal(classifyServerRepair(healthy()).disposition, "READY");
for (const packageOverride of [
  { registered: false },
  { identityMatches: false },
  { manifestMatches: false },
  { requiredFilesRegular: false },
  { contentVerified: false },
]) {
  const classified = classifyServerRepair(healthy({
    package: { ...healthy().package, ...packageOverride },
  }));
  assert.equal(classified.disposition, "PACKAGE_REINSTALL_REQUIRED");
  assert.equal(classified.mutableStateMutationAllowed, false);
}
assert.equal(
  classifyServerRepair(healthy({ state: { ...healthy().state, acl: "DRIFTED" } })).disposition,
  "PRODUCT_REPAIR_AVAILABLE"
);
assert.equal(
  classifyServerRepair(healthy({ database: { ...healthy().database, integrity: "FAILED" } })).disposition,
  "DATABASE_RESTORE_REQUIRED"
);
assert.equal(
  classifyServerRepair(healthy({ database: { ...healthy().database, schema: "INCOMPATIBLE" } })).disposition,
  "STATE_SCHEMA_INCOMPATIBLE"
);

let current = healthy({ state: { ...healthy().state, services: "DRIFTED" } });
let repairs = 0;
const repaired = await createServerRepairCore({
  async diagnose() { return current; },
  async repair() { repairs += 1; current = healthy(); },
}).run();
assert.equal(repaired.disposition, "READY");
assert.equal(repairs, 1);

let transientDiagnostics = 0;
const transientRepair = await createServerRepairCore({
  async diagnose() {
    transientDiagnostics += 1;
    return transientDiagnostics < 3
      ? healthy({ state: { ...healthy().state, firewall: "DRIFTED" } })
      : healthy();
  },
  async repair() {},
  postconditionAttempts: 3,
  async waitForPostcondition() {},
}).run();
assert.equal(transientRepair.disposition, "READY");
assert.equal(transientDiagnostics, 3);

let exhaustedWaits = 0;
const exhaustedRepair = await createServerRepairCore({
  async diagnose() {
    return healthy({ state: { ...healthy().state, firewall: "DRIFTED" } });
  },
  async repair() {},
  postconditionAttempts: 2,
  async waitForPostcondition() { exhaustedWaits += 1; },
}).run();
assert.equal(exhaustedRepair.disposition, "PRODUCT_REPAIR_AVAILABLE");
assert.equal(exhaustedRepair.code, "PRODUCT_REPAIR_POSTCONDITION_FAILED");
assert.equal(exhaustedWaits, 1);

let unsafeRepairCalled = false;
const packageFailure = await createServerRepairCore({
  async diagnose() {
    return healthy({ package: { ...healthy().package, contentVerified: false } });
  },
  async repair() { unsafeRepairCalled = true; },
}).run();
assert.equal(packageFailure.disposition, "PACKAGE_REINSTALL_REQUIRED");
assert.equal(unsafeRepairCalled, false);

const databaseFailure = await createServerRepairCore({
  async diagnose() {
    return healthy({ state: { ...healthy().state, services: "DRIFTED" } });
  },
  async repair() {
    const error = new Error("fixture");
    error.code = "POSTGRESQL_INTEGRITY_FAILED";
    throw error;
  },
}).run();
assert.equal(databaseFailure.disposition, "DATABASE_RESTORE_REQUIRED");
assert.equal(databaseFailure.mutableStateMutationAllowed, false);

console.log("Server package, product, database, and schema repair dispositions verified.");
