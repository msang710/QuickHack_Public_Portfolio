import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import {
  dependencyInvalid,
  dependencyMissing,
} from "../../../quickhack_shared/platform/platform-capability-error.mjs";
import {
  createWindowsChildProcessPolicy,
  windowsSystemPaths,
} from "../../../quickhack_shared/platform/windows/child-process-policy.mjs";
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

type ExecuteFile = (
  executable: string,
  args: readonly string[],
  options: Record<string, unknown>
) => Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>;

type BackendDependencies = Readonly<{
  executeFile?: ExecuteFile;
  lstatFile?: typeof lstat;
}>;

function errorField(error: unknown, field: string) {
  return typeof error === "object" && error !== null && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function errorCode(error: unknown) {
  return String(errorField(error, "code") ?? "");
}

function absoluteWindowsPath(value: string, field: string) {
  const source = String(value ?? "").trim();
  if (!path.win32.isAbsolute(source) || source.split(/[\\/]+/u).includes("..")) {
    throw new TypeError(`${field} must be an absolute Windows path.`);
  }
  return path.win32.normalize(source);
}

function parseJsonOutput(value: string | Buffer | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

function printerQueue(value: unknown): PrinterQueue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const name = String(source.name ?? "").trim();
  if (!name || name.length > 256 || /[\0\r\n]/u.test(name)) return null;
  return Object.freeze({
    name,
    isDefault: source.isDefault === true,
    isOffline: source.isOffline === true,
    status: String(source.status ?? "UNKNOWN").trim().slice(0, 64) || "UNKNOWN",
  });
}

function failed(
  requestedBytes: number,
  errorCodeValue: string,
  errorMessage: string
): PrinterSubmitResult {
  return Object.freeze({
    status: "FAILED",
    requestedBytes,
    writtenBytes: null,
    errorCode: errorCodeValue,
    errorMessage,
    nativeJobId: null,
  });
}

function unknown(
  requestedBytes: number,
  errorCodeValue: string,
  errorMessage: string,
  writtenBytes: number | null = null
): PrinterSubmitResult {
  return Object.freeze({
    status: "UNKNOWN",
    requestedBytes,
    writtenBytes,
    errorCode: errorCodeValue,
    errorMessage,
    nativeJobId: null,
  });
}

function minimalEnvironment(context: ClientNativeExecutionContext) {
  return createChildProcessEnvironment({
    policy: createWindowsChildProcessPolicy(context.environment ?? {}),
    source: context.environment ?? {},
  });
}

async function bridgePath(
  context: ClientNativeExecutionContext,
  inspectFile: typeof lstat
) {
  const appRoot = absoluteWindowsPath(context.appRoot, "appRoot");
  const runtimeDir = absoluteWindowsPath(context.runtimeDir, "runtimeDir");
  const candidates = [
    path.win32.join(runtimeDir, "printer", "quickhack-raw-print.ps1"),
    path.win32.join(appRoot, "tools", "quickhack-raw-print.ps1"),
  ];
  let invalidCandidateObserved = false;
  for (const candidate of candidates) {
    try {
      const state = await inspectFile(candidate);
      if (state.isFile() && !state.isSymbolicLink()) return candidate;
      invalidCandidateObserved = true;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) {
        invalidCandidateObserved = true;
      }
    }
  }
  if (invalidCandidateObserved) {
    throw dependencyInvalid({
      role: "client",
      capability: "printer-backend",
      platform: "win32",
      dependency: "quickhack-raw-print",
      recovery: "Repair the QuickHack client printer runtime.",
          message: "DEPENDENCY_INVALID",
    });
  }
  throw dependencyMissing({
    role: "client",
    capability: "printer-backend",
    platform: "win32",
    dependency: "quickhack-raw-print",
    recovery: "Repair the QuickHack client printer runtime.",
        message: "DEPENDENCY_MISSING",
  });
}

async function assertSpoolFile(
  input: PrinterSubmitRequest,
  inspectFile: typeof lstat
) {
  const spoolPath = absoluteWindowsPath(input.spoolPath, "spoolPath");
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

export function createWindowsPrinterBackend(
  dependencies: BackendDependencies = {}
): PrinterBackend {
  const executeFile = dependencies.executeFile ?? (execFileAsync as ExecuteFile);
  const inspectFile = dependencies.lstatFile ?? lstat;

  const backend: PrinterBackend = Object.freeze({
    descriptor: Object.freeze({
      id: "printer-backend",
      role: "client",
      platform: "win32",
      state: "READY",
      ownerStage: "PR-07",
    }),
    async list(context) {
      const script = await bridgePath(context, inspectFile);
      try {
        const result = await executeFile(
          windowsSystemPaths(context.environment ?? {}).powerShell,
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            "-Action",
            "List",
          ],
          {
            cwd: absoluteWindowsPath(context.appRoot, "appRoot"),
            encoding: "utf8",
            timeout: PROCESS_TIMEOUT_MS,
            maxBuffer: PROCESS_MAX_BUFFER,
            windowsHide: true,
            env: minimalEnvironment(context),
          }
        );
        const parsed = parseJsonOutput(result.stdout);
        const values = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        const queues = values.map(printerQueue).filter((value): value is PrinterQueue => value !== null);
        return Object.freeze(
          [...new Map(queues.map((queue) => [queue.name, queue])).values()]
        );
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          throw dependencyMissing({
            role: "client",
            capability: "printer-backend",
            platform: "win32",
            dependency: "powershell",
            recovery: "Repair the Windows system PowerShell installation.",
          message: "DEPENDENCY_MISSING",
          });
        }
        const listError = new Error("The Windows printer queue list could not be read.");
        Object.assign(listError, { code: "PRINTER_LIST_FAILED" });
        throw listError;
      }
    },
    async submit(input) {
      if (!Number.isSafeInteger(input.requestedBytes) || input.requestedBytes <= 0) {
        return failed(0, "INVALID_PRINT_REQUEST", "The print byte count is invalid.");
      }
      const printerName = String(input.printerName ?? "").trim();
      if (!printerName || printerName.length > 256 || /[\0\r\n]/u.test(printerName)) {
        return failed(
          input.requestedBytes,
          "INVALID_PRINTER_NAME",
          "The selected printer queue is invalid."
        );
      }

      let script: string;
      let spoolPath: string;
      try {
        const queues = await backend.list(input);
        if (!queues.some((queue) => queue.name === printerName)) {
          return failed(
            input.requestedBytes,
            "PRINTER_QUEUE_NOT_FOUND",
            "The selected printer queue is not available."
          );
        }
        script = await bridgePath(input, inspectFile);
        spoolPath = await assertSpoolFile(input, inspectFile);
      } catch (error) {
        return failed(
          input.requestedBytes,
          errorCode(error) || "PRINTER_VALIDATION_FAILED",
          error instanceof Error
            ? error.message
            : "The printer request could not be validated."
        );
      }

      try {
        const result = await executeFile(
          windowsSystemPaths(input.environment ?? {}).powerShell,
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            "-Action",
            "Print",
            "-PrinterName",
            printerName,
            "-InputPath",
            spoolPath,
          ],
          {
            cwd: absoluteWindowsPath(input.appRoot, "appRoot"),
            encoding: "utf8",
            timeout: PROCESS_TIMEOUT_MS,
            maxBuffer: PROCESS_MAX_BUFFER,
            windowsHide: true,
            env: minimalEnvironment(input),
          }
        );
        let parsed: Record<string, unknown>;
        try {
          const value = parseJsonOutput(result.stdout);
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return unknown(
              input.requestedBytes,
              "PRINTER_ACCEPTANCE_UNKNOWN",
              "The Windows spooler response could not be verified."
            );
          }
          parsed = value as Record<string, unknown>;
        } catch {
          return unknown(
            input.requestedBytes,
            "PRINTER_ACCEPTANCE_UNKNOWN",
            "The Windows spooler response could not be verified."
          );
        }
        const requestedBytes = Number(parsed.requestedBytes);
        const writtenBytes = Number(parsed.writtenBytes);
        if (
          parsed.ok !== true ||
          requestedBytes !== input.requestedBytes ||
          writtenBytes !== input.requestedBytes
        ) {
          return failed(
            input.requestedBytes,
            "PARTIAL_SPOOL_WRITE",
            "The Windows spooler did not accept the complete RAW payload."
          );
        }
        return Object.freeze({
          status: "SPOOLED",
          requestedBytes: input.requestedBytes,
          writtenBytes,
          errorCode: null,
          errorMessage: null,
          nativeJobId: null,
        });
      } catch (error) {
        const code = errorCode(error);
        const signal = String(errorField(error, "signal") ?? "");
        const killed = errorField(error, "killed") === true;
        if (code === "ENOENT") {
          return failed(
            input.requestedBytes,
            "DEPENDENCY_MISSING",
            "The Windows printer process dependency is missing."
          );
        }
        if (/^-?\d+$/u.test(code)) {
          return failed(
            input.requestedBytes,
            "WINDOWS_SPOOL_REJECTED",
            "The Windows spooler rejected the RAW print request."
          );
        }
        return unknown(
          input.requestedBytes,
          killed || code === "ETIMEDOUT"
            ? "PRINTER_SUBMIT_TIMEOUT"
            : signal
              ? "PRINTER_SUBMIT_SIGNALLED"
              : "PRINTER_ACCEPTANCE_UNKNOWN",
          "The Windows spooler may have received the print request; automatic retry is blocked."
        );
      }
    },
    async secureSpoolDirectory(input) {
      const directory = absoluteWindowsPath(input.directory, "directory");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$target = $env:QUICKHACK_PRINT_SPOOL_ACL_DIR",
        "$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
        "$propagation = [System.Security.AccessControl.PropagationFlags]::None",
        "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
        "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl",
        "$security = [System.Security.AccessControl.DirectorySecurity]::new()",
        "$security.SetAccessRuleProtection($true, $false)",
        "$identities = @(",
        "  [System.Security.Principal.WindowsIdentity]::GetCurrent().User,",
        "  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),",
        "  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')",
        ")",
        "foreach ($identity in $identities) {",
        "  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inheritance, $propagation, $allow)",
        "  [void]$security.AddAccessRule($rule)",
        "}",
        "Set-Acl -LiteralPath $target -AclObject $security",
      ].join("\n");
      await executeFile(
        windowsSystemPaths(input.environment ?? {}).powerShell,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          cwd: absoluteWindowsPath(input.appRoot, "appRoot"),
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: PROCESS_MAX_BUFFER,
          windowsHide: true,
          env: createChildProcessEnvironment({
            policy: createWindowsChildProcessPolicy(input.environment ?? {}),
            source: input.environment ?? {},
            overrides: { QUICKHACK_PRINT_SPOOL_ACL_DIR: directory },
          }),
        }
      );
    },
  });
  return backend;
}

export const windowsPrinterBackend = createWindowsPrinterBackend();
