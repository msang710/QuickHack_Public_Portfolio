import { runPowerShellScript } from "../../../quickhack_server/security/async-powershell.mjs";
import {
  assertServiceKind,
  assertServiceOperation,
  serviceLifecycleSnapshot,
  serviceOperationResult,
} from "../../../quickhack_shared/platform/service-lifecycle-contract.mjs";

const SERVICE_NAMES = Object.freeze({
  POSTGRESQL: "QuickHackPostgreSQL",
  APPLICATION: "QuickHackServerConsole",
});

function parseJson(source) {
  try {
    return JSON.parse(String(source ?? "").trim());
  } catch {
    return null;
  }
}

function stateFromWindows(value) {
  switch (String(value ?? "").toLowerCase()) {
    case "running": return "ACTIVE";
    case "stopped": return "INACTIVE";
    case "start pending": return "ACTIVATING";
    case "stop pending": return "DEACTIVATING";
    default: return "UNKNOWN";
  }
}

export function createWindowsServiceProcess(options = {}) {
  const run = options.run ?? runPowerShellScript;

  async function status(serviceKindValue) {
    const serviceKind = assertServiceKind(serviceKindValue);
    const serviceName = SERVICE_NAMES[serviceKind];
    const source = await run(
      `$service=Get-CimInstance Win32_Service -Filter "Name='${serviceName}'" -ErrorAction SilentlyContinue; ` +
        "if($null -eq $service){'{\"missing\":true}'}else{[pscustomobject]@{missing=$false;state=$service.State;startMode=$service.StartMode;processId=$service.ProcessId;exitCode=$service.ExitCode}|ConvertTo-Json -Compress}",
      { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 }
    );
    const observed = parseJson(source);
    if (observed?.missing === true) {
      return serviceLifecycleSnapshot({ serviceKind, state: "MISSING" });
    }
    const state = stateFromWindows(observed?.state);
    return serviceLifecycleSnapshot({
      serviceKind,
      state,
      installed: observed ? true : null,
      enabled: observed ? String(observed.startMode).toLowerCase() === "auto" : null,
      mainPid: observed?.processId,
      result: observed?.exitCode === 0 ? "success" : `exit-${Number(observed?.exitCode) || 0}`,
      subState: observed?.state,
      recovery: state === "UNKNOWN" ? { code: "SERVICE_RECOVERY_REQUIRED", message: "Inspect the Windows service state." } : undefined,
    });
  }

  async function operate(operationValue, serviceKindValue) {
    const operation = assertServiceOperation(operationValue);
    const serviceKind = assertServiceKind(serviceKindValue);
    if (["INSTALL", "REPAIR"].includes(operation)) {
      const error = new Error("The service installer owns this operation.");
      error.code = "SERVICE_OPERATION_UNAVAILABLE";
      throw error;
    }
    if (operation !== "STATUS") {
      const serviceName = SERVICE_NAMES[serviceKind];
      const command = operation === "RESTART"
        ? `Restart-Service -Name '${serviceName}' -ErrorAction Stop`
        : `${operation === "START" ? "Start" : "Stop"}-Service -Name '${serviceName}' -ErrorAction Stop`;
      await run(`$ErrorActionPreference='Stop'; ${command}; 'OK'`, {
        timeoutMs: 130_000,
        maxOutputBytes: 64 * 1024,
      });
    }
    return serviceOperationResult({
      operation,
      changed: operation !== "STATUS",
      snapshot: await status(serviceKind),
    });
  }

  return Object.freeze({ serviceNames: SERVICE_NAMES, status, operate });
}
