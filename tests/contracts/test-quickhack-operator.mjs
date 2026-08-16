import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQuickHackOperator } from "../../tools/quickhack-operator-core.mjs";
import { createSystemdOneShotProcess } from "../../tools/platform/linux/systemd-one-shot-process.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-operator-test-"));
const calls = [];
const dependencies = {
  runtimeConfig: () => ({ dataDirectory: temporary }),
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
assert.equal((await operator.execute({ command: "install" })).state, "COMPLETED");
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
  "START:APPLICATION",
  "repair",
  "MIGRATE",
  "RESTART:APPLICATION",
  "MIGRATE",
  "PROVISION_INITIAL_LEADER",
  "direct:migrate",
]);

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

const systemdCalls = [];
const systemd = createSystemdOneShotProcess({ run: async (args) => {
  systemdCalls.push(args);
  return args[0] === "show" ? "Result=success\nExecMainStatus=0\nActiveState=inactive\n" : "";
} });
assert.equal((await systemd.execute("RESTORE")).unit, "quickhack-operator@restore.service");
assert.deepEqual(systemdCalls[0], ["start", "quickhack-operator@restore.service", "--wait"]);
await assert.rejects(() => systemd.execute("arbitrary"), (error) => error.code === "OPERATOR_COMMAND_INVALID");

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
