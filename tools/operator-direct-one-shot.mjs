import fs from "node:fs";
import path from "node:path";

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

function restoreRequestPath(runtimeConfig) {
  return path.join(path.resolve(runtimeConfig.dataDirectory), "state", "operator", "restore-request.json");
}

export function prepareOperatorOneShotRequest(operationValue, input, runtimeConfig) {
  const operation = assertOperation(operationValue);
  if (operation !== "RESTORE") return;
  const backupFile = String(input.backupFile ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.qhb$/u.test(backupFile)) {
    const error = new Error("Restore requires a finite backup file name from the QuickHack backup directory.");
    error.code = "RESTORE_REQUEST_INVALID";
    throw error;
  }
  const requestPath = restoreRequestPath(runtimeConfig);
  fs.mkdirSync(path.dirname(requestPath), { recursive: true, mode: 0o700 });
  const handle = fs.openSync(requestPath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify({ schemaVersion: 1, backupFile })}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function readRestoreRequest(runtimeConfig) {
  const requestPath = restoreRequestPath(runtimeConfig);
  const stat = fs.lstatSync(requestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("The restore request is invalid.");
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.qhb$/u.test(String(request.backupFile ?? ""))) {
    throw new Error("The restore request backup file is invalid.");
  }
  return { requestPath, backupFile: request.backupFile };
}

export function createDirectOperatorOneShot(options) {
  const runtime = options.runtime;
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
    if (operation === "MIGRATE") {
      entry = path.join(root, "tools", "deploy-postgresql-migrations.mjs");
      args = [entry, "--runtime-config", runtimeConfigPath];
    } else if (operation === "PROVISION_INITIAL_LEADER") {
      entry = path.join(root, "tools", "provision-initial-leader.mjs");
      const resultPath = path.join(runtimeConfig.dataDirectory, "security", "initial-leader-result.json");
      args = [entry, "--runtime-config", runtimeConfigPath, "--result-file", resultPath, "--allow-create"];
    } else {
      entry = path.join(root, "tools", "postgresql-restore.mjs");
      restoreRequest = readRestoreRequest(runtimeConfig);
      args = [entry, "--install-dir", installDir, "--runtime-config", runtimeConfigPath, "--backup-file", restoreRequest.backupFile];
    }
    if (!fs.existsSync(entry)) {
      const error = new Error("The packaged operator entry is unavailable.");
      error.code = "DEPENDENCY_MISSING";
      throw error;
    }
    try {
      const result = await runtime.execFileText(nodeExecutable, args, { cwd: root, env: environment, timeout: 60 * 60_000 });
      if (!result.ok) {
        const error = new Error("The one-shot operator process failed.");
        error.code = "OPERATION_FAILED";
        throw error;
      }
      return Object.freeze({ operation, state: "COMPLETED" });
    } finally {
      if (restoreRequest) fs.rmSync(restoreRequest.requestPath, { force: true });
    }
  }

  return Object.freeze({ execute });
}
