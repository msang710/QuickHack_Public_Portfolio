import { execFile } from "node:child_process";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";

export const ONE_SHOT_OPERATIONS = Object.freeze(["MIGRATE", "RESTORE", "PROVISION_INITIAL_LEADER"]);
const UNITS = Object.freeze({
  MIGRATE: "quickhack-migrate.service",
  RESTORE: "quickhack-operator@restore.service",
  PROVISION_INITIAL_LEADER: "quickhack-operator@provision-initial-leader.service",
});

function defaultRun(args) {
  return new Promise((resolve, reject) => {
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
    }, (error, stdout) => {
      if (error) {
        const failure = new Error("The privileged one-shot operation failed.");
        failure.code = error.killed ? "OPERATION_TIMEOUT" : "OPERATION_FAILED";
        reject(failure);
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

export function createSystemdOneShotProcess(options = {}) {
  const run = options.run ?? defaultRun;
  async function execute(operationValue) {
    const operation = String(operationValue ?? "").trim().toUpperCase();
    if (!ONE_SHOT_OPERATIONS.includes(operation)) {
      const error = new Error("The privileged operation is not a finite QuickHack operation.");
      error.code = "OPERATOR_COMMAND_INVALID";
      throw error;
    }
    const unit = UNITS[operation];
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
