import path from "node:path";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { POSTGRESQL_TOOL_CAPABILITIES } from "../../../quickhack_shared/platform/native-runtime-contract.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";
import type {
  PostgresqlToolKey,
  ServerProcessExecution,
} from "../contracts.ts";

const POSTGRESQL_TOOL_KEYS = new Set(
  POSTGRESQL_TOOL_CAPABILITIES.package as readonly string[]
);

function postgresqlTool(tool: PostgresqlToolKey) {
  if (!POSTGRESQL_TOOL_KEYS.has(tool)) {
    throw new TypeError(`Unsupported PostgreSQL executable key: ${tool}.`);
  }
  return tool;
}

export const linuxServerProcessExecution: ServerProcessExecution = Object.freeze({
  descriptor: Object.freeze({
    id: "process-execution",
    role: "server",
    platform: "linux",
    state: "READY",
    ownerStage: "PR-04",
  }),
  postgresqlBinDirectories(input) {
    if (
      input.deployment === "system-service" ||
      String(input.environment?.QUICKHACK_PACKAGE_MANIFEST ?? "").trim()
    ) {
      return Object.freeze(["/usr/bin"]);
    }
    return Object.freeze([
      path.posix.join(input.appRoot, "runtime", "postgresql", "bin"),
      path.posix.join(input.appRoot, "..", "runtime", "postgresql", "bin"),
      path.posix.join(path.posix.dirname(input.nodeExecutable), "..", "postgresql", "bin"),
      `/usr/lib/postgresql/${input.majorVersion}/bin`,
      "/usr/bin",
    ].map((candidate) => path.posix.resolve(candidate)));
  },
  postgresqlExecutable(binDirectory, tool) {
    return path.posix.join(
      path.posix.resolve(binDirectory),
      postgresqlTool(tool)
    );
  },
  childEnvironment(input = {}) {
    const source = input.source ?? {};
    return createChildProcessEnvironment({
      ...input,
      source,
      policy: createLinuxChildProcessPolicy(source),
    });
  },
});
