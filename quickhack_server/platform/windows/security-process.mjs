import { spawn, spawnSync } from "node:child_process";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import {
  createWindowsChildProcessPolicy,
  resolveWindowsSystemExecutable,
  windowsSystemPaths,
} from "../../../quickhack_shared/platform/windows/child-process-policy.mjs";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const WINDOWS_SECURITY_OPERATION_TIMEOUT_MS = 60_000;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requireWindows(platform) {
  if (platform !== "win32") {
    throw new Error("Windows security process execution is unavailable.");
  }
}

function standardInput(options = {}) {
  let input = String(options.input ?? "");
  if (options.inputLine === undefined) return input;
  const line = String(options.inputLine);
  if (input.length > 0) {
    throw new Error("PowerShell input and inputLine cannot be used together.");
  }
  if (/[\r\n]/u.test(line)) {
    throw new Error("PowerShell inputLine must contain exactly one line.");
  }
  return `${line}\r\n`;
}

function childEnvironment(environment) {
  const systemPaths = windowsSystemPaths(environment);
  return createChildProcessEnvironment({
    policy: createWindowsChildProcessPolicy(environment),
    source: environment,
    executableDirectories: [systemPaths.powerShellDirectory],
  });
}

function commandError(commandName, result) {
  const stderr = String(result?.stderr ?? "").trim();
  const error = new Error(
    stderr ||
      `${commandName} failed with exit code ${result?.status ?? "unknown"}.`
  );
  if (result?.error?.code === "ETIMEDOUT") {
    error.code = "POWERSHELL_TIMEOUT";
  }
  return error;
}

export function createWindowsSecurityProcess(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const spawnProcess = options.spawnProcess ?? spawn;
  const spawnProcessSync = options.spawnProcessSync ?? spawnSync;

  function runCommand(
    executableKey,
    args,
    {
      input = "",
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    } = {}
  ) {
    requireWindows(platform);
    const boundedTimeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
    const boundedOutputBytes = positiveInteger(
      maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES
    );
    const executable = resolveWindowsSystemExecutable(
      executableKey,
      environment
    );

    return new Promise((resolve, reject) => {
      const child = spawnProcess(executable, args, {
        env: childEnvironment(environment),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;
      let outputExceeded = false;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const stopChild = () => {
        if (!child.killed) child.kill();
      };
      const appendChunk = (chunks, chunk, isStdout) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (isStdout) stdoutBytes += value.length;
        else stderrBytes += value.length;
        if (
          stdoutBytes > boundedOutputBytes ||
          stderrBytes > boundedOutputBytes
        ) {
          outputExceeded = true;
          stopChild();
          return;
        }
        chunks.push(value);
      };

      child.stdout.on("data", (chunk) => appendChunk(stdoutChunks, chunk, true));
      child.stderr.on("data", (chunk) => appendChunk(stderrChunks, chunk, false));
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (timedOut) {
          const error = new Error(
            `${executableKey} operation timed out after ${boundedTimeoutMs}ms.`
          );
          error.code = "POWERSHELL_TIMEOUT";
          finish(error);
          return;
        }
        if (outputExceeded) {
          finish(new Error(`${executableKey} output exceeded the configured limit.`));
          return;
        }
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          finish(
            new Error(
              stderr ||
                `${executableKey} failed with exit code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`
            )
          );
          return;
        }
        finish(null, Buffer.concat(stdoutChunks).toString("utf8").trim());
      });

      const timer = setTimeout(() => {
        timedOut = true;
        stopChild();
      }, boundedTimeoutMs);
      timer.unref?.();

      child.stdin.on("error", () => undefined);
      child.stdin.end(String(input ?? ""), "utf8");
    });
  }

  function runCommandSync(
    executableKey,
    args,
    {
      input = "",
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    } = {}
  ) {
    requireWindows(platform);
    const result = spawnProcessSync(
      resolveWindowsSystemExecutable(executableKey, environment),
      args,
      {
        input: String(input ?? ""),
        env: childEnvironment(environment),
        encoding: "utf8",
        windowsHide: true,
        timeout: positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS),
        maxBuffer: positiveInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      }
    );
    if (result.status !== 0 || result.error) {
      throw commandError(executableKey, result);
    }
    return String(result.stdout ?? "").trim();
  }

  async function runPowerShellScript(script, options = {}) {
    const attempts = Math.min(positiveInteger(options.timeoutAttempts, 1), 3);
    const input = standardInput(options);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await runCommand(
          "powerShell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            String(script ?? ""),
          ],
          { ...options, input }
        );
      } catch (error) {
        if (
          error?.code !== "POWERSHELL_TIMEOUT" ||
          attempt === attempts
        ) {
          throw error;
        }
      }
    }
    throw new Error("PowerShell operation exhausted its timeout attempts.");
  }

  function runPowerShellScriptSync(script, options = {}) {
    const attempts = Math.min(positiveInteger(options.timeoutAttempts, 1), 3);
    const input = standardInput(options);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return runCommandSync(
          "powerShell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            String(script ?? ""),
          ],
          { ...options, input }
        );
      } catch (error) {
        if (
          error?.code !== "POWERSHELL_TIMEOUT" ||
          attempt === attempts
        ) {
          throw error;
        }
      }
    }
    throw new Error("PowerShell operation exhausted its timeout attempts.");
  }

  return Object.freeze({
    runCommand,
    runCommandSync,
    runPowerShellScript,
    runPowerShellScriptSync,
  });
}

const windowsSecurityProcess = createWindowsSecurityProcess();

export const runWindowsSystemCommand = windowsSecurityProcess.runCommand;
export const runWindowsSystemCommandSync = windowsSecurityProcess.runCommandSync;
export const runPowerShellScript = windowsSecurityProcess.runPowerShellScript;
export const runPowerShellScriptSync =
  windowsSecurityProcess.runPowerShellScriptSync;
