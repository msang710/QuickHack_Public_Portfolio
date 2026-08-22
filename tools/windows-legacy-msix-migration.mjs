import { randomUUID } from "node:crypto";

export const WINDOWS_LEGACY_MSIX_MIGRATION_STEPS = Object.freeze([
  Object.freeze({ id: "DISCOVER", state: "DISCOVERY_VALIDATED" }),
  Object.freeze({ id: "SNAPSHOT", state: "SNAPSHOT_RECORDED" }),
  Object.freeze({ id: "STOP_LEGACY_SERVICES", state: "LEGACY_SERVICES_STOPPED" }),
  Object.freeze({ id: "REMOVE_LEGACY_BINARY", state: "LEGACY_BINARY_REMOVED" }),
  Object.freeze({ id: "PROVE_MSIX", state: "MSIX_PROVEN" }),
  Object.freeze({ id: "ATTACH_STATE", state: "STATE_ATTACHED" }),
  Object.freeze({ id: "REPROTECT_CREDENTIALS", state: "CREDENTIALS_REPROTECTED" }),
  Object.freeze({ id: "CONVERGE_PROVISIONING", state: "PROVISIONING_CONVERGED" }),
  Object.freeze({ id: "READY", state: "READY" }),
]);

const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,95}$/u;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredMethod(owner, name) {
  if (typeof owner?.[name] !== "function") {
    throw new TypeError(`Legacy MSIX migration requires ${name}().`);
  }
}

function ready(value) {
  return value === true || value?.ready === true;
}

function normalizeError(error, stepId) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  if (STABLE_CODE.test(code) && code.includes("_") && !code.startsWith("ERR_")) return error;
  return failure(`LEGACY_MIGRATION_${stepId}_FAILED`, `Legacy migration failed at ${stepId}.`);
}

export function createWindowsLegacyMsixMigration(options) {
  const artifactKind = String(options?.artifactKind ?? "").trim().toUpperCase();
  if (!/^(?:DEMONSTRATION|OPERATIONAL)_SERVER$/u.test(artifactKind)) {
    throw failure("LEGACY_INSTALL_TARGET_INVALID", "Legacy migration requires an exact server artifact kind.");
  }
  const adapter = options?.adapter;
  const journal = options?.journal;
  for (const method of ["probe", "mutate", "postcondition"]) requiredMethod(adapter, method);
  for (const method of [
    "initialize",
    "read",
    "setDiscovery",
    "setSnapshot",
    "commitStep",
    "reconcileBefore",
    "recordFailure",
    "withLock",
  ]) requiredMethod(journal, method);
  if (journal.artifactKind !== artifactKind) {
    throw failure("PACKAGE_FLAVOR_MISMATCH", "Migration core and journal artifact kinds differ.");
  }

  async function run(input = {}) {
    const requestedTransactionId = input.transactionId ?? randomUUID();
    return journal.withLock(async () => {
      let record = await journal.initialize(requestedTransactionId);
      const transactionId = record.transactionId;
      const context = { artifactKind, transactionId, input, record, discovery: null, snapshot: null };
      let activeStep = WINDOWS_LEGACY_MSIX_MIGRATION_STEPS[0];
      try {
        for (const step of WINDOWS_LEGACY_MSIX_MIGRATION_STEPS) {
          activeStep = step;
          context.record = record;
          let observed = await adapter.probe(step, context);
          if (step.id === "DISCOVER") {
            const result = observed?.discovery;
            if (result?.classification !== "COMPATIBLE") {
              throw failure(
                result?.reasonCode ?? "LEGACY_INSTALL_AMBIGUOUS",
                "Legacy installation is not safe for automatic migration."
              );
            }
            context.discovery = result;
            if (!record.mode) record = await journal.setDiscovery({
              transactionId,
              mode: result.mode,
              reasonCode: result.reasonCode,
            });
          }
          if (!ready(observed)) {
            if (record.completedSteps.includes(step.id)) {
              record = await journal.reconcileBefore({ transactionId, stepId: step.id });
            }
            const mutation = await adapter.mutate(step, { ...context, record, observed });
            if (step.id === "SNAPSHOT" && mutation?.snapshot) {
              record = await journal.setSnapshot({ transactionId, snapshot: mutation.snapshot });
              context.snapshot = record.snapshot;
            }
            observed = await adapter.postcondition(step, { ...context, record, mutation });
            if (!ready(observed)) {
              throw failure(
                "LEGACY_MIGRATION_POSTCONDITION_FAILED",
                `Legacy migration postcondition failed for ${step.id}.`
              );
            }
          }
          record = await journal.commitStep({ transactionId, stepId: step.id });
        }
        return Object.freeze({
          artifactKind,
          transactionId,
          state: "READY",
          mode: record.mode,
          completedSteps: Object.freeze([...record.completedSteps]),
        });
      } catch (error) {
        const normalized = normalizeError(error, activeStep.id);
        await journal.recordFailure({
          transactionId,
          state: activeStep.state,
          code: normalized.code,
          retryable: ![
            "OPPOSITE_SERVER_FLAVOR_PRESENT",
            "LEGACY_INSTALL_AMBIGUOUS",
            "STATE_SCHEMA_INCOMPATIBLE",
          ].includes(normalized.code),
        });
        throw normalized;
      }
    });
  }

  return Object.freeze({ artifactKind, run });
}
