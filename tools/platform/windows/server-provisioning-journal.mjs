import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  SERVER_PROVISIONING_STEPS,
  assertProvisioningJournalContainsNoSecrets,
  assertServerProvisioningArtifact,
  assertServerProvisioningErrorCode,
  assertServerProvisioningTransactionId,
  createServerProvisioningJournalRecord,
  validateServerProvisioningJournalRecord,
} from "../../server-provisioning-contract.mjs";

const JOURNAL_FILENAME = "server-provisioning-v1.json";
const LOCK_DIRECTORY_NAME = ".server-provisioning.lock";
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mutableRootName(artifactKind) {
  return assertServerProvisioningArtifact(artifactKind) === "DEMONSTRATION_SERVER"
    ? "demonstration-server"
    : "operational-server";
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function iso(clock) {
  const value = new Date(clock()).toISOString();
  if (!Number.isFinite(Date.parse(value))) {
    throw failure("PROVISIONING_CLOCK_INVALID", "Provisioning clock returned an invalid value.");
  }
  return value;
}

function assertContained(rootDirectory, candidate) {
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(candidate);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw failure("PROVISIONING_PATH_INVALID", "Provisioning journal path escaped its owned root.");
  }
  return resolved;
}

async function atomicWrite(filename, value) {
  assertProvisioningJournalContainsNoSecrets(value);
  const temporaryPath = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const payload = canonicalJson(value);
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filename);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function windowsServerProvisioningRoot(input) {
  const programData = path.win32.resolve(String(input?.programData ?? ""));
  if (!/^[A-Za-z]:\\/u.test(programData)) {
    throw failure("PROVISIONING_PATH_INVALID", "Windows ProgramData must be an absolute drive path.");
  }
  return path.win32.join(
    programData,
    "QuickHack",
    mutableRootName(input?.artifactKind),
    "provisioning"
  );
}

export function createWindowsServerProvisioningJournal(input) {
  return createFileServerProvisioningJournal({
    ...input,
    rootDirectory: windowsServerProvisioningRoot(input),
  });
}

export function createFileServerProvisioningJournal(input) {
  const artifactKind = assertServerProvisioningArtifact(input?.artifactKind);
  const rootDirectory = path.resolve(String(input?.rootDirectory ?? ""));
  if (!path.isAbsolute(rootDirectory) || rootDirectory === path.parse(rootDirectory).root) {
    throw failure("PROVISIONING_PATH_INVALID", "Provisioning journal root must be a bounded absolute path.");
  }
  const clock = input?.clock ?? (() => new Date());
  const staleLockMs = input?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const journalPath = assertContained(rootDirectory, path.join(rootDirectory, JOURNAL_FILENAME));
  const lockPath = assertContained(rootDirectory, path.join(rootDirectory, LOCK_DIRECTORY_NAME));

  async function read() {
    const source = await fs.readFile(journalPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (source === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(source.replace(/^\uFEFF/u, ""));
    } catch {
      throw failure("PROVISIONING_JOURNAL_INVALID", "Provisioning journal is not valid JSON.");
    }
    const record = validateServerProvisioningJournalRecord(parsed);
    if (record.artifactKind !== artifactKind) {
      throw failure("PACKAGE_FLAVOR_MISMATCH", "Provisioning journal belongs to another server artifact.");
    }
    return record;
  }

  async function write(record) {
    const validated = validateServerProvisioningJournalRecord(record);
    if (validated.artifactKind !== artifactKind) {
      throw failure("PACKAGE_FLAVOR_MISMATCH", "Provisioning journal belongs to another server artifact.");
    }
    await fs.mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    await atomicWrite(journalPath, validated);
    return validated;
  }

  async function initialize(transactionId) {
    const existing = await read();
    if (existing) return existing;
    const createdAt = iso(clock);
    return write(createServerProvisioningJournalRecord({
      transactionId,
      artifactKind,
      createdAt,
    }));
  }

  async function update(mutator) {
    const current = await read();
    if (!current) throw failure("PROVISIONING_JOURNAL_MISSING", "Provisioning journal is missing.");
    const next = mutator(current, iso(clock));
    return write(next);
  }

  async function commitStep(inputStep) {
    const transactionId = assertServerProvisioningTransactionId(inputStep?.transactionId);
    const stepIndex = SERVER_PROVISIONING_STEPS.findIndex((step) => step.id === inputStep?.stepId);
    if (stepIndex < 0) throw failure("PROVISIONING_STEP_INVALID", "Unknown provisioning step.");
    return update((current, updatedAt) => {
      if (current.transactionId !== transactionId) {
        throw failure("PROVISIONING_TRANSACTION_CONFLICT", "Provisioning transaction changed unexpectedly.");
      }
      const retained = current.completedSteps.filter((stepId) =>
        SERVER_PROVISIONING_STEPS.findIndex((step) => step.id === stepId) <= stepIndex
      );
      if (!retained.includes(inputStep.stepId)) retained.push(inputStep.stepId);
      return {
        ...current,
        state: SERVER_PROVISIONING_STEPS[stepIndex].state,
        completedSteps: retained,
        updatedAt,
        error: null,
      };
    });
  }

  async function reconcileBefore(inputStep) {
    const transactionId = assertServerProvisioningTransactionId(inputStep?.transactionId);
    const stepIndex = SERVER_PROVISIONING_STEPS.findIndex((step) => step.id === inputStep?.stepId);
    if (stepIndex < 0) throw failure("PROVISIONING_STEP_INVALID", "Unknown provisioning step.");
    return update((current, updatedAt) => {
      if (current.transactionId !== transactionId) {
        throw failure("PROVISIONING_TRANSACTION_CONFLICT", "Provisioning transaction changed unexpectedly.");
      }
      const completedSteps = current.completedSteps.filter((stepId) =>
        SERVER_PROVISIONING_STEPS.findIndex((step) => step.id === stepId) < stepIndex
      );
      const previousState = completedSteps.length === 0
        ? "PACKAGE_INSTALLED"
        : SERVER_PROVISIONING_STEPS.find((step) => step.id === completedSteps.at(-1)).state;
      return {
        ...current,
        state: previousState,
        completedSteps,
        updatedAt,
        error: null,
      };
    });
  }

  async function setInitialLeaderPending(inputLeader) {
    const transactionId = assertServerProvisioningTransactionId(inputLeader?.transactionId);
    const userId = Number(inputLeader?.userId);
    const generation = Number(inputLeader?.generation);
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(generation) || generation < 1) {
      throw failure("PROVISIONING_LEADER_METADATA_INVALID", "Initial LEADER metadata is invalid.");
    }
    return update((current, updatedAt) => {
      if (current.transactionId !== transactionId) {
        throw failure("PROVISIONING_TRANSACTION_CONFLICT", "Provisioning transaction changed unexpectedly.");
      }
      return {
        ...current,
        state: "INITIAL_LEADER_PENDING_ACK",
        updatedAt,
        initialLeader: {
          userId,
          generation,
          pendingSince: updatedAt,
          acknowledgedAt: null,
        },
        error: null,
      };
    });
  }

  async function acknowledgeInitialLeader(inputLeader) {
    const transactionId = assertServerProvisioningTransactionId(inputLeader?.transactionId);
    const generation = Number(inputLeader?.generation);
    return update((current, updatedAt) => {
      if (current.transactionId !== transactionId || current.initialLeader?.generation !== generation) {
        throw failure("PROVISIONING_ACK_CONFLICT", "Initial LEADER acknowledgement does not match the pending generation.");
      }
      if (current.initialLeader.acknowledgedAt) return current;
      return {
        ...current,
        updatedAt,
        initialLeader: { ...current.initialLeader, acknowledgedAt: updatedAt },
        error: null,
      };
    });
  }

  async function recordFailure(inputError) {
    const transactionId = assertServerProvisioningTransactionId(inputError?.transactionId);
    const code = assertServerProvisioningErrorCode(inputError?.code);
    return update((current, updatedAt) => {
      if (current.transactionId !== transactionId) {
        throw failure("PROVISIONING_TRANSACTION_CONFLICT", "Provisioning transaction changed unexpectedly.");
      }
      return {
        ...current,
        state: inputError.state,
        updatedAt,
        error: { code, retryable: inputError.retryable === true, at: updatedAt },
      };
    });
  }

  async function acquireLock() {
    await fs.mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockSource = await fs.readFile(path.join(lockPath, "owner.json"), "utf8").catch(() => "{}");
      let lock = {};
      try { lock = JSON.parse(lockSource); } catch {}
      const age = Date.now() - Date.parse(String(lock.createdAt ?? ""));
      if (!processIsRunning(Number(lock.pid)) && Number.isFinite(age) && age >= staleLockMs) {
        await fs.rm(lockPath, { recursive: true, force: true });
        await fs.mkdir(lockPath, { mode: 0o700 });
      } else {
        throw failure("PROVISIONING_LOCKED", "Another server provisioning transaction is active.");
      }
    }
    await atomicWrite(path.join(lockPath, "owner.json"), {
      schemaVersion: 1,
      pid: process.pid,
      createdAt: iso(clock),
    });
  }

  async function withLock(action) {
    await acquireLock();
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
    write,
    initialize,
    commitStep,
    reconcileBefore,
    setInitialLeaderPending,
    acknowledgeInitialLeader,
    recordFailure,
    withLock,
  });
}
