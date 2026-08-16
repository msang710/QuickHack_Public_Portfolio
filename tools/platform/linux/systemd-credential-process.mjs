import { spawn } from "node:child_process";

export const SYSTEMD_CREDS_EXECUTABLE = "/usr/bin/systemd-creds";
export const SYSTEMD_CREDENTIAL_PROCESS_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

export class SystemdCredentialProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SystemdCredentialProcessError";
    this.code = code;
  }
}

function minimalEnvironment(source = process.env) {
  const result = {
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  for (const name of ["HOME", "LOGNAME", "USER", "TMPDIR"]) {
    const value = String(source?.[name] ?? "").trim();
    if (value) result[name] = value;
  }
  return result;
}

export function runSystemdCredentialProcess(args, options = {}) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new TypeError("systemd-creds arguments must be a string array.");
  }
  const executable = options.executable ?? SYSTEMD_CREDS_EXECUTABLE;
  if (executable !== SYSTEMD_CREDS_EXECUTABLE) {
    throw new TypeError("The systemd-creds executable path is fixed.");
  }
  const input = options.input;
  if (input !== undefined && !Buffer.isBuffer(input)) {
    throw new TypeError("systemd-creds input must be a Buffer.");
  }
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? SYSTEMD_CREDENTIAL_PROCESS_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const child = spawnProcess(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: minimalEnvironment(options.environment),
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new SystemdCredentialProcessError(
          "SYSTEMD_CREDS_TIMEOUT",
          "systemd-creds did not finish within the allowed time."
        )
      );
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const chunk of stdout) chunk.fill(0);
      for (const chunk of stderr) chunk.fill(0);
      if (error) reject(error);
      else resolve(result);
    }

    child.on("error", () => {
      finish(
        new SystemdCredentialProcessError(
          "SYSTEMD_CREDS_UNAVAILABLE",
          "systemd-creds could not be started."
        )
      );
    });
    child.stdout.on("data", (chunkValue) => {
      const chunk = Buffer.from(chunkValue);
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        chunk.fill(0);
        child.kill("SIGKILL");
        finish(
          new SystemdCredentialProcessError(
            "SYSTEMD_CREDS_OUTPUT_LIMIT",
            "systemd-creds exceeded the output limit."
          )
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunkValue) => {
      const chunk = Buffer.from(chunkValue);
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        chunk.fill(0);
        child.kill("SIGKILL");
        finish(
          new SystemdCredentialProcessError(
            "SYSTEMD_CREDS_OUTPUT_LIMIT",
            "systemd-creds exceeded the output limit."
          )
        );
        return;
      }
      stderr.push(chunk);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (signal) {
        finish(
          new SystemdCredentialProcessError(
            "SYSTEMD_CREDS_SIGNAL",
            "systemd-creds ended before completing the operation."
          )
        );
        return;
      }
      if (code !== 0) {
        finish(
          new SystemdCredentialProcessError(
            "SYSTEMD_CREDS_EXIT",
            "systemd-creds rejected the requested operation."
          )
        );
        return;
      }
      finish(undefined, Buffer.concat(stdout, stdoutBytes));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}
