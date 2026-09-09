import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import {
  dependencyInvalid,
  dependencyMissing,
} from "../../../quickhack_shared/platform/platform-capability-error.mjs";
import {
  createLinuxChildProcessPolicy,
  resolveLinuxSystemExecutable,
} from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";
import type {
  ClientNativeExecutionContext,
  PrinterBackend,
  PrinterQueue,
  PrinterSubmitRequest,
  PrinterSubmitResult,
} from "../contracts.ts";

const execFileAsync = promisify(execFileCallback);
const PROCESS_TIMEOUT_MS = 15_000;
const PROCESS_MAX_BUFFER = 1024 * 1024;
const QUEUE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;

type ExecuteFile = (
  executable: string,
  args: readonly string[],
  options: Record<string, unknown>
) => Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>;

type BackendDependencies = Readonly<{
  executeFile?: ExecuteFile;
  lstatFile?: typeof lstat;
  accessFile?: typeof access;
}>;

function errorField(error: unknown, field: string) {
  return typeof error === "object" && error !== null && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function errorCode(error: unknown) {
  return String(errorField(error, "code") ?? "");
}

function absoluteLinuxPath(value: string, field: string) {
  const source = String(value ?? "").trim();
  if (!path.posix.isAbsolute(source) || source.split("/").includes("..")) {
    throw new TypeError(`${field} must be an absolute Linux path.`);
  }
  return path.posix.normalize(source);
}

function minimalEnvironment(context: ClientNativeExecutionContext) {
  return createChildProcessEnvironment({
    policy: createLinuxChildProcessPolicy(context.environment ?? {}),
    source: context.environment ?? {},
    overrides: { LC_ALL: "C", LANG: "C" },
  });
}

async function assertExecutable(
  executable: string,
  inspectFile: typeof lstat,
  checkAccess: typeof access
) {
  try {
    const state = await inspectFile(executable);
    if (!state.isFile() || state.isSymbolicLink()) {
      throw dependencyInvalid({
        role: "client",
        capability: "printer-backend",
        platform: "linux",
        dependency: "cups-client",
        recovery: "Repair the Linux CUPS client tools.",
        message: "DEPENDENCY_INVALID",
      });
    }
    await checkAccess(executable, constants.X_OK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "DEPENDENCY_INVALID") {
      throw error;
    }
    if (["ENOENT", "ENOTDIR"].includes(errorCode(error))) {
      throw dependencyMissing({
        role: "client",
        capability: "printer-backend",
        platform: "linux",
        dependency: "cups-client",
        recovery: "Install the CUPS client tools before using label printing.",
        message: "DEPENDENCY_MISSING",
      });
    }
    throw dependencyInvalid({
      role: "client",
      capability: "printer-backend",
      platform: "linux",
      dependency: "cups-client",
      recovery: "Repair the Linux CUPS client tools and permissions.",
      message: "DEPENDENCY_INVALID",
    });
  }
}

function parseQueues(value: string | Buffer | undefined) {
  const lines = String(value ?? "").split(/\r?\n/u);
  const defaultLine = lines.find((line) => /^system default destination:\s*/iu.test(line));
  const defaultName = defaultLine?.replace(/^system default destination:\s*/iu, "").trim() ?? "";
  const queues: PrinterQueue[] = [];
  for (const line of lines) {
    const match = /^printer\s+(\S+)\s+(.+)$/iu.exec(line.trim());
    if (!match || !QUEUE_NAME_PATTERN.test(match[1])) continue;
    const description = match[2].toLowerCase();
    const disabled = description.includes("disabled");
    queues.push(
      Object.freeze({
        name: match[1],
        isDefault: match[1] === defaultName,
        isOffline: disabled,
        status: disabled ? "OFFLINE" : description.includes("idle") ? "IDLE" : "UNKNOWN",
      })
    );
  }
  return Object.freeze(
    [...new Map(queues.map((queue) => [queue.name, queue])).values()]
  );
}

function result(
  status: PrinterSubmitResult["status"],
  requestedBytes: number,
  input: Readonly<{
    writtenBytes?: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    nativeJobId?: string | null;
  }> = {}
): PrinterSubmitResult {
  return Object.freeze({
    status,
    requestedBytes,
    writtenBytes: input.writtenBytes ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    nativeJobId: input.nativeJobId ?? null,
  });
}

async function assertSpoolFile(
  input: PrinterSubmitRequest,
  inspectFile: typeof lstat
) {
  const spoolPath = absoluteLinuxPath(input.spoolPath, "spoolPath");
  const state = await inspectFile(spoolPath);
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.size !== input.requestedBytes
  ) {
    throw new TypeError("The private print spool file is invalid.");
  }
  return spoolPath;
}

export function createLinuxPrinterBackend(
  dependencies: BackendDependencies = {}
): PrinterBackend {
  const executeFile = dependencies.executeFile ?? (execFileAsync as ExecuteFile);
  const inspectFile = dependencies.lstatFile ?? lstat;
  const checkAccess = dependencies.accessFile ?? access;

  const backend: PrinterBackend = Object.freeze({
    descriptor: Object.freeze({
      id: "printer-backend",
      role: "client",
      platform: "linux",
      state: "READY",
      ownerStage: "PR-07",
    }),
    async list(context) {
      const executable = resolveLinuxSystemExecutable("lpstat");
      await assertExecutable(executable, inspectFile, checkAccess);
      try {
        const commandResult = await executeFile(executable, ["-p", "-d"], {
          cwd: absoluteLinuxPath(context.appRoot, "appRoot"),
          encoding: "utf8",
          timeout: PROCESS_TIMEOUT_MS,
          maxBuffer: PROCESS_MAX_BUFFER,
          env: minimalEnvironment(context),
        });
        return parseQueues(commandResult.stdout);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          throw dependencyMissing({
            role: "client",
            capability: "printer-backend",
            platform: "linux",
            dependency: "cups-client",
            recovery: "Install the CUPS client tools before using label printing.",
            message: "DEPENDENCY_MISSING",
          });
        }
        const listError = new Error("The Linux printer queue list could not be read.");
        Object.assign(listError, { code: "PRINTER_LIST_FAILED" });
        throw listError;
      }
    },
    async submit(input) {
      if (!Number.isSafeInteger(input.requestedBytes) || input.requestedBytes <= 0) {
        return result("FAILED", 0, {
          errorCode: "INVALID_PRINT_REQUEST",
          errorMessage: "The print byte count is invalid.",
        });
      }
      const printerName = String(input.printerName ?? "").trim();
      if (!QUEUE_NAME_PATTERN.test(printerName)) {
        return result("FAILED", input.requestedBytes, {
          errorCode: "INVALID_PRINTER_NAME",
          errorMessage: "The selected printer queue is invalid.",
        });
      }

      const executable = resolveLinuxSystemExecutable("lp");
      let spoolPath: string;
      try {
        const queues = await backend.list(input);
        if (!queues.some((queue) => queue.name === printerName)) {
          return result("FAILED", input.requestedBytes, {
            errorCode: "PRINTER_QUEUE_NOT_FOUND",
            errorMessage: "The selected printer queue is not available.",
          });
        }
        await assertExecutable(executable, inspectFile, checkAccess);
        spoolPath = await assertSpoolFile(input, inspectFile);
      } catch (error) {
        return result("FAILED", input.requestedBytes, {
          errorCode: errorCode(error) || "PRINTER_VALIDATION_FAILED",
          errorMessage:
            error instanceof Error
              ? error.message
              : "The printer request could not be validated.",
        });
      }

      try {
        const commandResult = await executeFile(
          executable,
          ["-d", printerName, "-o", "raw", spoolPath],
          {
            cwd: absoluteLinuxPath(input.appRoot, "appRoot"),
            encoding: "utf8",
            timeout: PROCESS_TIMEOUT_MS,
            maxBuffer: PROCESS_MAX_BUFFER,
            env: minimalEnvironment(input),
          }
        );
        const acceptance = /request id is\s+(\S+)/iu.exec(
          String(commandResult.stdout ?? "").slice(0, PROCESS_MAX_BUFFER)
        );
        const nativeJobId = acceptance?.[1]?.slice(0, 256) ?? "";
        if (!nativeJobId || /[\0\r\n]/u.test(nativeJobId)) {
          return result("UNKNOWN", input.requestedBytes, {
            errorCode: "PRINTER_ACCEPTANCE_UNKNOWN",
            errorMessage:
              "The Linux spooler response could not be verified; automatic retry is blocked.",
          });
        }
        return result("SPOOLED", input.requestedBytes, {
          writtenBytes: input.requestedBytes,
          nativeJobId,
        });
      } catch (error) {
        const code = errorCode(error);
        const signal = String(errorField(error, "signal") ?? "");
        const killed = errorField(error, "killed") === true;
        if (code === "ENOENT") {
          return result("FAILED", input.requestedBytes, {
            errorCode: "DEPENDENCY_MISSING",
            errorMessage: "The Linux print submit utility is missing.",
          });
        }
        if (/^-?\d+$/u.test(code)) {
          return result("FAILED", input.requestedBytes, {
            errorCode: "LINUX_SPOOL_REJECTED",
            errorMessage: "The Linux spooler rejected the RAW print request.",
          });
        }
        return result("UNKNOWN", input.requestedBytes, {
          errorCode:
            killed || code === "ETIMEDOUT"
              ? "PRINTER_SUBMIT_TIMEOUT"
              : signal
                ? "PRINTER_SUBMIT_SIGNALLED"
                : "PRINTER_ACCEPTANCE_UNKNOWN",
          errorMessage:
            "The Linux spooler may have received the print request; automatic retry is blocked.",
        });
      }
    },
    async secureSpoolDirectory() {
      // POSIX mode enforcement remains in the common spool core.
    },
  });
  return backend;
}

export const linuxPrinterBackend = createLinuxPrinterBackend();
