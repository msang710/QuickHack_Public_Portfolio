import { execFile } from "node:child_process";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";
import {
  assertServiceKind,
  assertServiceOperation,
  serviceLifecycleSnapshot,
  serviceOperationResult,
} from "../../../quickhack_shared/platform/service-lifecycle-contract.mjs";

export const SYSTEMCTL_EXECUTABLE = "/usr/bin/systemctl";
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const SHOW_PROPERTIES = Object.freeze([
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "MainPID",
  "Result",
]);

export class SystemdServiceProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SystemdServiceProcessError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SystemdServiceProcessError(code, message);
}

function strictUnitName(value) {
  const unit = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9@_.-]{0,126}\.service$/u.test(unit)) {
    fail("SERVICE_UNIT_INVALID", "The configured systemd service unit is invalid.");
  }
  return unit;
}

function defaultRun(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      SYSTEMCTL_EXECUTABLE,
      args,
      {
        shell: false,
        windowsHide: true,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: createChildProcessEnvironment({
          policy: createLinuxChildProcessPolicy(process.env),
          source: process.env,
          executableDirectories: ["/usr/bin"],
          overrides: { LANG: "C", LC_ALL: "C" },
        }),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new SystemdServiceProcessError(
              error.killed ? "SERVICE_OPERATION_TIMEOUT" : "SERVICE_OPERATION_FAILED",
              `systemd service operation failed (${String(error.code ?? "unknown")}).`
            )
          );
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

function parseShow(source) {
  const values = Object.create(null);
  for (const line of String(source ?? "").split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (SHOW_PROPERTIES.includes(key)) values[key] = line.slice(separator + 1);
  }
  return values;
}

function normalizedState(values) {
  if (values.LoadState === "not-found") return "MISSING";
  switch (values.ActiveState) {
    case "active": return "ACTIVE";
    case "inactive": return "INACTIVE";
    case "activating": return "ACTIVATING";
    case "deactivating": return "DEACTIVATING";
    case "failed": return "FAILED";
    default: return "UNKNOWN";
  }
}

function enabledState(value) {
  if (["enabled", "enabled-runtime", "linked", "linked-runtime"].includes(value)) return true;
  if (["disabled", "masked", "masked-runtime", "static", "indirect"].includes(value)) return false;
  return null;
}

export function createSystemdServiceProcess(options = {}) {
  const run = options.run ?? defaultRun;
  const units = Object.freeze({
    POSTGRESQL: strictUnitName(options.units?.POSTGRESQL ?? "quickhack-postgresql.service"),
    APPLICATION: strictUnitName(options.units?.APPLICATION ?? "quickhack-console.service"),
  });

  async function status(serviceKindValue) {
    const serviceKind = assertServiceKind(serviceKindValue);
    const unit = units[serviceKind];
    const result = await run([
      "show",
      unit,
      "--no-pager",
      `--property=${SHOW_PROPERTIES.join(",")}`,
    ]);
    const values = parseShow(result.stdout);
    const state = normalizedState(values);
    return serviceLifecycleSnapshot({
      serviceKind,
      state,
      installed: state !== "MISSING",
      enabled: enabledState(values.UnitFileState),
      mainPid: values.MainPID,
      result: values.Result,
      subState: values.SubState,
      recovery:
        state === "FAILED" || state === "UNKNOWN"
          ? { code: "SERVICE_RECOVERY_REQUIRED", message: "Inspect the QuickHack service journal." }
          : undefined,
    });
  }

  async function operate(operationValue, serviceKindValue) {
    const operation = assertServiceOperation(operationValue);
    const serviceKind = assertServiceKind(serviceKindValue);
    if (["INSTALL", "REPAIR"].includes(operation)) {
      fail("SERVICE_OPERATION_UNAVAILABLE", "Package installation owns this service operation.");
    }
    if (operation !== "STATUS") {
      await run([operation.toLowerCase(), units[serviceKind], "--no-block"]);
    }
    return serviceOperationResult({
      operation,
      changed: operation !== "STATUS",
      snapshot: await status(serviceKind),
    });
  }

  return Object.freeze({ executable: SYSTEMCTL_EXECUTABLE, units, status, operate });
}
