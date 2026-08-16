import { spawnSync } from "node:child_process";
import path from "node:path";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import {
  createWindowsChildProcessPolicy,
  resolveWindowsSystemExecutable,
} from "../../../quickhack_shared/platform/windows/child-process-policy.mjs";

export function createWindowsOperatorProcessExecution(
  platform = "win32",
  { spawnSyncImplementation = spawnSync, environment = process.env } = {}
) {
  const descriptor = Object.freeze({
    id: "process-execution",
    role: "operator",
    platform,
    state: "READY",
    ownerStage: "PR-04",
  });
  const childEnvironment = (input = {}) => {
    const source = input.source ?? environment;
    return createChildProcessEnvironment({
      ...input,
      source,
      policy: createWindowsChildProcessPolicy(source),
    });
  };
  return Object.freeze({
    descriptor,
    childEnvironment,
    terminateOwnedProcess(pid) {
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new TypeError("A positive owned process id is required.");
      }
      const result = spawnSyncImplementation(
        resolveWindowsSystemExecutable("taskkill", environment),
        ["/F", "/T", "/PID", String(pid)],
        {
          windowsHide: true,
          stdio: "ignore",
          env: childEnvironment(),
        }
      );
      if (result.status !== 0) {
        throw new Error(`Unable to terminate owned Windows process tree: ${pid}.`);
      }
    },
    sameExecutablePath(left, right) {
      return path.win32.normalize(path.win32.resolve(left)).toLowerCase() ===
        path.win32.normalize(path.win32.resolve(right)).toLowerCase();
    },
  });
}
