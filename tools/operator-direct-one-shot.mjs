import fs from "node:fs";
import path from "node:path";
import { defaultRestoreRequestHandoff } from "./operator-restore-handoff.mjs";

const OPERATIONS = Object.freeze(["MIGRATE", "RESTORE", "PROVISION_INITIAL_LEADER"]);

function assertOperation(value) {
  const operation = String(value ?? "").trim().replaceAll("-", "_").toUpperCase();
  if (!OPERATIONS.includes(operation)) {
    const error = new Error("The direct operator operation is invalid.");
    error.code = "OPERATOR_COMMAND_INVALID";
    throw error;
  }
  return operation;
}

export function prepareOperatorOneShotRequest(operationValue, input, runtimeConfig) {
  const operation = assertOperation(operationValue);
  if (operation !== "RESTORE") return;
  return defaultRestoreRequestHandoff.prepare(input.backupFile, runtimeConfig);
}

export function cleanupOperatorOneShotRequest(preparedRequest) {
  return defaultRestoreRequestHandoff.cleanupUnclaimed(preparedRequest);
}

export function createDirectOperatorOneShot(options) {
  const runtime = options.runtime;
  const restoreHandoff = options.restoreHandoff ?? defaultRestoreRequestHandoff;
  const root = path.resolve(options.root);
  const nodeExecutable = path.resolve(options.nodeExecutable ?? process.execPath);
  if (!runtime || typeof runtime.execFileText !== "function") throw new TypeError("The operator runtime is required.");

  async function execute(operationValue, input) {
    const operation = assertOperation(operationValue);
    const runtimeConfigPath = path.resolve(input.runtimeConfigPath);
    const runtimeConfig = options.readRuntimeConfig(runtimeConfigPath);
    const installDir = path.resolve(input.installDir ?? root);
    const credentialsDirectory = String(process.env.CREDENTIALS_DIRECTORY ?? "").trim();
    const environment = runtime.childEnvironment({
      executableDirectories: [path.dirname(nodeExecutable)],
      overrides: { CREDENTIALS_DIRECTORY: credentialsDirectory || undefined },
    });
    let entry;
    let args;
    let restoreRequest;
    let restoreTerminalState = "FAILED";
    if (operation === "MIGRATE") {
      entry = path.join(root, "tools", "deploy-postgresql-migrations.mjs");
      args = [entry, "--runtime-config", runtimeConfigPath];
    } else if (operation === "PROVISION_INITIAL_LEADER") {
      entry = path.join(root, "tools", "provision-initial-leader.mjs");
      const resultPath = path.join(runtimeConfig.dataDirectory, "security", "initial-leader-result.json");
      args = [entry, "--runtime-config", runtimeConfigPath, "--result-file", resultPath, "--allow-create"];
    } else {
      entry = path.join(root, "tools", "postgresql-restore.mjs");
      restoreRequest = restoreHandoff.claim(runtimeConfig);
      args = [entry, "--install-dir", installDir, "--runtime-config", runtimeConfigPath, "--backup-file", restoreRequest.backupFile];
    }
    try {
      if (!fs.existsSync(entry)) {
        const error = new Error("The packaged operator entry is unavailable.");
        error.code = "DEPENDENCY_MISSING";
        throw error;
      }
      const result = await runtime.execFileText(nodeExecutable, args, { cwd: root, env: environment, timeout: 60 * 60_000 });
      if (!result.ok) {
        const error = new Error("The one-shot operator process failed.");
        error.code = "OPERATION_FAILED";
        throw error;
      }
      if (restoreRequest) restoreTerminalState = "SUCCEEDED";
      return Object.freeze({ operation, state: "COMPLETED" });
    } finally {
      if (restoreRequest) restoreHandoff.finalize(restoreRequest, restoreTerminalState);
    }
  }

  return Object.freeze({ execute });
}
