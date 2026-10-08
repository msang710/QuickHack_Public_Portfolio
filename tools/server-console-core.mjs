import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeServerPlatform } from "../quickhack_server/platform/compose-server-platform.ts";
import {
  readServerRuntimeConfigSync,
  sourceServerRuntimeConfigPath,
  validateServerRuntimeConfig,
} from "../quickhack_shared/core/server-runtime-config.mjs";
import { assertPackageFlavor } from "../quickhack_shared/core/package-flavor-contract.mjs";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";
import { getQuickHackTlsStatus, initializeQuickHackTls } from "./server-console-tls.mjs";
import { assertPortAvailable, createLifecycleQueue, waitForOwnedReady } from "./server-console-lifecycle.mjs";
import { captureSafeChildOutput } from "./server-console-child-output.mjs";
import { recoverServerRuntimeSettings, runtimeSettingsMarkerPath, updateServerRuntimeSettings } from "./server-console-runtime-settings.mjs";
import { initialTlsHosts, tlsHostSelectionStatus } from "./platform/linux/initial-tls-setup.mjs";
import { resolveServerConsoleLocale, serverConsoleMessages } from "./server-console-i18n.mjs";
import { renderRestoredServerConsolePage } from "./server-console-page.mjs";
import { createQuickHackShutdownCoordinator } from "./quickhack-shutdown-coordinator.mjs";
import { packageReadinessDigest } from "./package-readiness-proof.mjs";
import {
  cancelQhkeyReplacement,
  getQhkeyConsoleStatus,
  getQhkeyReplacementStatus,
} from "./server-console-qhkey-common.mjs";

const DEFAULT_PORTS = Object.freeze({ console: 2999, backend: 3000, gateway: 3443 });

export function mainServerState({ database, backend, gateway, tlsReady, backendReadiness, coreProcessRunning }) {
  if (database.state === "ACTIVE" && backend.ok && gateway.ok && tlsReady && backendReadiness.databaseReady === true) return "ACTIVE";
  return coreProcessRunning || backend.ok || gateway.ok ? "DEGRADED" : "INACTIVE";
}

const RESTORE_BARRIER_PROTOCOL = "QUICKHACK_POSTGRESQL_RESTORE_BARRIER_V1";
const RESTORE_BARRIER_FILE_NAME = "postgresql-restore-barrier.json";

function requiredPathArgument(argv, index, name) {
  const value = String(argv[index + 1] ?? "").trim();
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${name} requires a file path.`);
  }
  return path.resolve(value);
}

export function parseServerConsoleArguments(argv) {
  const result = {
    runtimeConfigPath: "",
    packageManifestPath: "",
    noOpen: false,
    systemService: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--runtime-config") {
      result.runtimeConfigPath = requiredPathArgument(argv, index, argument);
      index += 1;
    } else if (argument === "--package-manifest") {
      result.packageManifestPath = requiredPathArgument(argv, index, argument);
      index += 1;
    } else if (argument === "--no-open") result.noOpen = true;
    else if (argument === "--system-service") result.systemService = true;
    else throw new TypeError(`Unsupported server console argument: ${argument}`);
  }
  return result;
}

export function assertConsoleConfigDirectory(configPath) {
  const directory = path.dirname(path.resolve(configPath));
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o002) !== 0)) {
    const error = new Error("The console configuration directory is unsafe.");
    error.code = "RUNTIME_DIRECTORY_INVALID";
    throw error;
  }
  return directory;
}

function json(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function html(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function readRequestBody(request, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        const error = new Error("The console request body is too large.");
        error.code = "REQUEST_TOO_LARGE";
        error.statusCode = 413;
        reject(error);
        request.destroy();
      }
    });
    request.once("end", () => {
      const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
      try {
        if (contentType.includes("application/json")) return resolve(body ? JSON.parse(body) : {});
        return resolve(Object.fromEntries(new URLSearchParams(body)));
      } catch {
        const error = new Error("The console request body is invalid.");
        error.code = "REQUEST_INVALID";
        error.statusCode = 400;
        return reject(error);
      }
    });
    request.once("error", reject);
  });
}

function redactedPublicValue(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value ?? null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactedPublicValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|secret|token|ciphertext|connection|string|credentialpath|filepath|masterkeyfile|rootpath|stagepath)/iu.test(key)) continue;
    result[key] = redactedPublicValue(item, depth + 1);
  }
  return result;
}

function health(url, timeoutMs = 1200) {
  return fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) })
    .then((response) => ({ ok: response.ok, status: response.status, error: "" }))
    .catch((error) => ({ ok: false, status: null, error: String(error?.code ?? "UNREACHABLE") }));
}

function secureHealth(url, caFile, timeoutMs = 1200, expectedInstanceId = "") {
  return new Promise((resolve) => {
    const request = httpsRequest(url, { method: "GET", ca: fs.readFileSync(caFile), timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 4096) response.destroy();
        else chunks.push(chunk);
      });
      response.once("end", () => {
        let identityMatches = true;
        if (expectedInstanceId) {
          try { identityMatches = JSON.parse(Buffer.concat(chunks).toString("utf8")).instanceId === expectedInstanceId; }
          catch { identityMatches = false; }
        }
        resolve({ ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300 && identityMatches), status: response.statusCode ?? null, error: identityMatches ? "" : "INSTANCE_MISMATCH" });
      });
      response.once("error", () => resolve({ ok: false, status: null, error: "UNREACHABLE" }));
      response.once("close", () => resolve({ ok: false, status: null, error: "UNREACHABLE" }));
    });
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", () => resolve({ ok: false, status: null, error: "UNREACHABLE" }));
    request.end();
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function requestGatewayDrain(caFile, token) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(`https://127.0.0.1:${DEFAULT_PORTS.gateway}/__quickhack_gateway_shutdown`, {
      method: "POST", ca: fs.readFileSync(caFile), timeout: 5_000,
      headers: { "X-QuickHack-Supervisor-Token": token },
    }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 202 ? resolve() : reject(Object.assign(new Error("Gateway drain was rejected."), { code: "GATEWAY_DRAIN_REJECTED" })));
    });
    request.once("timeout", () => request.destroy(Object.assign(new Error("Gateway drain timed out."), { code: "GATEWAY_DRAIN_TIMEOUT" })));
    request.once("error", reject);
    request.end();
  });
}

function serverPlan(root, nodeExecutable) {
  const candidates = [
    { entry: path.join(root, "server", "server.js"), cwd: path.join(root, "server"), mode: "standalone-package" },
    { entry: path.join(root, ".next", "standalone", "server.js"), cwd: path.join(root, ".next", "standalone"), mode: "standalone-local" },
    { entry: path.join(root, "node_modules", "next", "dist", "bin", "next"), cwd: root, mode: "next-dev" },
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate.entry));
  if (!found) return null;
  const args = found.mode === "next-dev"
    ? [found.entry, "dev", "--hostname", "127.0.0.1", "--port", String(DEFAULT_PORTS.backend)]
    : [found.entry];
  return Object.freeze({ ...found, nodeExecutable, args: Object.freeze(args) });
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeActionTokenFile(filePath, token, packageReadinessSecret) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(filePath, "wx", 0o600);
      try {
        fs.writeFileSync(handle, `${JSON.stringify({ schemaVersion: 2, token, packageReadinessSecret, pid: process.pid })}\n`, "utf8");
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      return;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      let existing = null;
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("The console action token path is invalid.");
        existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (readError) {
        throw new Error(`The existing console action token cannot be verified: ${readError.message}`);
      }
      if (processExists(Number(existing?.pid))) {
        const running = new Error("Another QuickHack server console is already running.");
        running.code = "CONSOLE_ALREADY_RUNNING";
        throw running;
      }
      fs.rmSync(filePath, { force: true });
    }
  }
}

function readRestoreBarrier(dataDirectory) {
  const filePath = path.join(path.resolve(dataDirectory), "security", RESTORE_BARRIER_FILE_NAME);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16 * 1024) {
    const error = new Error("The PostgreSQL restore barrier is invalid.");
    error.code = "RESTORE_BARRIER_INVALID";
    throw error;
  }
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (
    value?.protocol !== RESTORE_BARRIER_PROTOCOL ||
    !Number.isSafeInteger(value.expectedInstanceEpoch) ||
    value.expectedInstanceEpoch < 1 ||
    !["STAGING_READY", "LIVE_RENAMED", "DATABASE_ACTIVATED", "CUTOVER_COMPLETE"].includes(value.cutoverPhase) ||
    ![value.liveDatabase, value.stagingDatabase, value.previousDatabase].every((database) => /^[a-z][a-z0-9_]{0,62}$/u.test(String(database ?? "")))
  ) {
    const error = new Error("The PostgreSQL restore barrier payload is invalid.");
    error.code = "RESTORE_BARRIER_INVALID";
    throw error;
  }
  return Object.freeze({ filePath, device: stat.dev, inode: stat.ino, expectedInstanceEpoch: value.expectedInstanceEpoch, cutoverPhase: value.cutoverPhase });
}

function gatewayPlan(root, nodeExecutable, dataDir) {
  const entry = path.join(root, "tools", "quickhack-https-gateway.mjs");
  if (!fs.existsSync(entry)) return null;
  const tls = getQuickHackTlsStatus(dataDir);
  if (!tls.ready) return null;
  return Object.freeze({ entry, nodeExecutable, args: Object.freeze([entry]), cwd: root, tls });
}

function tlsHostSelection(runtimeConfig, sourceMode = false) {
  return initialTlsHosts(undefined, undefined, runtimeConfig.publicHost, sourceMode);
}

export function renderServerConsolePage(input) {
  return renderRestoredServerConsolePage(input);
}

export function createServerConsole(input) {
  const flavor = assertPackageFlavor(input.flavor);
  const integration = input.integration;
  if (!integration || integration.flavor !== flavor) throw new TypeError("The console integration composition does not match its package flavor.");
  const root = path.resolve(input.root ?? path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
  const args = input.arguments ?? parseServerConsoleArguments(process.argv.slice(2));
  const runningManifest = args.packageManifestPath
    ? JSON.parse(fs.readFileSync(args.packageManifestPath, "utf8"))
    : null;
  const runtimeVersion = String(runningManifest?.version ?? "");
  const runtimeBuildId = String(runningManifest?.contentInventorySha256 ?? "");
  const runtimeConfigPath = args.runtimeConfigPath || sourceServerRuntimeConfigPath(root);
  const runtime = (input.operatorPlatform ?? composeOperatorPlatform()).serverConsoleRuntime;
  const serverPlatform = input.serverPlatform ?? composeServerPlatform();
  const nodeExecutable = path.resolve(input.nodeExecutable ?? process.execPath);
  const actionToken = crypto.randomBytes(32).toString("hex");
  const packageReadinessSecret = crypto.randomBytes(32).toString("hex");
  const managed = new Map();
  const readyOwned = new WeakSet();
  const ownedInstances = new Map();
  const credentialHandoffs = new Map();
  const logLines = [];
  let logSequence = 0;
  let stopping = false;
  let lastError = null;
  let actionTokenPath = "";
  const serializeLifecycle = createLifecycleQueue();
  let shutdownOwned = [];
  let shutdownScopeIds = [];
  const shutdown = createQuickHackShutdownCoordinator({
    beginGatewayDrain: async () => {
      const gateway = shutdownOwned.find(({ id }) => id === "gateway");
      if (!gateway || gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
      try {
        await requestGatewayDrain(getQuickHackTlsStatus(config().dataDirectory).paths.rootCaPem, actionToken);
      } catch (error) {
        if (gateway.child.exitCode === null && gateway.child.signalCode === null) throw error;
      }
    },
    quiesceBackend: ({ operationId, reason, warningEpochMs }) =>
      shutdownOwned.some(({ id }) => id === "backend")
        ? callBackend("/api/internal/supervisor/shutdown", "POST", { action: "quiesce", operationId, reason, warningEpochMs })
        : Promise.resolve(null),
    getBackendStatus: (operationId) =>
      shutdownOwned.some(({ id }) => id === "backend")
        ? callBackend("/api/internal/supervisor/shutdown", "POST", { action: "status", operationId }, 5_000)
        : Promise.resolve(null),
    finalizeBackend: (operationId) =>
      shutdownOwned.some(({ id }) => id === "backend")
        ? callBackend("/api/internal/supervisor/shutdown", "POST", { action: "finalize", operationId }, 600_000)
        : Promise.resolve(null),
    terminateBackend: async (operationId) => {
      const backend = shutdownOwned.find(({ id }) => id === "backend");
      if (backend) {
        await callBackend("/api/internal/supervisor/shutdown", "POST", { action: "terminate", operationId });
        if (!(await waitForExit(backend.child, 10_000))) throw Object.assign(new Error("Backend did not exit after finalization."), { code: "BACKEND_EXIT_TIMEOUT" });
      }
      for (const { id } of shutdownOwned) {
        if (id !== "backend" && id !== "gateway") await stopOwned(id);
      }
      const gateway = shutdownOwned.find(({ id }) => id === "gateway");
      if (gateway && !(await waitForExit(gateway.child, 10_000))) throw Object.assign(new Error("Gateway did not drain."), { code: "GATEWAY_EXIT_TIMEOUT" });
    },
    forceTerminate: async () => {
      const remainingPids = [];
      for (const { id, child } of shutdownOwned) {
        if (managed.get(id) !== child || child.exitCode !== null || child.signalCode !== null) continue;
        if (process.platform === "win32") await runtime.terminateOwnedProcess(child.pid);
        else child.kill("SIGKILL");
        if (!(await waitForExit(child, 5_000))) remainingPids.push(child.pid);
      }
      return { remainingPids };
    },
    verifyStopped: async () => {
      const remainingPids = shutdownOwned
        .filter(({ child }) => child.exitCode === null && child.signalCode === null && processExists(child.pid))
        .map(({ child }) => child.pid);
      for (const { id } of shutdownOwned) {
        const port = id === "backend" ? DEFAULT_PORTS.backend : id === "gateway" ? DEFAULT_PORTS.gateway : integration.childPorts[id];
        if (port) remainingPids.push(...await runtime.portPids(port, { strict: true }));
      }
      const uniquePids = [...new Set(remainingPids)];
      return { stopped: uniquePids.length === 0, remainingPids: uniquePids };
    },
    onStateChange: (state) => {
      if (state?.completedAt) {
        stopping = false;
        recordLog("supervisor", "shutdown", `STOP phase=${state.phase} reason=${state.forceReason || state.reason}`);
      }
    },
  });

  function beginStop(reason = "manual-stop", ids = ["gateway", ...integration.childIds.slice().reverse(), "backend"]) {
    if (shutdown.isActive()) {
      if (ids.join("\0") === shutdownScopeIds.join("\0")) return shutdown.getState();
      throw Object.assign(new Error("A different shutdown is in progress."), { code: "SHUTDOWN_IN_PROGRESS", statusCode: 409 });
    }
    shutdownScopeIds = [...ids];
    shutdownOwned = ids.map((id) => ({ id, child: managed.get(id) })).filter(({ child }) => child && child.exitCode === null && child.signalCode === null);
    stopping = true;
    return shutdown.begin(reason);
  }

  async function awaitStop(reason = "manual-stop", ids) {
    const state = beginStop(reason, ids);
    const outcome = await shutdown.waitForOutcome(state.operationId);
    if (!outcome.completedAt) {
      const remainingPids = shutdownOwned
        .filter(({ child }) => child.exitCode === null && child.signalCode === null && processExists(child.pid))
        .map(({ child }) => child.pid);
      throw Object.assign(new Error("The safe shutdown is blocked; an explicit force action is required."), {
        code: "SAFE_STOP_BLOCKED",
        statusCode: 409,
        shutdownOperationId: state.operationId,
        remainingPids,
      });
    }
    return outcome;
  }

  function recordLog(serverId, stream, message) {
    const line = String(message).replace(/\x1b\[[0-9;]*m/gu, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/gu, "").slice(0, 2048);
    if (!line.trim()) return "";
    // Console output can contain credentials supplied by dependencies. Hide the entire line.
    const safeLine = /password|secret|token|authorization|credential|private.?key|master.?key|postgres(?:ql)?:\/\/|DATABASE_URL|BEGIN [A-Z ]*PRIVATE KEY/iu.test(line)
      ? "[REDACTED]"
      : line;
    logLines.push({ sequence: ++logSequence, at: new Date().toISOString(), server: serverId, stream, line: safeLine });
    if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
    return safeLine;
  }

  function captureChildOutput(child, serverId, name, target) {
    captureSafeChildOutput({ source: child[name], serverId, stream: name, target, record: recordLog });
  }

  function config() {
    const value = readServerRuntimeConfigSync({ configPath: runtimeConfigPath, kind: args.runtimeConfigPath ? "operational" : "source", sourceRoot: root }).config;
    if (assertPackageFlavor(value.packageFlavor) !== flavor) {
      const error = new Error("The runtime configuration does not match the installed package flavor.");
      error.code = "PACKAGE_FLAVOR_MISMATCH";
      throw error;
    }
    return value;
  }

  async function callBackend(pathname, method = "GET", body = undefined, timeoutMs = 60_000) {
    const response = await fetch(`http://127.0.0.1:${DEFAULT_PORTS.backend}${pathname}`, {
      method,
      cache: "no-store",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "X-QuickHack-Supervisor-Token": actionToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.message || "The backend rejected the console request.");
      error.code = payload.code || "BACKEND_OPERATION_FAILED";
      error.statusCode = response.status;
      throw error;
    }
    return payload;
  }

  async function publicObservation(operation, unavailableCode) {
    try {
      return await operation();
    } catch (error) {
      return { available: false, code: error?.code || unavailableCode };
    }
  }

  async function updateRuntimeSettings(patch) {
    const current = config();
    const next = validateServerRuntimeConfig({ ...current, ...patch, packageFlavor: flavor });
    const wasRunning = managed.size > 0;
    await runtime.secureDirectory(path.dirname(runtimeConfigPath));
    return updateServerRuntimeSettings({
      configPath: runtimeConfigPath, next, wasRunning,
      stop: () => awaitStop("runtime-restart"), start,
      canRestore: () => managed.size === 0 && !shutdown.isActive(),
    });
  }

  async function completeRestoreBarrier(barrier) {
    if (!barrier) return { completed: false };
    if (barrier.cutoverPhase !== "CUTOVER_COMPLETE") {
      const error = new Error("The interrupted PostgreSQL restore requires an operator recovery operation.");
      error.code = "RESTORE_RECOVERY_REQUIRED";
      throw error;
    }
    const result = await callBackend(
      "/api/internal/supervisor/restore-barrier",
      "POST",
      { expectedInstanceEpoch: barrier.expectedInstanceEpoch }
    );
    const current = fs.lstatSync(barrier.filePath);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== barrier.device || current.ino !== barrier.inode) {
      const error = new Error("The PostgreSQL restore barrier changed during verification.");
      error.code = "RESTORE_BARRIER_CHANGED";
      throw error;
    }
    fs.rmSync(barrier.filePath);
    return { completed: result.completed === true, stale: result.stale === true };
  }

  function childEnvironment(overrides = {}, includeCredentials = false, explicitCredentialDirectory = "") {
    const credentialDirectory = explicitCredentialDirectory || (includeCredentials ? String(process.env.CREDENTIALS_DIRECTORY ?? "").trim() : "");
    return runtime.childEnvironment({
      executableDirectories: [path.dirname(nodeExecutable)],
      overrides: {
        QUICKHACK_ARTIFACT_KIND: args.packageManifestPath ? `${flavor}_SERVER` : undefined,
        QUICKHACK_PACKAGE_MANIFEST: args.packageManifestPath || undefined,
        ...overrides,
        CREDENTIALS_DIRECTORY: credentialDirectory || undefined,
      },
    });
  }

  function createCredentialHandoff(childId, credentialNames, runtimeConfig) {
    const sourceDirectory = String(process.env.CREDENTIALS_DIRECTORY ?? "").trim();
    if (!sourceDirectory) return "";
    if (!/^[a-z0-9-]{1,64}$/u.test(childId)) throw new TypeError("A finite child identity is required.");
    const names = [...new Set(credentialNames.map((value) => String(value ?? "").trim()))];
    if (names.length === 0 || names.some((name) => !/^quickhack\.[a-z0-9.-]+$/u.test(name))) {
      throw new TypeError("A finite credential identity list is required.");
    }
    const targetDirectory = path.join(
      path.resolve(runtimeConfig.dataDirectory),
      "state",
      "child-credentials",
      `${childId}-${crypto.randomUUID()}`
    );
    fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    try {
      for (const name of names) {
        const source = path.join(sourceDirectory, name);
        const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
          throw new Error("A child credential source is invalid.");
        }
        const target = path.join(targetDirectory, name);
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, 0o400);
      }
      credentialHandoffs.set(childId, targetDirectory);
      return targetDirectory;
    } catch (error) {
      fs.rmSync(targetDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  function spawnOwned(id, plan, environment) {
    const instanceId = crypto.randomBytes(16).toString("hex");
    const child = spawn(plan.nodeExecutable, plan.args, { cwd: plan.cwd, env: { ...environment, QUICKHACK_CONSOLE_INSTANCE_ID: instanceId }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    managed.set(id, child);
    ownedInstances.set(id, instanceId);
    recordLog(id, "supervisor", `START pid=${child.pid ?? "pending"}`);
    captureChildOutput(child, id, "stdout", process.stdout);
    captureChildOutput(child, id, "stderr", process.stderr);
    child.once("error", (error) => {
      lastError = { code: error?.code || "CHILD_SPAWN_FAILED", child: id };
      recordLog(id, "supervisor", `ERROR code=${lastError.code}`);
      if (managed.get(id) === child) { managed.delete(id); ownedInstances.delete(id); }
      const handoff = credentialHandoffs.get(id);
      if (handoff) {
        fs.rmSync(handoff, { recursive: true, force: true });
        credentialHandoffs.delete(id);
      }
    });
    child.once("exit", (code, signal) => {
      if (!stopping && code !== 0) lastError = { code: "CHILD_EXITED", child: id, exitCode: code, signal };
      recordLog(id, "supervisor", `EXIT code=${code ?? "none"} signal=${signal ?? "none"}`);
      if (managed.get(id) === child) { managed.delete(id); ownedInstances.delete(id); }
      const handoff = credentialHandoffs.get(id);
      if (handoff) {
        fs.rmSync(handoff, { recursive: true, force: true });
        credentialHandoffs.delete(id);
      }
    });
    return child;
  }

  async function requireDatabase() {
    const database = await serverPlatform.postgresqlService.status();
    if (database.state !== "ACTIVE") {
      const error = new Error("PostgreSQL service is not active; the application was not partially started.");
      error.code = "DEPENDENCY_UNAVAILABLE";
      throw error;
    }
  }

  async function probeOwned(id) {
    if (id === "backend") {
      try { return (await callBackend("/api/internal/supervisor/readiness", "GET", undefined, 1_200)).databaseReady === true; }
      catch { return false; }
    }
    if (id === "gateway") {
      const tls = getQuickHackTlsStatus(config().dataDirectory);
      return tls.ready && Boolean(ownedInstances.get(id)) && (await secureHealth(`https://127.0.0.1:${DEFAULT_PORTS.gateway}/__quickhack_tls_health`, tls.paths.rootCaPem, 1_200, ownedInstances.get(id))).ok;
    }
    const instanceId = ownedInstances.get(id);
    return Boolean(instanceId) && integration.probeChild(id, instanceId);
  }

  function ownedProcessIsAlive(id) {
    const child = managed.get(id);
    return child && Number.isInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null;
  }

  async function startBackend() {
    await requireDatabase();
    const runtimeConfig = config();
    const restoreBarrier = readRestoreBarrier(runtimeConfig.dataDirectory);
    if (restoreBarrier && restoreBarrier.cutoverPhase !== "CUTOVER_COMPLETE") {
      const error = new Error("The interrupted PostgreSQL restore requires an operator recovery operation.");
      error.code = "RESTORE_RECOVERY_REQUIRED";
      throw error;
    }
    const backend = serverPlan(root, nodeExecutable);
    const gateway = gatewayPlan(root, nodeExecutable, runtimeConfig.dataDirectory);
    if (!backend || !gateway) {
      const error = new Error("The server runtime or HTTPS certificate is unavailable.");
      error.code = "DEPENDENCY_MISSING";
      throw error;
    }
    await assertPortAvailable("backend", DEFAULT_PORTS.backend);
    stopping = false;
    lastError = null;
    const backendChild = spawnOwned("backend", backend, childEnvironment({
      PORT: DEFAULT_PORTS.backend,
      HOSTNAME: "127.0.0.1",
      NODE_ENV: backend.mode === "next-dev" ? "development" : "production",
      QUICKHACK_SUPERVISOR_TOKEN: actionToken,
      QUICKHACK_HTTPS_TERMINATED: "1",
      QUICKHACK_PUBLIC_SERVER_ORIGIN: gateway.tls.trustBundle.origin,
    }, true));
    await waitForOwnedReady({ id: "backend", child: backendChild, current: () => managed.get("backend"), probe: () => probeOwned("backend") });
    readyOwned.add(backendChild);
    await completeRestoreBarrier(restoreBarrier);
    return { changed: true, id: "backend", pid: backendChild.pid };
  }

  async function startGateway() {
    if (!ownedProcessIsAlive("backend") || !(await probeOwned("backend"))) {
      throw Object.assign(new Error("Start the backend before the HTTPS gateway."), { code: "DEPENDENCY_UNAVAILABLE" });
    }
    const gateway = gatewayPlan(root, nodeExecutable, config().dataDirectory);
    if (!gateway) throw Object.assign(new Error("HTTPS certificate is unavailable."), { code: "DEPENDENCY_MISSING" });
    await assertPortAvailable("gateway", DEFAULT_PORTS.gateway, "0.0.0.0");
    const gatewayChild = spawnOwned("gateway", gateway, childEnvironment({
      QUICKHACK_HTTPS_HOST: "0.0.0.0",
      QUICKHACK_HTTPS_PORT: DEFAULT_PORTS.gateway,
      QUICKHACK_UPSTREAM_HOST: "127.0.0.1",
      QUICKHACK_UPSTREAM_PORT: DEFAULT_PORTS.backend,
      QUICKHACK_TLS_PFX_FILE: gateway.tls.paths.serverPfx,
      QUICKHACK_TLS_PFX_PASSPHRASE_FILE: gateway.tls.paths.serverPassphrase,
      QUICKHACK_SUPERVISOR_TOKEN: actionToken,
    }));
    await waitForOwnedReady({ id: "gateway", child: gatewayChild, current: () => managed.get("gateway"), probe: () => probeOwned("gateway") });
    readyOwned.add(gatewayChild);
    return { changed: true, id: "gateway", pid: gatewayChild.pid };
  }

  async function startOne(id) {
    if (shutdown.isActive()) throw Object.assign(new Error("Shutdown is in progress."), { code: "SHUTDOWN_IN_PROGRESS", statusCode: 409 });
    if (id !== "backend" && id !== "gateway" && !integration.childIds.includes(id)) {
      throw Object.assign(new Error("Unknown server."), { code: "SERVER_UNKNOWN", statusCode: 404 });
    }
    if (managed.has(id)) {
      if (ownedProcessIsAlive(id) && await probeOwned(id)) return { changed: false, id };
      if (id === "backend") await awaitStop("runtime-restart", ["gateway", "backend"]);
      else await stopOwned(id);
    }
    try {
      if (id === "backend") return await startBackend();
      if (id === "gateway") return await startGateway();
      await requireDatabase();
      await assertPortAvailable(id, integration.childPorts[id]);
      const result = await integration.startChild(id, { root, nodeExecutable, runtimeConfig: config(), spawnOwned, childEnvironment, createCredentialHandoff });
      const readyChild = await waitForOwnedReady({ id, child: managed.get(id), current: () => managed.get(id), probe: () => probeOwned(id), timeoutMs: 30_000 });
      readyOwned.add(readyChild);
      return { changed: true, ...result };
    } catch (error) {
      // A failed readiness check can leave a newly spawned process alive.
      if (managed.has(id)) {
        try {
          const child = managed.get(id);
          if (id === "backend" && readyOwned.has(child)) await awaitStop("runtime-restart", ["gateway", "backend"]);
          else await stopOwned(id, 10_000);
        }
        catch (cleanupError) {
          recordLog(id, "supervisor", `CLEANUP_FAILED code=${cleanupError?.code || "UNKNOWN"}`);
          throw Object.assign(new Error("Startup failed and its owned process could not be stopped safely."), {
            code: "START_CLEANUP_BLOCKED", statusCode: 409, originalCode: error?.code || "UNKNOWN",
            cleanupCode: cleanupError?.code || "UNKNOWN", shutdownOperationId: cleanupError?.shutdownOperationId,
            remainingPids: cleanupError?.remainingPids ?? (ownedProcessIsAlive(id) ? [managed.get(id).pid] : []),
          });
        }
      }
      recordLog(id, "supervisor", `START_FAILED code=${error?.code || "UNKNOWN"}`);
      throw error;
    }
  }

  async function stopOwned(id, timeoutMs = 180_000) {
    const child = managed.get(id);
    if (!child) return false;
    if (Number.isInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null) {
      const signaled = child.kill("SIGTERM");
      if ((!signaled && processExists(child.pid)) || (signaled && !(await waitForExit(child, timeoutMs)))) {
        throw Object.assign(new Error(`${id} did not stop safely.`), { code: "SAFE_STOP_TIMEOUT", child: id, remainingPids: [child.pid] });
      }
    }
    managed.delete(id);
    ownedInstances.delete(id);
    const handoff = credentialHandoffs.get(id);
    if (handoff) {
      fs.rmSync(handoff, { recursive: true, force: true });
      credentialHandoffs.delete(id);
    }
    return true;
  }

  async function start() {
    if (shutdown.isActive()) throw Object.assign(new Error("Shutdown is in progress."), { code: "SHUTDOWN_IN_PROGRESS", statusCode: 409 });
    const started = [];
    try {
      for (const id of ["backend", "gateway"]) {
        const result = await startOne(id);
        if (result.changed) started.push(id);
      }
      const readiness = await readinessStatus();
      if (readiness.applicationState !== "ACTIVE") {
        throw Object.assign(new Error("The application did not reach ACTIVE readiness."), {
          code: "APPLICATION_NOT_READY",
          applicationState: readiness.applicationState,
        });
      }
    } catch (error) {
      stopping = true;
      const cleanupFailures = [];
      try {
        for (const id of started.reverse()) {
          try {
            if (id === "backend") await awaitStop("runtime-restart", ["gateway", "backend"]);
            else await stopOwned(id);
          }
          catch (cleanupError) {
            recordLog(id, "supervisor", `ROLLBACK_FAILED code=${cleanupError?.code || "UNKNOWN"}`);
            cleanupFailures.push(cleanupError);
          }
        }
      }
      finally { stopping = false; }
      if (cleanupFailures.length > 0) {
        throw Object.assign(new Error("Startup rollback could not stop every owned process safely."), {
          code: "START_ROLLBACK_BLOCKED", statusCode: 409, originalCode: error?.code || "UNKNOWN",
          cleanupCodes: cleanupFailures.map((failure) => failure?.code || "UNKNOWN"),
          shutdownOperationId: cleanupFailures.find((failure) => failure?.shutdownOperationId)?.shutdownOperationId,
          remainingPids: [...new Set(cleanupFailures.flatMap((failure) => failure?.remainingPids ?? []))],
        });
      }
      throw error;
    }
    // Demonstration simulators are optional and cannot roll back a ready main server.
    const simulatorFailures = [];
    for (const id of integration.childIds) {
      try {
        const result = await startOne(id);
        if (result.changed) started.push(id);
      } catch (error) {
        simulatorFailures.push({ id, code: error?.code || "UNKNOWN" });
      }
    }
    const failureSummary = simulatorFailures.map(({ id, code }) => `${id} (${code})`).join(", ");
    return {
      changed: started.length > 0,
      message: failureSummary ? `QuickHack application is ready. Simulator startup failed: ${failureSummary}` : "QuickHack application is ready.",
      started,
      simulatorFailures,
      applicationState: "ACTIVE",
    };
  }

  async function stop() {
    const ids = ["gateway", ...integration.childIds.slice().reverse(), "backend"];
    const changed = ids.some((id) => managed.has(id));
    const state = await awaitStop("manual-stop", ids);
    return { changed, message: "QuickHack application stopped.", stopped: ids.filter((id) => !managed.has(id)), shutdown: state };
  }

  async function readinessStatus() {
    const runtimeConfig = config();
    const tls = getQuickHackTlsStatus(runtimeConfig.dataDirectory);
    const tlsHostSelection = tlsHostSelectionStatus(tls, runtimeConfig.publicHost, undefined, undefined, !args.runtimeConfigPath);
    const tlsReady = tls.ready && tlsHostSelection.matches;
    const [database, backend, gateway, backendReadiness, integrationStatus] = await Promise.all([
      publicObservation(() => serverPlatform.postgresqlService.status({ timeoutMs: 2_000 }), "DATABASE_SERVICE_STATUS_UNAVAILABLE"),
      health(`http://127.0.0.1:${DEFAULT_PORTS.backend}/api/runtime`),
      tlsReady
        ? secureHealth(`https://127.0.0.1:${DEFAULT_PORTS.gateway}/__quickhack_tls_health`, tls.paths.rootCaPem)
        : Promise.resolve({ ok: false, status: null, error: "TLS_UNAVAILABLE" }),
      publicObservation(() => callBackend("/api/internal/supervisor/readiness", "GET", undefined, 2_000), "BACKEND_READINESS_UNAVAILABLE"),
      publicObservation(() => integration.status({ managed, ownedInstances, config: runtimeConfig }), "INTEGRATION_STATUS_UNAVAILABLE"),
    ]);
    const applicationState = mainServerState({
      database, backend, gateway, tlsReady, backendReadiness,
      coreProcessRunning: managed.has("backend") || managed.has("gateway"),
    });
    return {
      flavor,
      runtimeSettings: {
        environment: runtimeConfig.environment,
        coupangWriteApiEnabled: runtimeConfig.coupangWriteApiEnabled,
        logenWriteApiEnabled: runtimeConfig.logenWriteApiEnabled,
      },
      applicationState,
      runtimeVersion,
      runtimeBuildId,
      database,
      backend,
      backendReadiness,
      gateway,
      integration: integrationStatus,
      processes: Object.fromEntries(["backend", "gateway", ...integration.childIds].map((id) => [id, { running: managed.has(id), pid: managed.get(id)?.pid ?? null }])),
      shutdown: (() => {
        const state = shutdown.getState();
        return state ? { ...state, errorMessage: state.errorMessage ? "SHUTDOWN_BLOCKED" : null } : null;
      })(),
      tls: {
        ready: tlsReady,
        errors: tlsHostSelection.code ? [...tls.errors, tlsHostSelection.code] : tls.errors,
        origin: tls.trustBundle?.origin ?? "",
        currentCaSha256: tls.trustBundle?.manifest.currentCaSha256 ?? "",
        previousCaSha256: tls.trustBundle?.manifest.previousCaSha256 ?? "",
        rotationNotBefore: tls.trustBundle?.manifest.rotationNotBefore ?? "",
      },
      lastError,
    };
  }

  async function status() {
    const readiness = await readinessStatus();
    const runtimeConfig = config();
    const tlsStatus = getQuickHackTlsStatus(runtimeConfig.dataDirectory);
    const [qhkey, totpSecurity, backups] = await Promise.all([
      publicObservation(
        () => getQhkeyConsoleStatus(runtimeConfig.dataDirectory, runtimeConfig.environment === "production"),
        "QHKEY_STATUS_UNAVAILABLE"
      ),
      publicObservation(
        () => callBackend("/api/internal/supervisor/totp-security", "GET", undefined, 2_000),
        "TOTP_SECURITY_STATUS_UNAVAILABLE"
      ),
      publicObservation(
        () => callBackend("/api/internal/supervisor/backups", "GET", undefined, 2_000),
        "BACKUP_STATUS_UNAVAILABLE"
      ),
    ]);
    return {
      ...readiness,
      qhkey: redactedPublicValue(qhkey),
      totpSecurity,
      backups,
      consoleDetails: {
        observedAt: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        root,
        nodeExecutable,
        runtimeConfigPath,
        dataDirectory: runtimeConfig.dataDirectory,
        database: `${runtimeConfig.database.host}:${runtimeConfig.database.port}/${runtimeConfig.database.name}`,
        tlsClientConfigDirectory: tlsStatus.paths.clientConfigDir,
      },
    };
  }

  async function runBackupNow(workerKey = "database-auto-backup") {
    if (!["database-auto-backup", "backup-retention-and-integrity"].includes(workerKey)) {
      throw Object.assign(new Error("Unknown backup worker."), { code: "BACKUP_WORKER_UNSUPPORTED", statusCode: 400 });
    }
    return callBackend(
      "/api/internal/supervisor/backups",
      "POST",
      { action: "runNow", workerKey }
    );
  }

  async function replaceTls(mode) {
    const wasRunning = managed.size > 0;
    if (wasRunning) await awaitStop("runtime-restart");
    const runtimeConfig = config();
    const hosts = tlsHostSelection(runtimeConfig, !args.runtimeConfigPath);
    try {
      await initializeQuickHackTls({
        dataDir: runtimeConfig.dataDirectory,
        httpsPort: DEFAULT_PORTS.gateway,
        hostNames: hosts.hostNames,
        primaryHost: hosts.primaryHost,
        mode,
        scriptPath: path.join(root, "tools", "initialize-https.ps1"),
        runtime,
      });
    } catch (error) {
      let failure = error;
      if (wasRunning) {
        try {
          await start();
        } catch (restartError) {
          if (error && typeof error === "object") {
            error.restartCode = restartError?.code || "TLS_ROLLBACK_RESTART_FAILED";
          } else {
            failure = Object.assign(new Error(String(error)), {
              code: "TLS_INITIALIZATION_FAILED",
              restartCode: restartError?.code || "TLS_ROLLBACK_RESTART_FAILED",
            });
          }
        }
      }
      throw failure;
    }
    if (wasRunning) await start();
    const messageCodes = {
      INITIALIZE: "TLS_CERTIFICATE_RENEWED",
      ROTATE: "TLS_CA_ROTATION_STARTED",
      FINALIZE_ROTATION: "TLS_CA_ROTATION_FINALIZED",
    };
    return { ok: true, restarted: wasRunning, messageCode: messageCodes[mode] };
  }

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && ["/", "/api-key-management", "/database-management"].includes(requestUrl.pathname)) {
        const locale = resolveServerConsoleLocale(request.headers["accept-language"]);
        return html(response, renderServerConsolePage({ flavor, actionToken, locale, view: requestUrl.pathname, integrationHtml: integration.renderHtml(serverConsoleMessages(locale)) }));
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/readiness") return json(response, 200, await readinessStatus());
      if (request.method === "GET" && requestUrl.pathname === "/api/internal/package-readiness") {
        const nonce = request.headers["x-quickhack-package-nonce"];
        if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/u.test(nonce)) return json(response, 404, { ok: false, code: "NOT_FOUND" });
        return json(response, 200, await readinessStatus(), { "x-quickhack-package-proof": packageReadinessDigest(packageReadinessSecret, nonce) });
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/status") return json(response, 200, await status());
      if (request.method === "GET" && requestUrl.pathname === "/api/logs") {
        if (request.headers["x-quickhack-console-token"] !== actionToken) return json(response, 404, { ok: false, code: "NOT_FOUND" });
        const after = Number(requestUrl.searchParams.get("after") || 0);
        return json(response, 200, { entries: logLines.filter((entry) => entry.sequence > (Number.isFinite(after) ? after : 0)) });
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/qhkey/status") {
        const runtimeConfig = config();
        return json(response, 200, redactedPublicValue(await getQhkeyConsoleStatus(runtimeConfig.dataDirectory, runtimeConfig.environment === "production")));
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/qhkey/replacement-status") {
        if (request.headers["x-quickhack-console-token"] !== actionToken) return json(response, 404, { ok: false, code: "NOT_FOUND" });
        return json(response, 200, await getQhkeyReplacementStatus(config().dataDirectory, requestUrl.searchParams.get("transactionId")));
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/database-management/status") {
        return json(response, 200, await callBackend("/api/internal/supervisor/backups"));
      }
      if (request.method === "POST") {
        if (request.headers["x-quickhack-console-token"] !== actionToken) return json(response, 404, { ok: false, code: "NOT_FOUND" });
        const payload = await readRequestBody(request);
        if (["/api/application/start", "/api/quickhack/start"].includes(requestUrl.pathname)) return json(response, 202, { ok: true, ...(await serializeLifecycle(start)) });
        if (["/api/application/stop", "/api/quickhack/stop"].includes(requestUrl.pathname)) return json(response, 202, { ok: true, shutdown: await serializeLifecycle(() => beginStop()) });
        if (requestUrl.pathname === "/api/shutdown/force") return json(response, 200, { ok: true, shutdown: await shutdown.force("console-action") });
        const serverAction = /^\/api\/servers\/([a-z-]+)\/(start|stop)$/u.exec(requestUrl.pathname);
        if (serverAction) {
          const id = serverAction[1];
          if (id !== "backend" && id !== "gateway" && !integration.childIds.includes(id)) return json(response, 404, { ok: false, code: "SERVER_UNKNOWN" });
          if (serverAction[2] === "stop") return json(response, 202, { ok: true, shutdown: await serializeLifecycle(() => beginStop("manual-stop", id === "backend" ? ["gateway", "backend"] : [id])) });
          return json(response, 202, { ok: true, ...(await serializeLifecycle(() => startOne(id))) });
        }
        if (["/api/operator/backup", "/api/database-management/run"].includes(requestUrl.pathname)) return json(response, 202, { ok: true, ...(await runBackupNow(String(payload.workerKey ?? "database-auto-backup"))) });
        if (requestUrl.pathname === "/api/database-management/schedule") {
          const workerKey = String(payload.workerKey ?? "");
          if (!["database-auto-backup", "backup-retention-and-integrity"].includes(workerKey) || typeof payload.scheduleEnabled !== "boolean") {
            return json(response, 400, { ok: false, code: "BACKUP_SCHEDULE_INVALID" });
          }
          return json(response, 200, await callBackend("/api/internal/supervisor/backups", "POST", { action: "setSchedule", workerKey, scheduleEnabled: payload.scheduleEnabled }));
        }
        if (requestUrl.pathname === "/api/runtime/toggle-environment") {
          return json(response, 202, { ok: true, ...(await serializeLifecycle(() => {
            const current = config();
            return updateRuntimeSettings({ environment: current.environment === "production" ? "development" : "production" });
          })) });
        }
        if (requestUrl.pathname === "/api/runtime/toggle-coupang-write-api") {
          return json(response, 202, { ok: true, ...(await serializeLifecycle(() => {
            const current = config();
            return updateRuntimeSettings({ coupangWriteApiEnabled: !current.coupangWriteApiEnabled });
          })) });
        }
        if (requestUrl.pathname === "/api/runtime/toggle-logen-write-api") {
          return json(response, 202, { ok: true, ...(await serializeLifecycle(() => {
            const current = config();
            return updateRuntimeSettings({ logenWriteApiEnabled: !current.logenWriteApiEnabled });
          })) });
        }
        if (requestUrl.pathname === "/api/totp-security/recover") {
          return json(response, 200, await callBackend("/api/internal/supervisor/totp-security", "POST", { confirmText: String(payload.confirmText ?? "") }));
        }
        if (requestUrl.pathname === "/api/qhkey/replacement-cancel") {
          return json(response, 200, await cancelQhkeyReplacement(config().dataDirectory, payload.transactionId));
        }
        if (requestUrl.pathname === "/api/tls/initialize") return json(response, 200, await serializeLifecycle(() => replaceTls("INITIALIZE")));
        if (requestUrl.pathname === "/api/tls/rotate") return json(response, 200, await serializeLifecycle(() => replaceTls("ROTATE")));
        if (requestUrl.pathname === "/api/tls/finalize-rotation") return json(response, 200, await serializeLifecycle(() => replaceTls("FINALIZE_ROTATION")));
        const integrationResult = await integration.handleAction(requestUrl.pathname, { root, config: config(), managed, payload });
        if (integrationResult) return json(response, integrationResult.status ?? 200, redactedPublicValue(integrationResult.payload));
      }
      return json(response, 404, { ok: false, code: "NOT_FOUND" });
    } catch (error) {
      lastError = { code: error?.code || "CONSOLE_OPERATION_FAILED" };
      return json(response, Number(error?.statusCode) || 500, {
        ok: false, ...lastError,
        ...(error?.originalCode ? { originalCode: error.originalCode } : {}),
        ...(error?.cleanupCode ? { cleanupCode: error.cleanupCode } : {}),
        ...(error?.rollbackCode ? { rollbackCode: error.rollbackCode } : {}),
        ...(error?.shutdownOperationId ? { shutdownOperationId: error.shutdownOperationId } : {}),
        ...(error?.remainingPids ? { remainingPids: error.remainingPids } : {}),
      });
    }
  });

  async function listen() {
    // Installed configuration is root-owned and readable by the service group.
    // Inspect it without trying to change its ownership or permissions.
    assertConsoleConfigDirectory(runtimeConfigPath);
    const runtimeConfig = config();
    const operatorStateDirectory = path.join(path.resolve(runtimeConfig.dataDirectory), "state", "operator");
    await runtime.secureDirectory(operatorStateDirectory);
    actionTokenPath = path.join(operatorStateDirectory, "server-console-action.json");
    writeActionTokenFile(actionTokenPath, actionToken, packageReadinessSecret);
    try {
      let recoveryMarkerExists = false;
      try { fs.lstatSync(runtimeSettingsMarkerPath(runtimeConfigPath)); recoveryMarkerExists = true; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (recoveryMarkerExists) {
        for (const [id, port] of Object.entries({ backend: DEFAULT_PORTS.backend, gateway: DEFAULT_PORTS.gateway, ...integration.childPorts })) {
          await assertPortAvailable(id, port);
        }
        recoverServerRuntimeSettings(runtimeConfigPath);
      }
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(DEFAULT_PORTS.console, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      fs.rmSync(actionTokenPath, { force: true });
      actionTokenPath = "";
      throw error;
    }
    if (!args.noOpen && !args.systemService) runtime.openUrl(`http://127.0.0.1:${DEFAULT_PORTS.console}`);
    if (args.systemService) await serializeLifecycle(start).catch((error) => { lastError = { code: error?.code || "APPLICATION_START_FAILED" }; });
    return { host: "127.0.0.1", port: DEFAULT_PORTS.console, flavor };
  }

  async function close(signal = "SIGTERM") {
    await serializeLifecycle(() => awaitStop("console-signal"));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (actionTokenPath) fs.rmSync(actionTokenPath, { force: true });
    return { signal };
  }

  return Object.freeze({ flavor, listen, close, start, stop, status, server, forceStop: (reason = "second-signal") => shutdown.force(reason, { bypassWarning: true }) });
}

export async function runServerConsole(input) {
  const consoleRuntime = createServerConsole(input);
  await consoleRuntime.listen();
  let signalCount = 0;
  const shutdown = (signal) => {
    signalCount += 1;
    if (signalCount > 1) {
      void consoleRuntime.forceStop()
        .then(() => consoleRuntime.close(signal))
        .then(() => process.exit(0))
        .catch((error) => {
          console.error(`QuickHack forced shutdown failed: ${error?.code || "SHUTDOWN_FORCE_FAILED"}`);
          signalCount = 1;
        });
      return;
    }
    void consoleRuntime.close(signal)
      .then(() => process.exit(0))
      .catch((error) => console.error(`QuickHack safe shutdown blocked: ${error?.code || "SHUTDOWN_FAILED"}`));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return consoleRuntime;
}
