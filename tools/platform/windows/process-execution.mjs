import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import {
  createWindowsChildProcessPolicy,
  resolveWindowsSystemExecutable,
} from "../../../quickhack_shared/platform/windows/child-process-policy.mjs";

function isAbsoluteWindowsPath(value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(String(value ?? ""));
}

export function createWindowsOperatorProcessExecution(
  platform = "win32",
  {
    spawnImplementation = spawn,
    spawnSyncImplementation = spawnSync,
    environment = process.env,
  } = {}
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
    spawnOwnedDetached(executable, argumentsList = [], options = {}) {
      if (!isAbsoluteWindowsPath(executable)) throw new TypeError("An absolute owned process executable is required.");
      return spawnImplementation(executable, argumentsList.map(String), {
        ...options,
        shell: false,
        detached: true,
        windowsHide: true,
      });
    },
    spawnOwnedChild(executable, argumentsList = [], options = {}) {
      if (!isAbsoluteWindowsPath(executable)) throw new TypeError("An absolute owned process executable is required.");
      return spawnImplementation(executable, argumentsList.map(String), {
        ...options,
        shell: false,
        detached: false,
        windowsHide: true,
      });
    },
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
    terminateOwnedDetachedProcess(pid) {
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
        throw new Error(`Unable to terminate owned detached Windows process tree: ${pid}.`);
      }
    },
    sameExecutablePath(left, right) {
      return path.win32.normalize(path.win32.resolve(left)).toLowerCase() ===
        path.win32.normalize(path.win32.resolve(right)).toLowerCase();
    },
  });
}
