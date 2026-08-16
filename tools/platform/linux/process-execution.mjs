import path from "node:path";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";

export function createLinuxOperatorProcessExecution(
  platform = "linux",
  { killImplementation = process.kill, environment = process.env } = {}
) {
  const descriptor = Object.freeze({
    id: "process-execution",
    role: "operator",
    platform,
    state: "READY",
    ownerStage: "PR-04",
  });
  return Object.freeze({
    descriptor,
    childEnvironment(input = {}) {
      const source = input.source ?? environment;
      return createChildProcessEnvironment({
        ...input,
        source,
        policy: createLinuxChildProcessPolicy(source),
      });
    },
    terminateOwnedProcess(pid) {
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new TypeError("A positive owned process id is required.");
      }
      killImplementation(pid);
    },
    sameExecutablePath(left, right) {
      return path.posix.normalize(path.posix.resolve(left)) ===
        path.posix.normalize(path.posix.resolve(right));
    },
  });
}
