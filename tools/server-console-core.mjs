import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeServerPlatform } from "../quickhack_server/platform/compose-server-platform.ts";
import {
  readServerRuntimeConfigSync,
  sourceServerRuntimeConfigPath,
  validateServerRuntimeConfig,
  writeServerRuntimeConfigAtomicSync,
} from "../quickhack_shared/core/server-runtime-config.mjs";
import { assertPackageFlavor } from "../quickhack_shared/core/package-flavor-contract.mjs";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";
import { getQuickHackTlsStatus, initializeQuickHackTls } from "./server-console-tls.mjs";
import { formatServerConsoleMessage, resolveServerConsoleLocale, serverConsoleActionMessages, serverConsoleMessages } from "./server-console-i18n.mjs";
import {
  cancelQhkeyReplacement,
  getQhkeyConsoleStatus,
  getQhkeyReplacementStatus,
} from "./server-console-qhkey-common.mjs";

const DEFAULT_PORTS = Object.freeze({ console: 2999, backend: 3000, gateway: 3443 });
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

function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
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

function secureHealth(url, caFile, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const request = httpsRequest(url, { method: "GET", ca: fs.readFileSync(caFile), timeout: timeoutMs }, (response) => {
      response.resume();
      response.once("end", () => resolve({ ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300), status: response.statusCode ?? null, error: "" }));
    });
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", () => resolve({ ok: false, status: null, error: "UNREACHABLE" }));
    request.end();
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function waitForHealthy(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = async () => {
      const result = await health(url);
      if (result.ok) return resolve(result);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(poll, 250);
    };
    void poll();
  });
}

function waitForSecureHealthy(url, caFile, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = async () => {
      const result = await secureHealth(url, caFile);
      if (result.ok) return resolve(result);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(poll, 250);
    };
    void poll();
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

function writeActionTokenFile(filePath, token) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(filePath, "wx", 0o600);
      try {
        fs.writeFileSync(handle, `${JSON.stringify({ schemaVersion: 1, token, pid: process.pid })}\n`, "utf8");
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

function tlsHostSelection() {
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => String(entry.address).trim().toLowerCase())
    .filter((entry) => entry && !entry.startsWith("169.254."))
    .sort();
  const hostname = String(os.hostname() ?? "").trim().toLowerCase();
  const safeHostname = /^[a-z0-9.-]{1,253}$/u.test(hostname) && !hostname.includes("..")
    ? hostname
    : "";
  const primaryHost = addresses[0] || safeHostname || "localhost";
  return Object.freeze({
    primaryHost,
    hostNames: Object.freeze([
      ...new Set([primaryHost, ...addresses, safeHostname, "127.0.0.1", "localhost"].filter(Boolean)),
    ]),
  });
}

function consolePage({ flavor, actionToken, integrationHtml, locale }) {
  const t = serverConsoleMessages(locale);
  const actionMessages = serverConsoleActionMessages(locale);
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#0b1220;color:#e5e7eb}main{max-width:1000px;margin:auto;padding:24px}.card{background:#111827;border:1px solid #334155;border-radius:14px;padding:18px;margin:14px 0}.row{display:flex;gap:10px;flex-wrap:wrap}button,a,input{border:0;border-radius:9px;padding:10px 14px}button,a{background:#2563eb;color:white;text-decoration:none;cursor:pointer}.danger{background:#b91c1c}.muted{color:#94a3b8}pre{white-space:pre-wrap}code{color:#93c5fd}form{display:grid;gap:10px;max-width:520px}input{background:#1f2937;color:#fff}</style></head><body><main>
<h1>${t.title}</h1><p class="muted">${formatServerConsoleMessage(t.ownership, { flavor: `<code>${flavor}</code>` })}</p>
<section class="card"><h2>${t.server}</h2><div class="row"><button id="quickhack-start" data-action="/api/quickhack/start">${t.start}</button><button id="quickhack-stop" class="danger" data-action="/api/quickhack/stop">${t.stop}</button><a href="https://127.0.0.1:${DEFAULT_PORTS.gateway}" target="_blank" rel="noreferrer">${t.open}</a></div><pre id="status">${t.checking}</pre></section>
<section class="card"><h2>${t.tls}</h2><div class="row"><button data-action="/api/tls/initialize">${t.renew}</button><button data-action="/api/tls/rotate">${t.rotate}</button><button data-action="/api/tls/finalize-rotation">${t.finalize}</button></div><p class="muted">${t.rotationHelp}</p></section>
<section class="card"><h2>${t.runtime}</h2><div class="row"><button id="runtime-environment-toggle" data-action="/api/runtime/toggle-environment">${t.environment}</button><button id="coupang-write-api-toggle" data-action="/api/runtime/toggle-coupang-write-api">${t.coupangWrite}</button><button id="logen-write-api-toggle" data-action="/api/runtime/toggle-logen-write-api">${t.logenWrite}</button></div><p class="muted">${t.runtimeHelp}</p></section>
<section class="card"><h2>${t.backup}</h2><button data-action="/api/operator/backup">${t.runNow}</button></section>
<section class="card"><h2>${t.otp}</h2><p class="muted">${t.otpHelp}</p><form id="otp-security-form"><input id="otp-security-confirm" name="confirmText" autocomplete="off" placeholder="${t.confirmation}"><button id="otp-security-recover" type="submit">${t.resetOtp}</button></form><pre id="otp-security-state">${t.serverState}</pre></section>
<section class="card"><h2>${t.qhkey}</h2><p class="muted">${t.qhkeyHelp}</p><pre id="qhkey-state">${t.checking}</pre></section>
${integrationHtml}
<section class="card"><h2>${t.operator}</h2><p class="muted">${t.operatorHelp}</p></section>
<p id="message"></p><script>const token=${JSON.stringify(actionToken)};const actionMessages=${JSON.stringify(actionMessages)};const headers={'X-QuickHack-Console-Token':token};async function refresh(){const r=await fetch('/api/status',{cache:'no-store'});const p=await r.json();document.getElementById('status').textContent=JSON.stringify(p,null,2);document.getElementById('qhkey-state').textContent=JSON.stringify(p.qhkey||{},null,2);document.getElementById('otp-security-state').textContent=JSON.stringify(p.totpSecurity||{},null,2)}async function post(url,body){const r=await fetch(url,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body||{})});const p=await r.json();document.getElementById('message').textContent=actionMessages[p.messageCode]||p.message||p.code||'';await refresh();return p}document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await post(b.dataset.action)}finally{b.disabled=false}});document.getElementById('otp-security-form').onsubmit=async(e)=>{e.preventDefault();await post('/api/totp-security/recover',{confirmText:new FormData(e.currentTarget).get('confirmText')})};window.quickHackConsolePost=post;setInterval(refresh,2000);refresh()</script></main></body></html>`;
}

export function createServerConsole(input) {
  const flavor = assertPackageFlavor(input.flavor);
  const integration = input.integration;
  if (!integration || integration.flavor !== flavor) throw new TypeError("The console integration composition does not match its package flavor.");
  const root = path.resolve(input.root ?? path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
  const args = input.arguments ?? parseServerConsoleArguments(process.argv.slice(2));
  const runtimeConfigPath = args.runtimeConfigPath || sourceServerRuntimeConfigPath(root);
  const runtime = (input.operatorPlatform ?? composeOperatorPlatform()).serverConsoleRuntime;
  const serverPlatform = input.serverPlatform ?? composeServerPlatform();
  const nodeExecutable = path.resolve(input.nodeExecutable ?? process.execPath);
  const actionToken = crypto.randomBytes(32).toString("hex");
  const managed = new Map();
  const credentialHandoffs = new Map();
  let stopping = false;
  let lastError = null;
  let actionTokenPath = "";

  function config() {
    const value = readServerRuntimeConfigSync({ configPath: runtimeConfigPath, kind: args.runtimeConfigPath ? "operational" : "source", sourceRoot: root }).config;
    if (assertPackageFlavor(value.packageFlavor) !== flavor) {
      const error = new Error("The runtime configuration does not match the installed package flavor.");
      error.code = "PACKAGE_FLAVOR_MISMATCH";
      throw error;
    }
    return value;
  }

  async function callBackend(pathname, method = "GET", body = undefined) {
    const response = await fetch(`http://127.0.0.1:${DEFAULT_PORTS.backend}${pathname}`, {
      method,
      cache: "no-store",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "X-QuickHack-Supervisor-Token": actionToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
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
    const wasRunning = managed.has("backend") || managed.has("gateway");
    if (wasRunning) await stop();
    await runtime.secureDirectory(path.dirname(runtimeConfigPath));
    writeServerRuntimeConfigAtomicSync(runtimeConfigPath, next);
    if (wasRunning) await start();
    return { changed: true, runtimeSettings: next, restarted: wasRunning, message: "Runtime settings updated." };
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
      overrides: { ...overrides, CREDENTIALS_DIRECTORY: credentialDirectory || undefined },
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
    const child = spawn(plan.nodeExecutable, plan.args, { cwd: plan.cwd, env: environment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    managed.set(id, child);
    child.once("error", (error) => {
      lastError = { code: error?.code || "CHILD_SPAWN_FAILED", child: id };
      if (managed.get(id) === child) managed.delete(id);
      const handoff = credentialHandoffs.get(id);
      if (handoff) {
        fs.rmSync(handoff, { recursive: true, force: true });
        credentialHandoffs.delete(id);
      }
    });
    child.once("exit", (code, signal) => {
      if (!stopping && code !== 0) lastError = { code: "CHILD_EXITED", child: id, exitCode: code, signal };
      if (managed.get(id) === child) managed.delete(id);
      const handoff = credentialHandoffs.get(id);
      if (handoff) {
        fs.rmSync(handoff, { recursive: true, force: true });
        credentialHandoffs.delete(id);
      }
    });
    return child;
  }

  async function start() {
    if (managed.has("backend") || managed.has("gateway")) return { changed: false, message: "QuickHack is already starting or running." };
    const database = await serverPlatform.postgresqlService.status();
    if (database.state !== "ACTIVE") {
      const error = new Error("PostgreSQL service is not active; the application was not partially started.");
      error.code = "DEPENDENCY_UNAVAILABLE";
      throw error;
    }
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
    if (!(await waitForHealthy(`http://127.0.0.1:${DEFAULT_PORTS.backend}/api/runtime`))) {
      await runtime.terminateOwnedProcess(backendChild.pid);
      const error = new Error("The backend did not become ready.");
      error.code = "CHILD_START_FAILED";
      throw error;
    }
    try {
      await completeRestoreBarrier(restoreBarrier);
    } catch (error) {
      await runtime.terminateOwnedProcess(backendChild.pid);
      throw error;
    }
    const gatewayChild = spawnOwned("gateway", gateway, childEnvironment({
      QUICKHACK_HTTPS_HOST: "0.0.0.0",
      QUICKHACK_HTTPS_PORT: DEFAULT_PORTS.gateway,
      QUICKHACK_UPSTREAM_HOST: "127.0.0.1",
      QUICKHACK_UPSTREAM_PORT: DEFAULT_PORTS.backend,
      QUICKHACK_TLS_PFX_FILE: gateway.tls.paths.serverPfx,
      QUICKHACK_TLS_PFX_PASSPHRASE_FILE: gateway.tls.paths.serverPassphrase,
      QUICKHACK_SUPERVISOR_TOKEN: actionToken,
    }));
    if (!(await waitForSecureHealthy(`https://127.0.0.1:${DEFAULT_PORTS.gateway}/__quickhack_tls_health`, gateway.tls.paths.rootCaPem))) {
      await runtime.terminateOwnedProcess(gatewayChild.pid);
      await runtime.terminateOwnedProcess(backendChild.pid);
      const error = new Error("The HTTPS gateway did not become ready.");
      error.code = "CHILD_START_FAILED";
      throw error;
    }
    const integrationResults = await integration.startChildren({ root, nodeExecutable, runtimeConfig, spawnOwned, childEnvironment, createCredentialHandoff });
    return { changed: true, message: "QuickHack application start requested.", backendPid: backendChild.pid, gatewayPid: gatewayChild.pid, integrationResults };
  }

  async function stop() {
    stopping = true;
    const ordered = ["gateway", ...integration.childIds.slice().reverse(), "backend"];
    const stopped = [];
    for (const id of ordered) {
      const child = managed.get(id);
      if (!child) continue;
      child.kill("SIGTERM");
      if (!(await waitForExit(child, 180_000))) await runtime.terminateOwnedProcess(child.pid);
      stopped.push(id);
      managed.delete(id);
      const handoff = credentialHandoffs.get(id);
      if (handoff) {
        fs.rmSync(handoff, { recursive: true, force: true });
        credentialHandoffs.delete(id);
      }
    }
    stopping = false;
    return { changed: stopped.length > 0, message: "QuickHack application stopped.", stopped };
  }

  async function status() {
    const runtimeConfig = config();
    const tls = getQuickHackTlsStatus(runtimeConfig.dataDirectory);
    const [database, backend, gateway, integrationStatus, qhkey, totpSecurity, backups] = await Promise.all([
      serverPlatform.postgresqlService.status(),
      health(`http://127.0.0.1:${DEFAULT_PORTS.backend}/api/runtime`),
      tls.ready
        ? secureHealth(`https://127.0.0.1:${DEFAULT_PORTS.gateway}/__quickhack_tls_health`, tls.paths.rootCaPem)
        : Promise.resolve({ ok: false, status: null, error: "TLS_UNAVAILABLE" }),
      integration.status({ managed, config: runtimeConfig }),
      publicObservation(
        () => getQhkeyConsoleStatus(runtimeConfig.dataDirectory, runtimeConfig.environment === "production"),
        "QHKEY_STATUS_UNAVAILABLE"
      ),
      publicObservation(
        () => callBackend("/api/internal/supervisor/totp-security"),
        "TOTP_SECURITY_STATUS_UNAVAILABLE"
      ),
      publicObservation(
        () => callBackend("/api/internal/supervisor/backups"),
        "BACKUP_STATUS_UNAVAILABLE"
      ),
    ]);
    const applicationState = backend.ok && gateway.ok && integrationStatus.ready
      ? "ACTIVE"
      : managed.size > 0 || backend.ok || gateway.ok
        ? "DEGRADED"
        : "INACTIVE";
    return {
      flavor,
      runtimeSettings: {
        environment: runtimeConfig.environment,
        coupangWriteApiEnabled: runtimeConfig.coupangWriteApiEnabled,
        logenWriteApiEnabled: runtimeConfig.logenWriteApiEnabled,
      },
      applicationState,
      database,
      backend,
      gateway,
      integration: integrationStatus,
      tls: {
        ready: tls.ready,
        errors: tls.errors,
        origin: tls.trustBundle?.origin ?? "",
        currentCaSha256: tls.trustBundle?.manifest.currentCaSha256 ?? "",
        previousCaSha256: tls.trustBundle?.manifest.previousCaSha256 ?? "",
        rotationNotBefore: tls.trustBundle?.manifest.rotationNotBefore ?? "",
      },
      qhkey: redactedPublicValue(qhkey),
      totpSecurity,
      backups,
      lastError,
    };
  }

  async function runBackupNow() {
    return callBackend(
      "/api/internal/supervisor/backups",
      "POST",
      { action: "runNow", workerKey: "database-auto-backup" }
    );
  }

  async function replaceTls(mode) {
    const wasRunning = managed.size > 0;
    if (wasRunning) await stop();
    const runtimeConfig = config();
    const hosts = tlsHostSelection();
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
      if (request.method === "GET" && requestUrl.pathname === "/") {
        const locale = resolveServerConsoleLocale(request.headers["accept-language"]);
        return html(response, consolePage({ flavor, actionToken, locale, integrationHtml: integration.renderHtml(serverConsoleMessages(locale)) }));
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/status") return json(response, 200, await status());
      if (request.method === "GET" && requestUrl.pathname === "/api/qhkey/status") {
        const runtimeConfig = config();
        return json(response, 200, redactedPublicValue(await getQhkeyConsoleStatus(runtimeConfig.dataDirectory, runtimeConfig.environment === "production")));
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/qhkey/replacement-status") {
        return json(response, 200, await getQhkeyReplacementStatus(config().dataDirectory, requestUrl.searchParams.get("transactionId")));
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/database-management/status") {
        return json(response, 200, await callBackend("/api/internal/supervisor/backups"));
      }
      if (request.method === "POST") {
        if (request.headers["x-quickhack-console-token"] !== actionToken) return json(response, 404, { ok: false, code: "NOT_FOUND" });
        const payload = await readRequestBody(request);
        if (["/api/application/start", "/api/quickhack/start"].includes(requestUrl.pathname)) return json(response, 202, { ok: true, ...(await start()) });
        if (["/api/application/stop", "/api/quickhack/stop"].includes(requestUrl.pathname)) return json(response, 202, { ok: true, ...(await stop()) });
        if (["/api/operator/backup", "/api/database-management/run"].includes(requestUrl.pathname)) return json(response, 202, { ok: true, ...(await runBackupNow()) });
        if (requestUrl.pathname === "/api/runtime/toggle-environment") {
          const current = config();
          return json(response, 202, { ok: true, ...(await updateRuntimeSettings({ environment: current.environment === "production" ? "development" : "production" })) });
        }
        if (requestUrl.pathname === "/api/runtime/toggle-coupang-write-api") {
          const current = config();
          return json(response, 202, { ok: true, ...(await updateRuntimeSettings({ coupangWriteApiEnabled: !current.coupangWriteApiEnabled })) });
        }
        if (requestUrl.pathname === "/api/runtime/toggle-logen-write-api") {
          const current = config();
          return json(response, 202, { ok: true, ...(await updateRuntimeSettings({ logenWriteApiEnabled: !current.logenWriteApiEnabled })) });
        }
        if (requestUrl.pathname === "/api/totp-security/recover") {
          return json(response, 200, await callBackend("/api/internal/supervisor/totp-security", "POST", { confirmText: String(payload.confirmText ?? "") }));
        }
        if (requestUrl.pathname === "/api/qhkey/replacement-cancel") {
          return json(response, 200, await cancelQhkeyReplacement(config().dataDirectory, payload.transactionId));
        }
        if (requestUrl.pathname === "/api/tls/initialize") return json(response, 200, await replaceTls("INITIALIZE"));
        if (requestUrl.pathname === "/api/tls/rotate") return json(response, 200, await replaceTls("ROTATE"));
        if (requestUrl.pathname === "/api/tls/finalize-rotation") return json(response, 200, await replaceTls("FINALIZE_ROTATION"));
        const integrationResult = await integration.handleAction(requestUrl.pathname, { root, config: config(), managed, payload });
        if (integrationResult) return json(response, integrationResult.status ?? 200, redactedPublicValue(integrationResult.payload));
      }
      return json(response, 404, { ok: false, code: "NOT_FOUND" });
    } catch (error) {
      lastError = { code: error?.code || "CONSOLE_OPERATION_FAILED" };
      return json(response, Number(error?.statusCode) || 500, { ok: false, ...lastError });
    }
  });

  async function listen() {
    const runtimeConfig = config();
    const operatorStateDirectory = path.join(path.resolve(runtimeConfig.dataDirectory), "state", "operator");
    await runtime.secureDirectory(operatorStateDirectory);
    actionTokenPath = path.join(operatorStateDirectory, "server-console-action.json");
    writeActionTokenFile(actionTokenPath, actionToken);
    try {
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
    if (args.systemService) await start().catch((error) => { lastError = { code: error?.code || "APPLICATION_START_FAILED" }; });
    return { host: "127.0.0.1", port: DEFAULT_PORTS.console, flavor };
  }

  async function close(signal = "SIGTERM") {
    await stop();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (actionTokenPath) fs.rmSync(actionTokenPath, { force: true });
    return { signal };
  }

  return Object.freeze({ flavor, listen, close, start, stop, status, server });
}

export async function runServerConsole(input) {
  const consoleRuntime = createServerConsole(input);
  await consoleRuntime.listen();
  let signalCount = 0;
  const shutdown = (signal) => {
    signalCount += 1;
    if (signalCount > 1) process.exit(1);
    void consoleRuntime.close(signal).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return consoleRuntime;
}
