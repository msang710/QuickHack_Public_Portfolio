import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WINDOWS_LEGACY_MSIX_MIGRATION_STEPS } from "../../windows-legacy-msix-migration.mjs";

const JOURNAL_FILENAME = "legacy-msix-v1.json";
const LOCK_NAME = ".legacy-msix.lock";
const CODE = /^[A-Z][A-Z0-9_]{2,95}$/u;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function artifact(value) {
  const result = String(value ?? "").trim().toUpperCase();
  if (!/^(?:DEMONSTRATION|OPERATIONAL)_SERVER$/u.test(result)) {
    throw failure("LEGACY_INSTALL_TARGET_INVALID", "Migration journal requires a server artifact.");
  }
  return result;
}

function stableCode(value) {
  const result = String(value ?? "").trim().toUpperCase();
  if (!CODE.test(result)) throw failure("LEGACY_MIGRATION_JOURNAL_INVALID", "Migration error code is invalid.");
  return result;
}

function assertNoSecrets(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoSecrets);
    return;
  }
  if (!value || typeof value !== "object") {
    if (
      typeof value === "string" &&
      /(?:postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@|BEGIN [A-Z ]*PRIVATE KEY|temporaryPassword=)/iu.test(value)
    ) {
      throw failure("LEGACY_MIGRATION_JOURNAL_SECRET_FORBIDDEN", "Migration journal contains secret material.");
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/(?:password|secret|credential|token|private.?key|connection.?string)/iu.test(key)) {
      throw failure("LEGACY_MIGRATION_JOURNAL_SECRET_FORBIDDEN", "Migration journal cannot contain secret fields.");
    }
    assertNoSecrets(child);
  }
}

function validateSnapshot(value) {
  if (value === null) return null;
  if (
    value?.schemaVersion !== 1 ||
    typeof value.stateExists !== "boolean" ||
    !/^[a-f0-9]{64}$/u.test(String(value.inventorySha256 ?? "")) ||
    !Array.isArray(value.legacyServices) ||
    value.legacyServices.some((name) => !/^[A-Za-z][A-Za-z0-9]{2,95}$/u.test(String(name)))
  ) {
    throw failure("LEGACY_MIGRATION_JOURNAL_INVALID", "Migration snapshot is invalid.");
  }
  const result = Object.freeze({
    schemaVersion: 1,
    stateExists: value.stateExists,
    stateRoot: value.stateExists ? String(value.stateRoot ?? "") : null,
    inventorySha256: String(value.inventorySha256),
    legacyInstallRoot: value.legacyInstallRoot ? String(value.legacyInstallRoot) : null,
    legacyUninstaller: value.legacyUninstaller ? String(value.legacyUninstaller) : null,
    legacyServices: Object.freeze([...value.legacyServices].map(String).sort()),
  });
  assertNoSecrets(result);
  return result;
}

function validateRecord(value, expectedArtifact) {
  if (
    value?.schemaVersion !== 1 ||
    value.artifactKind !== expectedArtifact ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value.transactionId ?? "")) ||
    !Array.isArray(value.completedSteps)
  ) {
    throw failure("LEGACY_MIGRATION_JOURNAL_INVALID", "Migration journal record is invalid.");
  }
  let previous = -1;
  for (const stepId of value.completedSteps) {
    const index = WINDOWS_LEGACY_MSIX_MIGRATION_STEPS.findIndex((step) => step.id === stepId);
    if (index < 0 || index <= previous) {
      throw failure("LEGACY_MIGRATION_JOURNAL_INVALID", "Migration steps are invalid or out of order.");
    }
    previous = index;
  }
  if (value.mode !== null && !["INSTALLED_INNO", "PRESERVED_STATE"].includes(value.mode)) {
    throw failure("LEGACY_MIGRATION_JOURNAL_INVALID", "Migration mode is invalid.");
  }
  const record = Object.freeze({
    schemaVersion: 1,
    artifactKind: expectedArtifact,
    transactionId: value.transactionId,
    state: String(value.state ?? "DISCOVERING"),
    mode: value.mode ?? null,
    reasonCode: value.reasonCode ? stableCode(value.reasonCode) : null,
    completedSteps: Object.freeze([...value.completedSteps]),
    snapshot: validateSnapshot(value.snapshot ?? null),
    createdAt: String(value.createdAt ?? ""),
    updatedAt: String(value.updatedAt ?? ""),
    error: value.error
      ? Object.freeze({
          code: stableCode(value.error.code),
          retryable: value.error.retryable === true,
          at: String(value.error.at ?? ""),
        })
      : null,
  });
  assertNoSecrets(record);
  return record;
}

async function atomicWrite(filename, record) {
  assertNoSecrets(record);
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function windowsLegacyMigrationRoot(input) {
  const programData = path.win32.resolve(String(input?.programData ?? ""));
  if (!path.win32.isAbsolute(programData) || programData.split(/[\\/]+/u).includes("..")) {
    throw failure("LEGACY_MIGRATION_PATH_INVALID", "ProgramData must be an absolute Windows path.");
  }
  const kind = artifact(input?.artifactKind);
  return path.win32.join(
    programData,
    "QuickHack",
    kind === "DEMONSTRATION_SERVER" ? "demonstration-server" : "operational-server",
    "migration"
  );
}

export function createWindowsLegacyMigrationJournal(input) {
  return createFileLegacyMigrationJournal({
    ...input,
    rootDirectory: windowsLegacyMigrationRoot(input),
  });
}

export function createFileLegacyMigrationJournal(input) {
  const artifactKind = artifact(input?.artifactKind);
  const rootDirectory = path.resolve(String(input?.rootDirectory ?? ""));
  if (!path.isAbsolute(rootDirectory) || rootDirectory === path.parse(rootDirectory).root) {
    throw failure("LEGACY_MIGRATION_PATH_INVALID", "Migration journal root must be bounded and absolute.");
  }
  const journalPath = path.join(rootDirectory, JOURNAL_FILENAME);
  const lockPath = path.join(rootDirectory, LOCK_NAME);
  const clock = input?.clock ?? (() => new Date());
  const now = () => new Date(clock()).toISOString();

  async function read() {
    const source = await fs.readFile(journalPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (source === null) return null;
    try {
      return validateRecord(JSON.parse(source.replace(/^\uFEFF/u, "")), artifactKind);
    } catch (error) {
      if (error?.code) throw error;
      throw failure("LEGACY_MIGRATION_JOURNAL_INVALID", "Migration journal is not valid JSON.");
    }
  }

  async function write(value) {
    const record = validateRecord(value, artifactKind);
    await atomicWrite(journalPath, record);
    return record;
  }

  async function initialize(transactionId) {
    const existing = await read();
    if (existing) return existing;
    const timestamp = now();
    return write({
      schemaVersion: 1,
      artifactKind,
      transactionId,
      state: "DISCOVERING",
      mode: null,
      reasonCode: null,
      completedSteps: [],
      snapshot: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      error: null,
    });
  }

  async function update(transactionId, mutator) {
    const current = await read();
    if (!current || current.transactionId !== transactionId) {
      throw failure("LEGACY_MIGRATION_TRANSACTION_CONFLICT", "Migration transaction changed unexpectedly.");
    }
    return write(mutator(current, now()));
  }

  async function setDiscovery(inputDiscovery) {
    return update(inputDiscovery.transactionId, (current, updatedAt) => ({
      ...current,
      mode: inputDiscovery.mode,
      reasonCode: stableCode(inputDiscovery.reasonCode),
      updatedAt,
      error: null,
    }));
  }

  async function setSnapshot(inputSnapshot) {
    const snapshot = validateSnapshot(inputSnapshot.snapshot);
    return update(inputSnapshot.transactionId, (current, updatedAt) => ({
      ...current,
      snapshot,
      updatedAt,
      error: null,
    }));
  }

  async function commitStep(inputStep) {
    const index = WINDOWS_LEGACY_MSIX_MIGRATION_STEPS.findIndex((step) => step.id === inputStep.stepId);
    if (index < 0) throw failure("LEGACY_MIGRATION_STEP_INVALID", "Migration step is invalid.");
    return update(inputStep.transactionId, (current, updatedAt) => {
      const retained = current.completedSteps.filter((stepId) =>
        WINDOWS_LEGACY_MSIX_MIGRATION_STEPS.findIndex((step) => step.id === stepId) <= index
      );
      if (!retained.includes(inputStep.stepId)) retained.push(inputStep.stepId);
      return {
        ...current,
        state: WINDOWS_LEGACY_MSIX_MIGRATION_STEPS[index].state,
        completedSteps: retained,
        updatedAt,
        error: null,
      };
    });
  }

  async function reconcileBefore(inputStep) {
    const index = WINDOWS_LEGACY_MSIX_MIGRATION_STEPS.findIndex((step) => step.id === inputStep.stepId);
    if (index < 0) throw failure("LEGACY_MIGRATION_STEP_INVALID", "Migration step is invalid.");
    return update(inputStep.transactionId, (current, updatedAt) => {
      const completedSteps = current.completedSteps.filter((stepId) =>
        WINDOWS_LEGACY_MSIX_MIGRATION_STEPS.findIndex((step) => step.id === stepId) < index
      );
      const state = completedSteps.length === 0
        ? "DISCOVERING"
        : WINDOWS_LEGACY_MSIX_MIGRATION_STEPS.find((step) => step.id === completedSteps.at(-1)).state;
      return { ...current, state, completedSteps, updatedAt, error: null };
    });
  }

  async function recordFailure(inputError) {
    return update(inputError.transactionId, (current, updatedAt) => ({
      ...current,
      state: inputError.state,
      updatedAt,
      error: { code: stableCode(inputError.code), retryable: inputError.retryable === true, at: updatedAt },
    }));
  }

  async function withLock(action) {
    await fs.mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw failure("LEGACY_MIGRATION_LOCKED", "Another legacy migration transaction is active.");
      }
      throw error;
    }
    try {
      return await action();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return Object.freeze({
    artifactKind,
    rootDirectory,
    journalPath,
    read,
    initialize,
    setDiscovery,
    setSnapshot,
    commitStep,
    reconcileBefore,
    recordFailure,
    withLock,
  });
}
