import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdbExecutableResolver,
  ClientNativeExecutionContext,
} from "../platform/contracts.ts";

const execFileAsync = promisify(execFileCallback);
const ADB_MAX_BUFFER = 1024 * 1024;

type ExecuteFile = (
  executable: string,
  args: readonly string[],
  options: Record<string, unknown>
) => Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>;

export class AdbCommandExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AdbCommandExecutionError";
    this.code = code;
  }
}

function output(value: string | Buffer | undefined) {
  return String(value ?? "").trim().slice(0, ADB_MAX_BUFFER);
}

function errorField(error: unknown, field: string) {
  return typeof error === "object" && error !== null && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function errorCode(error: unknown) {
  return String(errorField(error, "code") ?? "");
}

export function createAdbCommandRunner(
  dependencies: Readonly<{ executeFile?: ExecuteFile }> = {}
) {
  const executeFile = dependencies.executeFile ?? (execFileAsync as ExecuteFile);

  return async function runAdbCommand(input: Readonly<{
    resolver: AdbExecutableResolver;
    context: ClientNativeExecutionContext;
    arguments: readonly string[];
    timeoutMs: number;
    allowFailure?: boolean;
  }>) {
    const plan = await input.resolver.resolve(input.context);
    const minimalEnvironment = plan.environment;
    try {
      const result = await executeFile(plan.executable, input.arguments, {
        cwd: plan.cwd,
        encoding: "utf8",
        timeout: input.timeoutMs,
        maxBuffer: ADB_MAX_BUFFER,
        windowsHide: true,
        env: minimalEnvironment,
      });
      return output(result.stdout);
    } catch (error) {
      const stdout = output(errorField(error, "stdout") as string | Buffer | undefined);
      const stderr = output(errorField(error, "stderr") as string | Buffer | undefined);
      const code = errorCode(error);
      const signal = String(errorField(error, "signal") ?? "");
      const killed = errorField(error, "killed") === true;

      if (input.allowFailure && /^-?\d+$/u.test(code)) {
        return stdout || stderr;
      }
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new AdbCommandExecutionError(
          "ADB_OUTPUT_LIMIT",
          "ADB command output exceeded the safe limit."
        );
      }
      if (code === "ETIMEDOUT" || killed) {
        throw new AdbCommandExecutionError(
          "ADB_TIMEOUT",
          "ADB command timed out."
        );
      }
      if (signal) {
        throw new AdbCommandExecutionError(
          "ADB_SIGNALLED",
          "ADB command ended before completion."
        );
      }
      if (code === "ENOENT") {
        throw new AdbCommandExecutionError(
          "DEPENDENCY_MISSING",
          "The validated ADB executable is no longer available."
        );
      }
      throw new AdbCommandExecutionError(
        "ADB_COMMAND_FAILED",
        "ADB command failed. Check the selected device and try again."
      );
    }
  };
}

export const runAdbCommand = createAdbCommandRunner();
