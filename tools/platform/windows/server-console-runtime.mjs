import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import {
  createWindowsChildProcessPolicy,
  resolveWindowsSystemExecutable,
  windowsSystemPaths,
} from "../../../quickhack_shared/platform/windows/child-process-policy.mjs";
import { runPowerShellScript } from "../../../quickhack_server/security/async-powershell.mjs";

function execute(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === "number" ? error.code : null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        error: error ? String(error.message ?? error) : null,
      });
    });
  });
}

export function createWindowsServerConsoleRuntime(options = {}) {
  const environment = options.environment ?? process.env;
  const systemPaths = windowsSystemPaths(environment);
  const netstat = resolveWindowsSystemExecutable("netstat", environment);
  const taskkill = resolveWindowsSystemExecutable("taskkill", environment);
  const w32tm = resolveWindowsSystemExecutable("w32tm", environment);

  function childEnvironment({ executableDirectories = [], overrides = {} } = {}) {
    return createChildProcessEnvironment({
      policy: createWindowsChildProcessPolicy(environment),
      source: environment,
      executableDirectories,
      overrides,
    });
  }

  async function execFileText(file, args, execOptions = {}) {
    return execute(file, args, {
      env: execOptions.env ?? childEnvironment(),
      ...execOptions,
    });
  }

  async function timeStatus() {
    const [sourceResult, statusResult] = await Promise.all([
      execFileText(w32tm, ["/query", "/source"]),
      execFileText(w32tm, ["/query", "/status"]),
    ]);
    return Object.freeze({
      ok: sourceResult.ok && statusResult.ok,
      source: sourceResult.ok ? sourceResult.stdout.trim().split(/\r?\n/u)[0] ?? "" : "",
      rawStatus: statusResult.ok ? statusResult.stdout.trim() : "",
      error: [sourceResult.error, sourceResult.stderr.trim(), statusResult.error, statusResult.stderr.trim()].filter(Boolean).join(" / "),
    });
  }

  async function portPids(port, { strict = false } = {}) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError("A valid TCP port is required.");
    const result = await execFileText(netstat, ["-ano"]);
    if (!result.ok) {
      if (strict) {
        const error = new Error(`Port ${port} could not be inspected.`);
        error.code = "PORT_INSPECTION_FAILED";
        throw error;
      }
      return [];
    }
    const values = new Set();
    const pattern = new RegExp(`:${port}\\s`, "u");
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (!line.includes("LISTENING") || !pattern.test(line)) continue;
      const pid = Number.parseInt(line.trim().split(/\s+/u).at(-1), 10);
      if (Number.isSafeInteger(pid) && pid > 0) values.add(pid);
    }
    return [...values];
  }

  async function terminateOwnedProcess(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    const result = await execFileText(taskkill, ["/F", "/T", "/PID", String(pid)]);
    if (result.ok) return true;
    try {
      process.kill(pid);
      return true;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }

  async function processMetadata(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    const output = await runPowerShellScript(
      "$rawPid=[Console]::In.ReadLine(); $processId=0; " +
        "if(-not [int]::TryParse($rawPid,[ref]$processId)-or $processId -le 0){throw 'Invalid process id.'}; " +
        "$process=Get-CimInstance Win32_Process -Filter \"ProcessId = $processId\"; " +
        "if($null -ne $process){[pscustomobject]@{ProcessId=[int]$process.ProcessId;ExecutablePath=[string]$process.ExecutablePath;CommandLine=[string]$process.CommandLine}|ConvertTo-Json -Compress}",
      { inputLine: String(pid), timeoutMs: 5000, maxOutputBytes: 64 * 1024 }
    );
    return output ? JSON.parse(output) : null;
  }

  function sameExecutablePath(left, right) {
    return path.win32.normalize(String(left ?? "")).toLowerCase() === path.win32.normalize(String(right ?? "")).toLowerCase();
  }

  function commandContainsPath(commandLine, expectedPath) {
    return String(commandLine ?? "").replaceAll("/", "\\").toLowerCase().includes(
      path.win32.normalize(String(expectedPath ?? "")).toLowerCase()
    );
  }

  function openUrl(url) {
    const child = spawn(systemPaths.commandShell, ["/c", "start", "", String(url)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      env: childEnvironment(),
    });
    child.unref();
  }

  function openPath(targetPath) {
    const child = spawn(systemPaths.explorer, [path.resolve(targetPath)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      env: childEnvironment(),
    });
    child.unref();
  }

  async function secureDirectory(directoryPath) {
    const secretStorage = await import("../../../quickhack_server/security/windows-user-protected-secret.mjs");
    await secretStorage.ensureCurrentWindowsUserSecretDirectory(path.resolve(directoryPath));
  }

  async function initializeTls(input) {
    const tlsInitializer = await import("./server-console-tls-initializer.mjs");
    return tlsInitializer.initializeWindowsServerConsoleTls(input);
  }

  return Object.freeze({
    descriptor: Object.freeze({ id: "server-console-runtime", role: "operator", platform: "win32", state: "COMPATIBILITY", ownerStage: "PR-09" }),
    interactive: true,
    requiresExternalDatabaseOperations: false,
    childEnvironment,
    execFileText,
    timeStatus,
    portPids,
    terminateOwnedProcess,
    processMetadata,
    sameExecutablePath,
    commandContainsPath,
    openUrl,
    openPath,
    secureDirectory,
    initializeTls,
  });
}
