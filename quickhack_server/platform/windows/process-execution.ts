import path from "node:path";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { POSTGRESQL_TOOL_CAPABILITIES } from "../../../quickhack_shared/platform/native-runtime-contract.mjs";
import { createWindowsChildProcessPolicy } from "../../../quickhack_shared/platform/windows/child-process-policy.mjs";
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

export const windowsServerProcessExecution: ServerProcessExecution = Object.freeze({
  descriptor: Object.freeze({
    id: "process-execution",
    role: "server",
    platform: "win32",
    state: "READY",
    ownerStage: "PR-04",
  }),
  postgresqlBinDirectories(input) {
    const programFiles = String(
      input.environment?.ProgramFiles ??
        input.environment?.PROGRAMFILES ??
        "C:\\Program Files"
    ).trim();
    return Object.freeze([
      path.win32.join(input.appRoot, "runtime", "postgresql", "bin"),
      path.win32.join(input.appRoot, "..", "runtime", "postgresql", "bin"),
      path.win32.join(path.win32.dirname(input.nodeExecutable), "..", "postgresql", "bin"),
      path.win32.join(programFiles, "PostgreSQL", String(input.majorVersion), "bin"),
    ].map((candidate) => path.win32.resolve(candidate)));
  },
  postgresqlExecutable(binDirectory, tool) {
    return path.win32.join(
      path.win32.resolve(binDirectory),
      `${postgresqlTool(tool)}.exe`
    );
  },
  childEnvironment(input = {}) {
    const source = input.source ?? {};
    return createChildProcessEnvironment({
      ...input,
      source,
      policy: createWindowsChildProcessPolicy(source),
    });
  },
});
