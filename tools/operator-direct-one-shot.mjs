import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { defaultRestoreRequestHandoff } from "./operator-restore-handoff.mjs";

const OPERATIONS = Object.freeze(["MIGRATE", "RESTORE", "PROVISION_INITIAL_LEADER"]);

function resultMigrationError() {
  const error = new Error("The existing initial leader result requires operator recovery.");
  error.code = "INITIAL_LEADER_RESULT_MIGRATION_REQUIRED";
  return error;
}

function readPrivateResult(filename) {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024) throw resultMigrationError();
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function pathEntryExists(filename) {
  try { fs.lstatSync(filename); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

export function prepareInitialLeaderResultPath(dataDirectory, rootDirectory = "/var/lib/quickhack/security") {
  const identity = path.basename(path.resolve(dataDirectory));
  if (!/^(?:demonstration|operational)-server$/u.test(identity) && rootDirectory === "/var/lib/quickhack/security") {
    throw new TypeError("The initial leader result requires a packaged server data directory.");
  }
  const securityDirectory = path.resolve(rootDirectory);
  fs.mkdirSync(securityDirectory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(securityDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) {
    const error = new Error("The initial leader result directory is not private to the operator.");
    error.code = "INITIAL_LEADER_RESULT_DIRECTORY_INVALID";
    throw error;
  }
  const resultPath = path.join(securityDirectory, `${identity}-initial-leader-result`);
  const legacyPath = path.join(path.resolve(dataDirectory), "security", "initial-leader-result.json");
  if (!pathEntryExists(legacyPath)) return resultPath;
  const contents = readPrivateResult(legacyPath);
  try {
    if (pathEntryExists(resultPath)) {
      const published = readPrivateResult(resultPath);
      try { if (!contents.equals(published)) throw resultMigrationError(); }
      finally { published.fill(0); }
    } else {
      const temporary = path.join(securityDirectory, `.${identity}-initial-leader-result.${process.pid}.${randomUUID()}.tmp`);
      try {
        const descriptor = fs.openSync(temporary, "wx", 0o600);
        try {
          fs.writeFileSync(descriptor, contents);
          fs.fsyncSync(descriptor);
        } finally { fs.closeSync(descriptor); }
        fs.renameSync(temporary, resultPath);
        syncDirectory(securityDirectory);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    fs.unlinkSync(legacyPath);
  } finally { contents.fill(0); }
  return resultPath;
}

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
      const resultPath = prepareInitialLeaderResultPath(runtimeConfig.dataDirectory);
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
        error.code = /^([A-Z][A-Z0-9_]{2,63}):/u.exec(String(result.stderr ?? ""))?.[1] ?? "OPERATION_FAILED";
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
