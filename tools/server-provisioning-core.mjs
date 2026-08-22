import { randomUUID } from "node:crypto";
import {
  SERVER_PROVISIONING_STEPS,
  assertServerProvisioningArtifact,
  assertServerProvisioningErrorCode,
  createServerProvisioningResult,
  provisioningFailureState,
} from "./server-provisioning-contract.mjs";

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,95}$/u;

function normalizeProvisioningError(error, stepId) {
  const candidate = String(error?.code ?? "").trim().toUpperCase();
  if (
    STABLE_ERROR_CODE_PATTERN.test(candidate) &&
    candidate.includes("_") &&
    !candidate.startsWith("ERR_")
  ) {
    if (error instanceof Error && error.code === candidate) return error;
    return failure(candidate, error instanceof Error ? error.message : "Provisioning step failed.");
  }
  return failure(
    `PROVISIONING_${stepId}_FAILED`,
    `Provisioning step failed for ${stepId}.`
  );
}

function observedReady(value) {
  return value === true || value?.ready === true;
}

function requiredMethod(owner, name) {
  if (typeof owner?.[name] !== "function") {
    throw new TypeError(`Server provisioning requires ${name}().`);
  }
}

export function createServerProvisioningCore(options) {
  const artifactKind = assertServerProvisioningArtifact(options?.artifactKind);
  const adapter = options?.adapter;
  const journal = options?.journal;
  for (const method of ["probe", "mutate", "postcondition"]) requiredMethod(adapter, method);
  for (const method of [
    "initialize",
    "read",
    "commitStep",
    "reconcileBefore",
    "setInitialLeaderPending",
    "recordFailure",
    "withLock",
  ]) requiredMethod(journal, method);
  if (journal.artifactKind !== artifactKind) {
    throw failure("PACKAGE_FLAVOR_MISMATCH", "Provisioning core and journal artifact kinds differ.");
  }

  async function run(input = {}) {
    const requestedTransactionId = input.transactionId ?? randomUUID();
    return journal.withLock(async () => {
      let record = await journal.initialize(requestedTransactionId);
      const transactionId = record.transactionId;
      const context = Object.freeze({ artifactKind, transactionId, input });
      let activeStepId = "STEP";
      try {
        for (const step of SERVER_PROVISIONING_STEPS) {
          activeStepId = step.id;
          let observed = await adapter.probe(step, context);
          if (!observedReady(observed)) {
            if (record.completedSteps.includes(step.id)) {
              record = await journal.reconcileBefore({ transactionId, stepId: step.id });
            }
            const mutation = await adapter.mutate(step, { ...context, record, observed });
            if (step.acknowledgementBoundary && mutation?.pendingAcknowledgement === true) {
              record = await journal.setInitialLeaderPending({
                transactionId,
                userId: mutation.userId,
                generation: mutation.generation,
              });
              return Object.freeze({
                ...createServerProvisioningResult(record),
                state: "INITIAL_LEADER_PENDING_ACK",
                retryable: true,
                handoff: mutation.handoff,
              });
            }
            observed = await adapter.postcondition(step, { ...context, record, mutation });
            if (!observedReady(observed)) {
              throw failure(
                "PROVISIONING_POSTCONDITION_FAILED",
                `Provisioning postcondition failed for ${step.id}.`
              );
            }
          }
          record = await journal.commitStep({ transactionId, stepId: step.id });
        }
        return createServerProvisioningResult(record, { retryable: false });
      } catch (error) {
        const normalizedError = normalizeProvisioningError(error, activeStepId);
        const code = assertServerProvisioningErrorCode(normalizedError.code);
        const state = provisioningFailureState(code);
        const retryable = !["UNSUPPORTED", "CONFLICT"].includes(state);
        record = await journal.recordFailure({
          transactionId,
          code,
          state,
          retryable,
        });
        normalizedError.provisioningResult = createServerProvisioningResult(record, {
          state,
          errorCode: code,
          retryable,
        });
        throw normalizedError;
      }
    });
  }

  return Object.freeze({ artifactKind, run });
}
