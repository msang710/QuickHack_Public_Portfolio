import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";

const SS_EXECUTABLE = "/usr/bin/ss";
const TIMEDATECTL_EXECUTABLE = "/usr/bin/timedatectl";
const XDG_OPEN_EXECUTABLE = "/usr/bin/xdg-open";

function execute(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { shell: false, timeout: 15_000, maxBuffer: 256 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === "number" ? error.code : null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        error: error ? String(error.code ?? "PROCESS_FAILED") : null,
      });
    });
  });
}

export function createLinuxServerConsoleRuntime(options = {}) {
  const environment = options.environment ?? process.env;
  const interactive = options.interactive ?? Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);

  function childEnvironment({ executableDirectories = [], overrides = {} } = {}) {
    return createChildProcessEnvironment({
      policy: createLinuxChildProcessPolicy(environment),
      source: environment,
      executableDirectories,
      overrides,
    });
  }

  async function execFileText(file, args, execOptions = {}) {
    if (!path.posix.isAbsolute(file)) throw new TypeError("Linux console processes require an absolute executable path.");
    return execute(file, args, { env: execOptions.env ?? childEnvironment(), ...execOptions });
  }

  async function timeStatus() {
    const result = await execFileText(TIMEDATECTL_EXECUTABLE, ["show", "--property=NTPSynchronized", "--value"]);
    const value = result.stdout.trim().toLowerCase();
    return Object.freeze({
      ok: result.ok && value === "yes",
      source: "systemd-timesyncd",
      rawStatus: value,
      error: result.ok ? "" : "TIME_STATUS_UNAVAILABLE",
    });
  }

  async function portPids(port, { strict = false } = {}) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError("A valid TCP port is required.");
    const result = await execFileText(SS_EXECUTABLE, ["-H", "-ltnp", `sport = :${port}`]);
    if (!result.ok) {
      if (strict) {
        const error = new Error(`Port ${port} could not be inspected.`);
        error.code = "PORT_INSPECTION_FAILED";
        throw error;
      }
      return [];
    }
    const values = new Set();
    for (const match of result.stdout.matchAll(/pid=(\d+)/gu)) {
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid) && pid > 0) values.add(pid);
    }
    return [...values];
  }

  async function terminateOwnedProcess(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }

  async function processMetadata(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    try {
      const [executablePath, commandLine] = await Promise.all([
        fs.readlink(`/proc/${pid}/exe`),
        fs.readFile(`/proc/${pid}/cmdline`, "utf8"),
      ]);
      return { ProcessId: pid, ExecutablePath: executablePath, CommandLine: commandLine.replaceAll("\0", " ").trim() };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  function sameExecutablePath(left, right) {
    return path.posix.normalize(String(left ?? "")) === path.posix.normalize(String(right ?? ""));
  }

  function commandContainsPath(commandLine, expectedPath) {
    return String(commandLine ?? "").includes(path.posix.normalize(String(expectedPath ?? "")));
  }

  function launch(target) {
    if (!interactive) return false;
    const child = spawn(XDG_OPEN_EXECUTABLE, [String(target)], {
      detached: true,
      stdio: "ignore",
      shell: false,
      env: childEnvironment({ executableDirectories: ["/usr/bin"] }),
    });
    child.unref();
    return true;
  }

  async function secureDirectory(directoryPath) {
    const absolute = path.resolve(directoryPath);
    await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      const error = new Error("The console directory is not a safe directory.");
      error.code = "RUNTIME_DIRECTORY_INVALID";
      throw error;
    }
    await fs.chmod(absolute, 0o700);
  }

  async function initializeTls(input) {
    const tlsInitializer = await import("./server-console-tls-initializer.mjs");
    return tlsInitializer.initializeLinuxServerConsoleTls({ ...input, runtime: api });
  }

  const api = Object.freeze({
    descriptor: Object.freeze({ id: "server-console-runtime", role: "operator", platform: "linux", state: "READY", ownerStage: "PR-09" }),
    interactive,
    requiresExternalDatabaseOperations: true,
    childEnvironment,
    execFileText,
    timeStatus,
    portPids,
    terminateOwnedProcess,
    processMetadata,
    sameExecutablePath,
    commandContainsPath,
    openUrl: launch,
    openPath: launch,
    secureDirectory,
    initializeTls,
  });
  return api;
}
