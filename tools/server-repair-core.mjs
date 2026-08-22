export const SERVER_REPAIR_DISPOSITIONS = Object.freeze([
  "READY",
  "PACKAGE_REINSTALL_REQUIRED",
  "PRODUCT_REPAIR_AVAILABLE",
  "DATABASE_RESTORE_REQUIRED",
  "STATE_SCHEMA_INCOMPATIBLE",
]);

function result(disposition, code, mutableStateMutationAllowed, logDirectory) {
  return Object.freeze({ disposition, code, mutableStateMutationAllowed, logDirectory });
}

export function classifyServerRepair(input) {
  const logDirectory = String(input?.logDirectory ?? "");
  const packageState = input?.package ?? {};
  const state = input?.state ?? {};
  const database = input?.database ?? {};

  if (state.legacyMode === "INSTALLED_INNO") {
    return result("STATE_SCHEMA_INCOMPATIBLE", "LEGACY_INSTALL_MIGRATION_REQUIRED", false, logDirectory);
  }

  if (
    packageState.registered !== true ||
    packageState.identityMatches !== true ||
    packageState.manifestMatches !== true ||
    packageState.requiredFilesRegular !== true ||
    packageState.contentVerified !== true
  ) {
    return result("PACKAGE_REINSTALL_REQUIRED", "RUNTIME_INTEGRITY_FAILED", false, logDirectory);
  }
  if (state.reparsePoint === true) {
    return result("STATE_SCHEMA_INCOMPATIBLE", "STATE_ROOT_AMBIGUOUS", false, logDirectory);
  }
  if (
    state.runtimeConfig === "INCOMPATIBLE" ||
    database.schema === "INCOMPATIBLE"
  ) {
    return result("STATE_SCHEMA_INCOMPATIBLE", "STATE_SCHEMA_INCOMPATIBLE", false, logDirectory);
  }
  if (
    database.integrity === "FAILED" ||
    database.credentials === "UNREADABLE"
  ) {
    return result("DATABASE_RESTORE_REQUIRED", "DATABASE_RESTORE_REQUIRED", false, logDirectory);
  }
  if (
    state.exists !== true ||
    state.runtimeConfig !== "MATCH" ||
    state.acl !== "READY" ||
    state.services !== "READY" ||
    state.firewall !== "READY" ||
    database.schema === "MIGRATABLE" ||
    database.credentials === "MISSING" ||
    database.integrity === "UNKNOWN"
  ) {
    return result("PRODUCT_REPAIR_AVAILABLE", "PRODUCT_REPAIR_REQUIRED", true, logDirectory);
  }
  return result("READY", "SERVER_REPAIR_NOT_REQUIRED", false, logDirectory);
}

function stableErrorCode(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{2,95}$/u.test(code) ? code : "PRODUCT_REPAIR_FAILED";
}

function failedRepairDisposition(error, logDirectory) {
  const code = stableErrorCode(error);
  if (/SCHEMA|MIGRAT|DATABASE|POSTGRES|CREDENTIAL/u.test(code)) {
    return result("DATABASE_RESTORE_REQUIRED", code, false, logDirectory);
  }
  return result("PRODUCT_REPAIR_AVAILABLE", code, true, logDirectory);
}

export function createServerRepairCore(input) {
  if (typeof input?.diagnose !== "function" || typeof input?.repair !== "function") {
    throw new TypeError("Server repair core requires diagnose() and repair().");
  }

  async function diagnose() {
    return classifyServerRepair(await input.diagnose());
  }

  async function run() {
    const before = await diagnose();
    if (before.disposition !== "PRODUCT_REPAIR_AVAILABLE") return before;
    try {
      await input.repair();
    } catch (error) {
      return failedRepairDisposition(error, before.logDirectory);
    }
    const after = await diagnose();
    return after.disposition === "READY"
      ? after
      : result(after.disposition, "PRODUCT_REPAIR_POSTCONDITION_FAILED", false, after.logDirectory);
  }

  return Object.freeze({ diagnose, run });
}
