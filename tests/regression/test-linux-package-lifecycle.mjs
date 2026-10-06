import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { childFailureCode, createLinuxPackageLifecycle, ensureConsoleOperatorStateDirectory, linuxPackageDependencies, unitJournalFailureCode } from "../../tools/platform/linux/package-lifecycle.mjs";
import { reconcileLinuxUpgrade } from "../../tools/platform/linux/upgrade-reconcile.mjs";

assert.equal(childFailureCode("POSTGRESQL_INITIALIZE_CLUSTER_FAILED: setup failed.\n"), "POSTGRESQL_INITIALIZE_CLUSTER_FAILED");
assert.equal(childFailureCode("Error: potentially sensitive detail"), null);
assert.equal(unitJournalFailureCode("warning\nTLS_HOST_SELECTION_REQUIRED: TLS setup failed.\n"), "TLS_HOST_SELECTION_REQUIRED");

const operatorStateRoot = mkdtempSync(path.join(os.tmpdir(), "quickhack-operator-state-"));
try {
  const state = path.join(operatorStateRoot, "state");
  const operator = path.join(state, "operator");
  mkdirSync(operator, { recursive: true, mode: 0o755 });
  await ensureConsoleOperatorStateDirectory(operatorStateRoot, process.getuid(), process.getgid());
  assert.equal(lstatSync(operator).mode & 0o777, 0o700);
  assert.equal(lstatSync(state).mode & 0o777, 0o750);
  rmSync(operator, { recursive: true });
  writeFileSync(operator, "invalid", { mode: 0o600 });
  await assert.rejects(() => ensureConsoleOperatorStateDirectory(operatorStateRoot, process.getuid(), process.getgid()), (error) => error.code === "CONSOLE_OPERATOR_STATE_INVALID");
} finally {
  rmSync(operatorStateRoot, { recursive: true, force: true });
}

function runtimeFixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      getuid: () => 0,
      assertExecutable: async (filename) => calls.push(["executable", filename]),
      postgresqlVersion: async () => "postgres (PostgreSQL) 18.4",
      unitExists: async () => false,
      ensureRuntimeConfig: async (config) => calls.push(["config", config.runtimeConfig]),
      runOperator: async (config, operation) => calls.push(["operator", operation, config.artifactKind]),
      ensureApplicationSecurityDirectory: async () => calls.push(["security"]),
      ensureConsoleOperatorStateDirectory: async () => calls.push(["operator-state"]),
      startInitialTls: async (unit) => calls.push(["tls", unit]),
      activateServices: async (config) => calls.push(["enable", config.services.postgresql, config.services.console]),
      waitForApplicationReady: async () => calls.push(["ready"]),
      clearUpgradePending: async () => calls.push(["clear-upgrade"]),
      upgradePending: async () => false,
      pacmanTransactionActive: async () => false,
      disableAndStop: async (units) => calls.push(["disable", ...units]),
      purgeCredentialPaths: () => ["/var/lib/quickhack/security/quickhack.postgresql.runtime.cred"],
      removeOwnedPaths: async (paths) => calls.push(["remove", ...paths]),
      ...overrides,
    },
  };
}

assert.ok(linuxPackageDependencies("DEMONSTRATION_SERVER").includes("/usr/bin/postgres"));
assert.ok(linuxPackageDependencies("DEMONSTRATION_SERVER").includes("/usr/bin/systemd-run"));
assert.deepEqual(linuxPackageDependencies("OPERATIONAL_CLIENT"), ["/usr/bin/node", "/usr/bin/adb", "/usr/bin/lp", "/usr/bin/lpstat"]);

const setupFixture = runtimeFixture();
const lifecycle = createLinuxPackageLifecycle({ runtime: setupFixture.runtime });
assert.deepEqual(await lifecycle.setup({ artifactKind: "DEMONSTRATION_SERVER" }), {
  operation: "INSTALL",
  artifactKind: "DEMONSTRATION_SERVER",
  state: "ACTIVE",
});
assert.ok(setupFixture.calls.some((call) => call[0] === "operator" && call[1] === "INSTALL"));
assert.ok(setupFixture.calls.some((call) => call[0] === "enable" && call.includes("quickhack-demonstration-console.service")));
assert.deepEqual(setupFixture.calls.filter((call) => ["operator", "security", "operator-state", "tls", "enable", "ready", "clear-upgrade"].includes(call[0])).map((call) => call[0]), ["operator", "security", "operator-state", "tls", "enable", "ready", "clear-upgrade"]);

const repairFixture = runtimeFixture();
await createLinuxPackageLifecycle({ runtime: repairFixture.runtime }).repair({ artifactKind: "OPERATIONAL_SERVER" });
assert.ok(repairFixture.calls.some((call) => call[0] === "operator" && call[1] === "REPAIR"));

const pendingFixture = runtimeFixture({ upgradePending: async () => true });
await assert.rejects(
  () => createLinuxPackageLifecycle({ runtime: pendingFixture.runtime }).repair({ artifactKind: "DEMONSTRATION_SERVER" }),
  (error) => error.code === "UPGRADE_RECOVERY_REQUIRED"
);
assert.equal(pendingFixture.calls.some((call) => call[0] === "operator"), false);
const activeTransactionFixture = runtimeFixture({ upgradePending: async () => true, pacmanTransactionActive: async () => true });
await assert.rejects(
  () => createLinuxPackageLifecycle({ runtime: activeTransactionFixture.runtime }).repair({ artifactKind: "DEMONSTRATION_SERVER", upgradeRecovery: true }),
  (error) => error.code === "PACKAGE_TRANSACTION_ACTIVE"
);
assert.equal(activeTransactionFixture.calls.some((call) => call[0] === "operator"), false);
await createLinuxPackageLifecycle({ runtime: pendingFixture.runtime }).repair({ artifactKind: "DEMONSTRATION_SERVER", upgradeRecovery: true });
assert.ok(pendingFixture.calls.some((call) => call[0] === "operator" && call[1] === "REPAIR"));

const degradedFixture = runtimeFixture({ waitForApplicationReady: async () => { const error = new Error("not ready"); error.code = "APPLICATION_NOT_READY"; throw error; } });
await assert.rejects(() => createLinuxPackageLifecycle({ runtime: degradedFixture.runtime }).setup({ artifactKind: "DEMONSTRATION_SERVER" }), (error) => error.code === "APPLICATION_NOT_READY");

const conflictFixture = runtimeFixture({ unitExists: async () => true });
await assert.rejects(
  () => createLinuxPackageLifecycle({ runtime: conflictFixture.runtime }).setup({ artifactKind: "DEMONSTRATION_SERVER" }),
  (error) => error?.code === "SERVER_FLAVOR_CONFLICT"
);
assert.equal(conflictFixture.calls.length, 0);

const wrongVersion = runtimeFixture({ postgresqlVersion: async () => "postgres (PostgreSQL) 17.9" });
await assert.rejects(
  () => createLinuxPackageLifecycle({ runtime: wrongVersion.runtime }).setup({ artifactKind: "OPERATIONAL_SERVER" }),
  (error) => error?.code === "POSTGRESQL_MAJOR_UNSUPPORTED"
);
assert.equal(wrongVersion.calls.some((call) => call[0] === "operator"), false);

const purgeFixture = runtimeFixture();
const purge = await createLinuxPackageLifecycle({ runtime: purgeFixture.runtime }).purge({
  artifactKind: "OPERATIONAL_SERVER",
  backupVerified: true,
  confirmation: {
    artifactKind: "OPERATIONAL_SERVER",
    irreversible: true,
    noRecoveryAcknowledged: false,
  },
});
assert.equal(purge.preserveMutableState, false);
assert.ok(purgeFixture.calls.some((call) => call[0] === "remove" && call.includes("/var/lib/quickhack/operational-server")));
assert.ok(purgeFixture.calls.some((call) => call[0] === "remove" && call.includes("/var/lib/quickhack/security/quickhack.postgresql.runtime.cred")));

const uninstall = lifecycle.uninstall({ artifactKind: "DEMONSTRATION_SERVER" });
assert.equal(uninstall.preserveMutableState, true);
assert.deepEqual(uninstall.removeMutablePaths, []);

const upgradeCalls = [];
const upgradeDirectory = mkdtempSync(path.join(os.tmpdir(), "quickhack-upgrade-test-"));
const markerPath = path.join(upgradeDirectory, "upgrade.pending");
try {
  const lifecycle = { repair: async (input) => { upgradeCalls.push(input); return { state: "ACTIVE" }; } };
  assert.deepEqual(await reconcileLinuxUpgrade("DEMONSTRATION_SERVER", { markerPath, lifecycle }), { state: "SKIPPED" });
  assert.deepEqual(upgradeCalls, []);
  writeFileSync(markerPath, "pending\n", { mode: 0o600 });
  assert.deepEqual(await reconcileLinuxUpgrade("DEMONSTRATION_SERVER", { markerPath, lifecycle }), { state: "ACTIVE" });
  assert.deepEqual(upgradeCalls, [{ artifactKind: "DEMONSTRATION_SERVER", upgradeReconcile: true }]);
  assert.equal(existsSync(markerPath), false);
  writeFileSync(markerPath, "pending\n", { mode: 0o600 });
  let stoppedUnit = "";
  await assert.rejects(() => reconcileLinuxUpgrade("OPERATIONAL_SERVER", {
    markerPath,
    lifecycle: { repair: async () => { throw new Error("repair failed"); } },
    stopConsole: async (unit) => { stoppedUnit = unit; },
  }), /repair failed/u);
  assert.equal(stoppedUnit, "quickhack-operational-console.service");
  assert.equal(existsSync(markerPath), true);
} finally {
  rmSync(upgradeDirectory, { recursive: true, force: true });
}

console.log("Linux setup, repair, conflict, dependency, preserve, and purge lifecycle verified.");
