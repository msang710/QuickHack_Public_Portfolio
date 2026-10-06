import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQuickHackOperator, waitForConsoleShutdown } from "../../tools/quickhack-operator-core.mjs";
import { parseArguments } from "../../tools/quickhack-operator.mjs";
import { createSystemdOneShotProcess, oneShotUnitsForPackageServices } from "../../tools/platform/linux/systemd-one-shot-process.mjs";
import { prepareInitialLeaderResultPath } from "../../tools/operator-direct-one-shot.mjs";
import { linuxArtifactConfig } from "../../packaging/linux/linux-artifact-config.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-operator-test-"));
assert.equal(parseArguments(["run-one-shot", "--operation", "provision-initial-leader", "--runtime-config", "/tmp/server-runtime.json"]).operation, "provision-initial-leader");
const resultRoot = path.join(temporary, "root-security");
assert.equal(prepareInitialLeaderResultPath(temporary, resultRoot), path.join(resultRoot, `${path.basename(temporary)}-initial-leader-result`));
assert.equal(fs.statSync(resultRoot).mode & 0o777, 0o700);
const legacyRoot = path.join(temporary, "legacy-data");
const legacySecurity = path.join(legacyRoot, "security");
fs.mkdirSync(legacySecurity, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(legacySecurity, "initial-leader-result.json"), "protected handoff", { mode: 0o600 });
const renameSync = fs.renameSync;
fs.renameSync = (source, destination) => {
  assert.equal(path.dirname(source), path.dirname(destination), "initial leader migration must publish on one filesystem");
  return renameSync(source, destination);
};
let migratedPath;
try { migratedPath = prepareInitialLeaderResultPath(legacyRoot, path.join(temporary, "migrated-root")); }
finally { fs.renameSync = renameSync; }
assert.equal(fs.readFileSync(migratedPath, "utf8"), "protected handoff");
assert.equal(fs.existsSync(path.join(legacySecurity, "initial-leader-result.json")), false);
assert.equal(fs.statSync(migratedPath).mode & 0o777, 0o600);
const retryRoot = path.join(temporary, "retry-data");
const retrySecurity = path.join(retryRoot, "security");
const retryTarget = path.join(temporary, "retry-root");
fs.mkdirSync(retrySecurity, { recursive: true, mode: 0o700 });
fs.mkdirSync(retryTarget, { mode: 0o700 });
fs.writeFileSync(path.join(retrySecurity, "initial-leader-result.json"), "same protected handoff", { mode: 0o600 });
fs.writeFileSync(path.join(retryTarget, "retry-data-initial-leader-result"), "same protected handoff", { mode: 0o600 });
assert.equal(prepareInitialLeaderResultPath(retryRoot, retryTarget), path.join(retryTarget, "retry-data-initial-leader-result"));
assert.equal(fs.existsSync(path.join(retrySecurity, "initial-leader-result.json")), false);
fs.writeFileSync(path.join(retrySecurity, "initial-leader-result.json"), "different handoff", { mode: 0o600 });
assert.throws(() => prepareInitialLeaderResultPath(retryRoot, retryTarget), (error) => error.code === "INITIAL_LEADER_RESULT_MIGRATION_REQUIRED");
const calls = [];
const dependencies = {
  runtimeConfig: () => ({ dataDirectory: temporary }),
  operatorLockDirectory: () => path.join(temporary, "root-lock"),
  postgresqlService: {
    async install() { calls.push("install"); return { fresh: true }; },
    async repair() { calls.push("repair"); return { fresh: false }; },
  },
  oneShot: { async execute(operation) { calls.push(operation); return { operation, state: "COMPLETED" }; } },
  directOneShot: { async execute(operation) { calls.push(`direct:${operation}`); return { operation, secret: "must-not-leak" }; } },
  applicationService: { async operate(operation, service) { calls.push(`${operation}:${service}`); return { operation, service }; } },
  authorizeQhkey: async (transactionId) => { calls.push("qhkey"); return { transactionId, authorized: true }; },
};
const operator = createQuickHackOperator(dependencies);
const userAuthorization = createQuickHackOperator({
  ...dependencies,
  runtimeConfig: () => { throw new Error("The desktop user cannot read the root-owned runtime config."); },
  operatorLockDirectory: () => { throw new Error("Authorization must use the QHKEY transaction lock."); },
});
assert.equal((await userAuthorization.execute({ command: "authorize-qhkey", transactionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" })).result.authorized, true);
calls.pop();
const shutdownId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
let shutdownPolls = 0;
const stopped = await waitForConsoleShutdown(shutdownId, async () => ({ shutdown: {
  operationId: shutdownId,
  phase: ++shutdownPolls === 1 ? "DRAINING" : "STOPPED",
  completedAt: shutdownPolls === 1 ? null : new Date().toISOString(),
} }), { sleep: async () => {} });
assert.equal(stopped.state, "COMPLETED");
assert.equal(shutdownPolls, 2);
const pending = await waitForConsoleShutdown(shutdownId, async () => ({ shutdown: {
  operationId: shutdownId, phase: "WAITING_FOR_SAFE_STOP", completedAt: null,
} }), { timeoutMs: 0 });
assert.equal(pending.state, "IN_PROGRESS");
const pendingStopOperator = createQuickHackOperator({
  ...dependencies,
  stopWaitMs: 0,
  consoleRequest: async (pathname) => pathname === "/api/application/stop"
    ? { shutdown: { operationId: shutdownId, phase: "DRAINING", completedAt: null } }
    : { shutdown: { operationId: shutdownId, phase: "DRAINING", completedAt: null } },
});
assert.equal((await pendingStopOperator.execute({ command: "stop" })).state, "IN_PROGRESS");
const completedStopOperator = createQuickHackOperator({
  ...dependencies,
  consoleRequest: async (pathname) => pathname === "/api/application/stop"
    ? { shutdown: { operationId: shutdownId, phase: "DRAINING", completedAt: null } }
    : { shutdown: { operationId: shutdownId, phase: "STOPPED", completedAt: new Date().toISOString() } },
});
assert.equal((await completedStopOperator.execute({ command: "stop" })).state, "COMPLETED");
await assert.rejects(
  () => waitForConsoleShutdown(shutdownId, async () => ({ shutdown: { operationId: "different" } })),
  (error) => error.code === "SHUTDOWN_OPERATION_CHANGED"
);
assert.equal((await operator.execute({ command: "install" })).state, "COMPLETED");
assert.equal(fs.statSync(path.join(temporary, "root-lock")).mode & 0o777, 0o700);
assert.equal(fs.existsSync(path.join(temporary, "state", "operator")), false);
assert.equal((await operator.execute({ command: "repair" })).state, "COMPLETED");
assert.equal((await operator.execute({ command: "migrate" })).state, "COMPLETED");
assert.equal((await operator.execute({ command: "provision-initial-leader" })).state, "COMPLETED");
const direct = await operator.execute({ command: "run-one-shot", operation: "migrate" });
assert.equal(JSON.stringify(direct).includes("must-not-leak"), false);
await assert.rejects(() => operator.execute({ command: "delete" }), (error) => error.code === "OPERATOR_COMMAND_INVALID");
assert.deepEqual(calls, [
  "install",
  "MIGRATE",
  "PROVISION_INITIAL_LEADER",
  "repair",
  "MIGRATE",
  "PROVISION_INITIAL_LEADER",
  "MIGRATE",
  "PROVISION_INITIAL_LEADER",
  "direct:migrate",
]);
const bootstrapCalls = [];
const bootstrappingOperator = createQuickHackOperator({
  ...dependencies,
  postgresqlService: { install: async () => { bootstrapCalls.push("postgresql"); } },
  oneShot: { execute: async (operation) => { bootstrapCalls.push(operation); } },
  applicationCredentials: { ensure: async () => { bootstrapCalls.push("credentials"); return { created: 4 }; } },
  applicationService: { operate: async () => { bootstrapCalls.push("application"); } },
});
await bootstrappingOperator.execute({ command: "install" });
assert.deepEqual(bootstrapCalls, ["postgresql", "MIGRATE", "credentials", "PROVISION_INITIAL_LEADER"]);

const failedSteps = [];
const failingOperator = createQuickHackOperator({
  ...dependencies,
  postgresqlService: {
    async install() {
      failedSteps.push("install");
      return { fresh: true, secret: "must-not-leak" };
    },
    async repair() {
      throw new Error("unused");
    },
  },
  oneShot: {
    async execute(operation) {
      failedSteps.push(operation);
      const error = new Error("Migration failed without secret output.");
      error.code = "MIGRATION_FAILED";
      throw error;
    },
  },
});
await assert.rejects(
  () => failingOperator.execute({ command: "install" }),
  (error) => {
    assert.equal(error.code, "MIGRATION_FAILED");
    assert.equal(error.partialResult.length, 1);
    assert.equal(JSON.stringify(error.partialResult).includes("must-not-leak"), false);
    return true;
  }
);
assert.deepEqual(failedSteps, ["install", "MIGRATE"]);

const restoreFailureCalls = [];
const restoreFailureOperator = createQuickHackOperator({
  ...dependencies,
  prepareOneShot: async (operation) => {
    restoreFailureCalls.push(`prepare:${operation}`);
    return { kind: "QUICKHACK_RESTORE_REQUEST", operationId: "restore-operation" };
  },
  cleanupPreparedOneShot: async (receipt) => {
    restoreFailureCalls.push(`cleanup:${receipt.operationId}`);
    return true;
  },
  oneShot: {
    async execute(operation) {
      restoreFailureCalls.push(`start:${operation}`);
      const error = new Error("simulated one-shot start failure");
      error.code = "OPERATION_FAILED";
      throw error;
    },
  },
});
await assert.rejects(
  () => restoreFailureOperator.execute({ command: "restore", backupFile: "backup.qhb" }),
  (error) => error.code === "OPERATION_FAILED"
);
assert.deepEqual(restoreFailureCalls, [
  "prepare:RESTORE",
  "start:RESTORE",
  "cleanup:restore-operation",
]);

const unclaimedSuccessOperator = createQuickHackOperator({
  ...dependencies,
  prepareOneShot: async () => ({ kind: "QUICKHACK_RESTORE_REQUEST", operationId: "unclaimed-operation" }),
  cleanupPreparedOneShot: async () => true,
  oneShot: { async execute(operation) { return { operation, state: "COMPLETED" }; } },
});
await assert.rejects(
  () => unclaimedSuccessOperator.execute({ command: "restore", backupFile: "backup.qhb" }),
  (error) => error.code === "RESTORE_REQUEST_NOT_CLAIMED"
);

const systemdCalls = [];
const systemd = createSystemdOneShotProcess({ run: async (args) => {
  systemdCalls.push(args);
  return args[0] === "show" ? "Result=success\nExecMainStatus=0\nActiveState=inactive\n" : "";
} });
assert.equal((await systemd.execute("RESTORE")).unit, "quickhack-operator@restore.service");
assert.deepEqual(systemdCalls[0], ["start", "quickhack-operator@restore.service", "--wait"]);
await assert.rejects(() => systemd.execute("arbitrary"), (error) => error.code === "OPERATOR_COMMAND_INVALID");
for (const target of ["demo-server", "operational-server"]) {
  const services = linuxArtifactConfig(target).services;
  const units = oneShotUnitsForPackageServices(services);
  const actualCalls = [];
  const packaged = createSystemdOneShotProcess({ units, run: async (args) => {
    actualCalls.push(args);
    return args[0] === "show" ? "Result=success\nExecMainStatus=0\nActiveState=inactive\n" : "";
  } });
  assert.equal((await packaged.execute("MIGRATE")).unit, services.migrate);
  assert.equal((await packaged.execute("PROVISION_INITIAL_LEADER")).unit, services.initialLeader);
  assert.equal((await packaged.execute("RESTORE")).unit, services.operator.replace("@.service", "@restore.service"));
  assert.deepEqual(actualCalls[0], ["start", services.migrate, "--wait"]);
}
assert.throws(() => oneShotUnitsForPackageServices({ migrate: "valid.service", operator: "bad.service" }), /template/);

const consoleLauncher = fs.readFileSync(
  new URL("../../packaging/linux/launchers/quickhack-console.in", import.meta.url),
  "utf8"
);
const qhkeyLauncher = fs.readFileSync(
  new URL("../../packaging/linux/launchers/quickhack-qhkey-authorize.in", import.meta.url),
  "utf8"
);
assert.match(consoleLauncher, /exec "@QUICKHACK_NODE_EXECUTABLE@" "@QUICKHACK_OPERATOR_ENTRY@" open-console/u);
assert.match(qhkeyLauncher, /authorize-qhkey/u);
assert.match(qhkeyLauncher, /--transaction "\$1"/u);
assert.doesNotMatch(qhkeyLauncher, /\b(?:sudo|pkexec)\b/u);

fs.rmSync(temporary, { recursive: true, force: true });
console.log("Finite QuickHack operator commands, one-shot units, locking, and result redaction verified.");
