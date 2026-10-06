import { execFile } from "node:child_process";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";

export const ONE_SHOT_OPERATIONS = Object.freeze(["MIGRATE", "RESTORE", "PROVISION_INITIAL_LEADER"]);
const DEFAULT_UNITS = Object.freeze({
  MIGRATE: "quickhack-migrate.service",
  RESTORE: "quickhack-operator@restore.service",
  PROVISION_INITIAL_LEADER: "quickhack-initial-leader.service",
});

function serviceUnit(value) {
  if (!/^[a-z0-9][a-z0-9@_.-]{0,126}\.service$/u.test(value)) {
    throw new TypeError("The one-shot systemd unit is invalid.");
  }
  return value;
}

export function oneShotUnitsForPackageServices(services) {
  const operatorTemplate = serviceUnit(services?.operator);
  if (!operatorTemplate.endsWith("@.service")) throw new TypeError("The one-shot operator unit template is invalid.");
  return Object.freeze({
    MIGRATE: serviceUnit(services?.migrate),
    RESTORE: operatorTemplate.replace("@.service", "@restore.service"),
    PROVISION_INITIAL_LEADER: serviceUnit(services?.initialLeader),
  });
}

function journalFailureCode(unit, since) {
  return new Promise((resolve) => {
    execFile("/usr/bin/journalctl", ["-u", unit, "--since", since, "-n", "30", "--no-pager", "-o", "cat"], { shell: false, timeout: 5_000, maxBuffer: 64 * 1024 }, (_error, stdout) => {
      const codes = [...String(stdout ?? "").matchAll(/^([A-Z][A-Z0-9_]{2,63}):/gmu)].map((match) => match[1]);
      resolve(codes.at(-1) ?? null);
    });
  });
}

function defaultRun(args) {
  return new Promise((resolve, reject) => {
    const since = new Date(Date.now() - 1_000).toISOString();
    execFile("/usr/bin/systemctl", args, {
      shell: false,
      windowsHide: true,
      timeout: 60 * 60_000,
      maxBuffer: 256 * 1024,
      env: createChildProcessEnvironment({
        policy: createLinuxChildProcessPolicy(process.env),
        source: process.env,
        executableDirectories: ["/usr/bin"],
        overrides: { LANG: "C", LC_ALL: "C" },
      }),
    }, async (error, stdout) => {
      if (error) {
        const failure = new Error("The privileged one-shot operation failed.");
        failure.code = error.killed ? "OPERATION_TIMEOUT" : await journalFailureCode(args[1], since).catch(() => null) ?? "OPERATION_FAILED";
        reject(failure);
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

export function createSystemdOneShotProcess(options = {}) {
  const run = options.run ?? defaultRun;
  const units = Object.freeze(Object.fromEntries(ONE_SHOT_OPERATIONS.map((operation) => [
    operation,
    serviceUnit(options.units?.[operation] ?? DEFAULT_UNITS[operation]),
  ])));
  async function execute(operationValue) {
    const operation = String(operationValue ?? "").trim().toUpperCase();
    if (!ONE_SHOT_OPERATIONS.includes(operation)) {
      const error = new Error("The privileged operation is not a finite QuickHack operation.");
      error.code = "OPERATOR_COMMAND_INVALID";
      throw error;
    }
    const unit = units[operation];
    await run(["start", unit, "--wait"]);
    const result = await run(["show", unit, "--no-pager", "--property=Result,ExecMainStatus,ActiveState"]);
    const fields = Object.fromEntries(String(result).split(/\r?\n/u).map((line) => line.split("=", 2)).filter((parts) => parts.length === 2));
    if (fields.Result && fields.Result !== "success") {
      const error = new Error("The privileged one-shot operation did not complete successfully.");
      error.code = "OPERATION_FAILED";
      throw error;
    }
    return Object.freeze({ operation, unit, state: "COMPLETED", result: fields.Result || "success" });
  }
  return Object.freeze({ execute });
}
