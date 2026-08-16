import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const QUICKHACK_OPERATOR_COMMANDS = Object.freeze([
  "INSTALL",
  "REPAIR",
  "START",
  "STOP",
  "STATUS",
  "OPEN_CONSOLE",
  "MIGRATE",
  "BACKUP",
  "RESTORE",
  "PROVISION_INITIAL_LEADER",
  "AUTHORIZE_QHKEY",
  "RUN_ONE_SHOT",
]);

const COMMAND_SET = new Set(QUICKHACK_OPERATOR_COMMANDS);
const MUTATING_COMMANDS = new Set(
  QUICKHACK_OPERATOR_COMMANDS.filter((item) => !["STATUS", "OPEN_CONSOLE", "RUN_ONE_SHOT"].includes(item))
);

function assertCommand(value) {
  const command = String(value ?? "").trim().replaceAll("-", "_").toUpperCase();
  if (!COMMAND_SET.has(command)) {
    const error = new Error("The operator command is not supported.");
    error.code = "OPERATOR_COMMAND_INVALID";
    throw error;
  }
  return command;
}

function processExists(pid) {
  try {
    process.kill(Number(pid), 0);
    return Number(pid) > 0;
  } catch {
    return false;
  }
}

function acquireLock(stateDirectory, command) {
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDirectory, "quickhack-operator.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(handle, `${JSON.stringify({ schemaVersion: 1, command, pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
      fs.closeSync(handle);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      let current;
      try {
        const stat = fs.lstatSync(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("invalid lock");
        current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        const invalid = new Error("The operator lock requires administrator review.");
        invalid.code = "OPERATION_LOCK_INVALID";
        throw invalid;
      }
      if (processExists(current?.pid)) {
        const active = new Error("Another QuickHack operator operation is already running.");
        active.code = "OPERATION_IN_PROGRESS";
        throw active;
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error("The operator lock could not be acquired.");
}

function sanitized(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value ?? null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitized(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|secret|token|ciphertext|connection|string|credentialpath)/iu.test(key)) continue;
    result[key] = sanitized(item, depth + 1);
  }
  return result;
}

export function readConsoleActionToken(dataDirectory) {
  const tokenPath = path.join(path.resolve(dataDirectory), "state", "operator", "server-console-action.json");
  const stat = fs.lstatSync(tokenPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    const error = new Error("The server console authorization state is invalid.");
    error.code = "CONSOLE_UNAVAILABLE";
    throw error;
  }
  const value = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  if (!/^[a-f0-9]{64}$/u.test(String(value?.token ?? "")) || !processExists(value?.pid)) {
    const error = new Error("The server console is unavailable.");
    error.code = "CONSOLE_UNAVAILABLE";
    throw error;
  }
  return value.token;
}

export function callLocalServerConsole(dataDirectory, pathname, options = {}) {
  const token = readConsoleActionToken(dataDirectory);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: 2999,
      path: pathname,
      method: options.method ?? "POST",
      timeout: options.timeoutMs ?? 60_000,
      headers: { "X-QuickHack-Console-Token": token },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300 || payload.ok === false) {
          const error = new Error(payload.message || "The server console operation failed.");
          error.code = payload.code || "CONSOLE_OPERATION_FAILED";
          reject(error);
          return;
        }
        resolve(payload);
      });
    });
    request.on("timeout", () => request.destroy(new Error("The server console operation timed out.")));
    request.on("error", reject);
    request.end();
  });
}

export function createQuickHackOperator(dependencies) {
  for (const name of ["runtimeConfig", "postgresqlService", "oneShot", "directOneShot", "applicationService", "authorizeQhkey"]) {
    if (!dependencies?.[name]) throw new TypeError(`QuickHack operator dependency is missing: ${name}.`);
  }

  async function execute(input) {
    const command = assertCommand(input.command);
    const runtimeConfig = dependencies.runtimeConfig(input);
    const dataDirectory = path.resolve(runtimeConfig.dataDirectory);
    const stateDirectory = path.join(dataDirectory, "state", "operator");
    const release = MUTATING_COMMANDS.has(command) ? acquireLock(stateDirectory, command) : () => undefined;
    const partialResult = [];
    try {
      let result;
      if (command === "STATUS") result = await callLocalServerConsole(dataDirectory, "/api/status", { method: "GET", timeoutMs: 5000 });
      else if (command === "OPEN_CONSOLE") {
        await callLocalServerConsole(dataDirectory, "/api/status", { method: "GET", timeoutMs: 5000 });
        const url = "http://127.0.0.1:2999";
        result = { url, opened: dependencies.openConsole?.(url) !== false };
      }
      else if (command === "START") result = await callLocalServerConsole(dataDirectory, "/api/application/start");
      else if (command === "STOP") result = await callLocalServerConsole(dataDirectory, "/api/application/stop");
      else if (command === "BACKUP") result = await callLocalServerConsole(dataDirectory, "/api/operator/backup", { timeoutMs: 60 * 60_000 });
      else if (command === "INSTALL") {
        partialResult.push({ step: "POSTGRESQL", result: await dependencies.postgresqlService.install(input) });
        partialResult.push({ step: "MIGRATE", result: await dependencies.oneShot.execute("MIGRATE", input) });
        partialResult.push({ step: "PROVISION_INITIAL_LEADER", result: await dependencies.oneShot.execute("PROVISION_INITIAL_LEADER", input) });
        partialResult.push({ step: "APPLICATION", result: await dependencies.applicationService.operate("START", "APPLICATION") });
        result = { steps: partialResult };
      }
      else if (command === "REPAIR") {
        partialResult.push({ step: "POSTGRESQL", result: await dependencies.postgresqlService.repair(input) });
        partialResult.push({ step: "MIGRATE", result: await dependencies.oneShot.execute("MIGRATE", input) });
        partialResult.push({ step: "APPLICATION", result: await dependencies.applicationService.operate("RESTART", "APPLICATION") });
        result = { steps: partialResult };
      }
      else if (["MIGRATE", "RESTORE", "PROVISION_INITIAL_LEADER"].includes(command)) {
        if (typeof dependencies.prepareOneShot === "function") {
          await dependencies.prepareOneShot(command, input, runtimeConfig);
        }
        result = await dependencies.oneShot.execute(command, input);
      }
      else if (command === "AUTHORIZE_QHKEY") result = await dependencies.authorizeQhkey(input.transactionId);
      else if (command === "RUN_ONE_SHOT") result = await dependencies.directOneShot.execute(input.operation, input);
      return Object.freeze({ command, state: "COMPLETED", result: sanitized(result) });
    } catch (error) {
      const failure = new Error(error instanceof Error ? error.message : "The operator operation failed.");
      failure.code = error?.code || "OPERATOR_OPERATION_FAILED";
      if (partialResult.length > 0) failure.partialResult = sanitized(partialResult);
      throw failure;
    } finally {
      release();
    }
  }

  return Object.freeze({ execute });
}
