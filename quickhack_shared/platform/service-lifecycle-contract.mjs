export const SERVICE_KINDS = Object.freeze(["POSTGRESQL", "APPLICATION"]);
export const SERVICE_OPERATIONS = Object.freeze([
  "INSTALL",
  "REPAIR",
  "START",
  "STOP",
  "RESTART",
  "STATUS",
]);
export const SERVICE_STATES = Object.freeze([
  "MISSING",
  "INACTIVE",
  "ACTIVATING",
  "ACTIVE",
  "DEACTIVATING",
  "FAILED",
  "UNKNOWN",
]);

const SERVICE_KIND_SET = new Set(SERVICE_KINDS);
const SERVICE_OPERATION_SET = new Set(SERVICE_OPERATIONS);
const SERVICE_STATE_SET = new Set(SERVICE_STATES);

export class ServiceLifecycleContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ServiceLifecycleContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ServiceLifecycleContractError(code, message);
}

export function assertServiceKind(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!SERVICE_KIND_SET.has(normalized)) {
    fail("SERVICE_TARGET_INVALID", "The QuickHack service target is invalid.");
  }
  return normalized;
}

export function assertServiceOperation(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!SERVICE_OPERATION_SET.has(normalized)) {
    fail("SERVICE_OPERATION_INVALID", "The QuickHack service operation is invalid.");
  }
  return normalized;
}

export function assertServiceState(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!SERVICE_STATE_SET.has(normalized)) return "UNKNOWN";
  return normalized;
}

function finiteText(value, maximumLength = 160) {
  const normalized = String(value ?? "").replace(/[\r\n\0]/gu, " ").trim();
  return normalized.slice(0, maximumLength);
}

export function serviceLifecycleSnapshot(input = {}) {
  const serviceKind = assertServiceKind(input.serviceKind);
  const state = assertServiceState(input.state);
  const mainPid = Number(input.mainPid);
  return Object.freeze({
    serviceKind,
    state,
    installed:
      typeof input.installed === "boolean" ? input.installed : state === "MISSING" ? false : null,
    enabled: typeof input.enabled === "boolean" ? input.enabled : null,
    mainPid: Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : null,
    result: finiteText(input.result),
    subState: finiteText(input.subState),
    recovery: Object.freeze({
      code: finiteText(input.recovery?.code || (state === "FAILED" ? "SERVICE_RECOVERY_REQUIRED" : ""), 80),
      message: finiteText(input.recovery?.message, 240),
    }),
  });
}

export function serviceOperationResult(input = {}) {
  const operation = assertServiceOperation(input.operation);
  return Object.freeze({
    operation,
    changed: Boolean(input.changed),
    snapshot: serviceLifecycleSnapshot(input.snapshot),
  });
}
