const SERVER_ARTIFACT_KINDS = new Set([
  "DEMONSTRATION_SERVER",
  "OPERATIONAL_SERVER",
]);

export const SERVER_PROVISIONING_SCHEMA_VERSION = 1;

export const SERVER_PROVISIONING_STATES = Object.freeze([
  "PACKAGE_INSTALLED",
  "PREFLIGHT_OK",
  "STATE_ROOT_READY",
  "CREDENTIALS_READY",
  "POSTGRES_CLUSTER_READY",
  "SCHEMA_READY",
  "INITIAL_LEADER_PENDING_ACK",
  "SERVICES_READY",
  "READY",
  "REPAIR_REQUIRED",
  "CONFLICT",
  "UNSUPPORTED",
]);

export const SERVER_PROVISIONING_STEPS = Object.freeze([
  Object.freeze({ id: "PREFLIGHT", state: "PREFLIGHT_OK" }),
  Object.freeze({ id: "STATE_ROOT", state: "STATE_ROOT_READY" }),
  Object.freeze({ id: "CREDENTIALS", state: "CREDENTIALS_READY" }),
  Object.freeze({ id: "POSTGRES_CLUSTER", state: "POSTGRES_CLUSTER_READY" }),
  Object.freeze({ id: "SCHEMA", state: "SCHEMA_READY" }),
  Object.freeze({
    id: "INITIAL_LEADER",
    state: "INITIAL_LEADER_PENDING_ACK",
    acknowledgementBoundary: true,
  }),
  Object.freeze({ id: "SERVICES", state: "SERVICES_READY" }),
  Object.freeze({ id: "FINAL_READINESS", state: "READY" }),
]);

const STATE_SET = new Set(SERVER_PROVISIONING_STATES);
const STEP_IDS = new Set(SERVER_PROVISIONING_STEPS.map((step) => step.id));
const SECRET_KEY_PATTERN = /(?:password|secret|credential|token|private.?key|connection.?string)/iu;
const SECRET_VALUE_PATTERN = /(?:postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@|BEGIN [A-Z ]*PRIVATE KEY|temporaryPassword=)/iu;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,95}$/u;

function invalid(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function timestamp(value, fieldName) {
  const source = String(value ?? "");
  if (!source || !Number.isFinite(Date.parse(source))) {
    invalid("PROVISIONING_JOURNAL_INVALID", `${fieldName} must be an ISO timestamp.`);
  }
  return new Date(source).toISOString();
}

function assertNoSecretMaterial(value, location = "journal") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
      invalid("PROVISIONING_SECRET_FORBIDDEN", `Secret material is forbidden in ${location}.`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      invalid("PROVISIONING_SECRET_FORBIDDEN", `Secret-bearing field is forbidden in ${location}.`);
    }
    assertNoSecretMaterial(child, `${location}.${key}`);
  }
}

export function assertServerProvisioningArtifact(value) {
  const artifactKind = String(value ?? "").trim().toUpperCase();
  if (!SERVER_ARTIFACT_KINDS.has(artifactKind)) {
    invalid("PROVISIONING_ARTIFACT_INVALID", "Provisioning requires an exact server artifact kind.");
  }
  return artifactKind;
}

export function assertServerProvisioningTransactionId(value) {
  const transactionId = String(value ?? "").trim().toLowerCase();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    invalid("PROVISIONING_TRANSACTION_INVALID", "Provisioning transaction id must be a UUID.");
  }
  return transactionId;
}

export function assertServerProvisioningErrorCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  if (!ERROR_CODE_PATTERN.test(code)) {
    invalid("PROVISIONING_ERROR_INVALID", "Provisioning errors require a stable machine-readable code.");
  }
  return code;
}

export function createServerProvisioningJournalRecord(input) {
  const now = timestamp(input?.createdAt, "createdAt");
  return Object.freeze({
    schemaVersion: SERVER_PROVISIONING_SCHEMA_VERSION,
    transactionId: assertServerProvisioningTransactionId(input?.transactionId),
    artifactKind: assertServerProvisioningArtifact(input?.artifactKind),
    state: "PACKAGE_INSTALLED",
    completedSteps: Object.freeze([]),
    createdAt: now,
    updatedAt: now,
    initialLeader: null,
    error: null,
  });
}

export function validateServerProvisioningJournalRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("PROVISIONING_JOURNAL_INVALID", "Provisioning journal must be an object.");
  }
  assertNoSecretMaterial(value);
  if (value.schemaVersion !== SERVER_PROVISIONING_SCHEMA_VERSION) {
    invalid("PROVISIONING_JOURNAL_INVALID", "Unsupported provisioning journal schema version.");
  }
  const artifactKind = assertServerProvisioningArtifact(value.artifactKind);
  const transactionId = assertServerProvisioningTransactionId(value.transactionId);
  const state = String(value.state ?? "");
  if (!STATE_SET.has(state)) {
    invalid("PROVISIONING_JOURNAL_INVALID", "Provisioning journal contains an invalid state.");
  }
  if (!Array.isArray(value.completedSteps)) {
    invalid("PROVISIONING_JOURNAL_INVALID", "Provisioning completedSteps must be an array.");
  }
  const completedSteps = value.completedSteps.map((step) => String(step));
  if (new Set(completedSteps).size !== completedSteps.length) {
    invalid("PROVISIONING_JOURNAL_INVALID", "Provisioning completedSteps contains duplicates.");
  }
  let previousIndex = -1;
  for (const step of completedSteps) {
    if (!STEP_IDS.has(step)) {
      invalid("PROVISIONING_JOURNAL_INVALID", `Unknown provisioning step: ${step}`);
    }
    const index = SERVER_PROVISIONING_STEPS.findIndex((definition) => definition.id === step);
    if (index <= previousIndex) {
      invalid("PROVISIONING_JOURNAL_INVALID", "Provisioning completedSteps are out of order.");
    }
    previousIndex = index;
  }
  let initialLeader = null;
  if (value.initialLeader !== null && value.initialLeader !== undefined) {
    const userId = Number(value.initialLeader.userId);
    const generation = Number(value.initialLeader.generation);
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(generation) || generation < 1) {
      invalid("PROVISIONING_JOURNAL_INVALID", "Initial LEADER metadata is invalid.");
    }
    initialLeader = Object.freeze({
      userId,
      generation,
      pendingSince: timestamp(value.initialLeader.pendingSince, "initialLeader.pendingSince"),
      acknowledgedAt: value.initialLeader.acknowledgedAt
        ? timestamp(value.initialLeader.acknowledgedAt, "initialLeader.acknowledgedAt")
        : null,
    });
  }
  let journalError = null;
  if (value.error !== null && value.error !== undefined) {
    journalError = Object.freeze({
      code: assertServerProvisioningErrorCode(value.error.code),
      retryable: value.error.retryable === true,
      at: timestamp(value.error.at, "error.at"),
    });
  }
  return Object.freeze({
    schemaVersion: SERVER_PROVISIONING_SCHEMA_VERSION,
    transactionId,
    artifactKind,
    state,
    completedSteps: Object.freeze(completedSteps),
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
    initialLeader,
    error: journalError,
  });
}

export function createServerProvisioningResult(record, overrides = {}) {
  const journal = validateServerProvisioningJournalRecord(record);
  return Object.freeze({
    transactionId: journal.transactionId,
    artifactKind: journal.artifactKind,
    state: overrides.state ?? journal.state,
    completedSteps: Object.freeze([...journal.completedSteps]),
    ...(overrides.errorCode ? { errorCode: assertServerProvisioningErrorCode(overrides.errorCode) } : {}),
    retryable: overrides.retryable === true,
  });
}

export function provisioningFailureState(errorCode) {
  const code = assertServerProvisioningErrorCode(errorCode);
  if (code === "UNSUPPORTED_WINDOWS_VERSION") return "UNSUPPORTED";
  if (code === "OPPOSITE_SERVER_FLAVOR_PRESENT" || code === "PACKAGE_FLAVOR_MISMATCH") {
    return "CONFLICT";
  }
  return "REPAIR_REQUIRED";
}

export function assertProvisioningJournalContainsNoSecrets(value) {
  assertNoSecretMaterial(value);
  return true;
}
