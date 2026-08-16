import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MANIFEST_KIND = "QUICKHACK_RESTORE_REQUEST";
const MANIFEST_VERSION = 2;
const MAX_MANIFEST_BYTES = 8192;
const BACKUP_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.qhb$/u;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_PATTERN = /^[a-f0-9]{48}$/u;
const CLAIMED_FILE_PATTERN = /^restore-request\.claimed\.([0-9a-f-]{36})\.(\d+)\.([a-f0-9]{48})\.json$/u;

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function defaultProcessExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function manifestPayload(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    state: value.state,
    operationId: value.operationId,
    backupFile: value.backupFile,
    creatorPid: value.creatorPid,
    creatorToken: value.creatorToken,
    createdAt: value.createdAt,
  };
}

function payloadChecksum(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(manifestPayload(value)), "utf8")
    .digest("hex");
}

function fsyncDirectory(fileSystem, directory) {
  let handle;
  try {
    handle = fileSystem.openSync(directory, "r");
    fileSystem.fsyncSync(handle);
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(error?.code)) throw error;
  } finally {
    if (handle !== undefined) fileSystem.closeSync(handle);
  }
}

function assertRegularFile(fileSystem, filename) {
  const stat = fileSystem.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_MANIFEST_BYTES) {
    throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The restore request file requires administrator review.");
  }
  return stat;
}

function readManifest(fileSystem, filename) {
  assertRegularFile(fileSystem, filename);
  let value;
  try {
    value = JSON.parse(fileSystem.readFileSync(filename, "utf8"));
  } catch (error) {
    throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The restore request manifest is not valid JSON.", error);
  }
  if (
    value?.schemaVersion !== MANIFEST_VERSION ||
    value?.kind !== MANIFEST_KIND ||
    value?.state !== "PUBLISHED" ||
    !OPERATION_ID_PATTERN.test(String(value?.operationId ?? "")) ||
    !BACKUP_FILE_PATTERN.test(String(value?.backupFile ?? "")) ||
    !Number.isInteger(value?.creatorPid) ||
    value.creatorPid <= 0 ||
    !TOKEN_PATTERN.test(String(value?.creatorToken ?? "")) ||
    !Number.isFinite(Date.parse(String(value?.createdAt ?? ""))) ||
    !/^[a-f0-9]{64}$/u.test(String(value?.payloadChecksum ?? "")) ||
    payloadChecksum(value) !== value.payloadChecksum
  ) {
    throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The restore request manifest failed schema or checksum validation.");
  }
  return value;
}

function readLegacyManifest(fileSystem, filename) {
  assertRegularFile(fileSystem, filename);
  let value;
  try {
    value = JSON.parse(fileSystem.readFileSync(filename, "utf8"));
  } catch (error) {
    throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The legacy restore request is not valid JSON.", error);
  }
  if (value?.schemaVersion !== 1 || !BACKUP_FILE_PATTERN.test(String(value?.backupFile ?? ""))) {
    throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The legacy restore request failed validation.");
  }
  return value;
}

function restorePublishedAfterMismatch(fileSystem, recoveryPath, publishedPath) {
  try {
    fileSystem.renameSync(recoveryPath, publishedPath);
  } catch (error) {
    throw failure(
      "RESTORE_REQUEST_REQUIRES_REVIEW",
      "A restore request ownership race requires administrator review.",
      error
    );
  }
}

export function createRestoreRequestHandoff(options = {}) {
  const fileSystem = options.fileSystem ?? fs;
  const currentPid = options.currentPid ?? process.pid;
  const processExists = options.processExists ?? defaultProcessExists;
  const createOperationId = options.createOperationId ?? (() => crypto.randomUUID());
  const createToken = options.createToken ?? (() => crypto.randomBytes(24).toString("hex"));
  const now = options.now ?? (() => new Date());
  const legacyRecoveryGraceMs = options.legacyRecoveryGraceMs ?? 2 * 60 * 60_000;

  function resolvePaths(runtimeConfig) {
    const configuredDirectory = String(runtimeConfig?.dataDirectory ?? "").trim();
    if (!configuredDirectory) {
      throw failure("RESTORE_REQUEST_INVALID", "The restore data directory is invalid.");
    }
    const dataDirectory = path.resolve(configuredDirectory);
    const directory = path.join(dataDirectory, "state", "operator");
    const publishedPath = path.join(directory, "restore-request.json");
    return { dataDirectory, directory, publishedPath };
  }

  function ensureDirectory(directory) {
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fileSystem.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The restore request directory is not a safe directory.");
    }
    try {
      fileSystem.chmodSync(directory, 0o700);
    } catch (error) {
      if (!["ENOSYS", "EPERM", "ENOTSUP"].includes(error?.code)) throw error;
    }
  }

  function claimedEntries(directory) {
    return fileSystem.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith("restore-request.claimed."))
      .map((entry) => {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The restore claim directory contains an unsafe entry.");
        }
        const match = CLAIMED_FILE_PATTERN.exec(entry.name);
        if (!match) {
          throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The restore claim filename is invalid.");
        }
        return {
          filename: entry.name,
          claimedPath: path.join(directory, entry.name),
          operationId: match[1],
          ownerPid: Number(match[2]),
          ownerToken: match[3],
        };
      });
  }

  function recoverExpiredClaims(directory) {
    for (const entry of claimedEntries(directory)) {
      if (processExists(entry.ownerPid)) {
        throw failure("RESTORE_REQUEST_IN_PROGRESS", "A claimed restore request is still owned by an active process.");
      }
      const recoveryPath = path.join(
        directory,
        `restore-request.recover-claim.${entry.operationId}.${createToken()}.json`
      );
      try {
        fileSystem.renameSync(entry.claimedPath, recoveryPath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      try {
        let manifest;
        try {
          manifest = readManifest(fileSystem, recoveryPath);
        } catch (error) {
          try {
            manifest = { ...readLegacyManifest(fileSystem, recoveryPath), legacy: true };
          } catch {
            throw error;
          }
        }
        if (!manifest.legacy && manifest.operationId !== entry.operationId) {
          throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The expired restore claim does not match its operation.");
        }
        fileSystem.rmSync(recoveryPath, { force: true });
      } catch (error) {
        const quarantinePath = path.join(
          directory,
          `restore-request.quarantined.${entry.operationId}.${createToken()}.json`
        );
        try { fileSystem.renameSync(recoveryPath, quarantinePath); } catch {}
        throw error;
      }
    }
  }

  function recoverUnclaimed(directory, publishedPath) {
    if (!fileSystem.existsSync(publishedPath)) return false;
    const before = assertRegularFile(fileSystem, publishedPath);
    let observed;
    try {
      observed = readManifest(fileSystem, publishedPath);
    } catch (error) {
      let legacy;
      try {
        legacy = readLegacyManifest(fileSystem, publishedPath);
      } catch {
        throw error;
      }
      if (now().getTime() - before.mtimeMs < legacyRecoveryGraceMs) {
        throw failure(
          "RESTORE_REQUEST_RECOVERY_PENDING",
          "A legacy restore request is inside its compatibility recovery grace period."
        );
      }
      const recoveryPath = path.join(directory, `restore-request.recover-legacy.${createToken()}.json`);
      try {
        fileSystem.renameSync(publishedPath, recoveryPath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") return false;
        throw renameError;
      }
      const after = assertRegularFile(fileSystem, recoveryPath);
      const recovered = readLegacyManifest(fileSystem, recoveryPath);
      if (
        recovered.backupFile !== legacy.backupFile ||
        (Number.isInteger(before.ino) && Number.isInteger(after.ino) && before.ino !== after.ino)
      ) {
        restorePublishedAfterMismatch(fileSystem, recoveryPath, publishedPath);
        throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The legacy restore request changed during recovery.");
      }
      fileSystem.rmSync(recoveryPath, { force: true });
      fsyncDirectory(fileSystem, directory);
      return true;
    }
    if (processExists(observed.creatorPid)) {
      throw failure("RESTORE_REQUEST_IN_PROGRESS", "An unclaimed restore request still has an active producer.");
    }
    const recoveryPath = path.join(
      directory,
      `restore-request.recover-published.${observed.operationId}.${createToken()}.json`
    );
    try {
      fileSystem.renameSync(publishedPath, recoveryPath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    const after = assertRegularFile(fileSystem, recoveryPath);
    const recovered = readManifest(fileSystem, recoveryPath);
    if (
      recovered.operationId !== observed.operationId ||
      recovered.creatorToken !== observed.creatorToken ||
      (Number.isInteger(before.ino) && Number.isInteger(after.ino) && before.ino !== after.ino)
    ) {
      restorePublishedAfterMismatch(fileSystem, recoveryPath, publishedPath);
      throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The unclaimed restore request changed during recovery.");
    }
    fileSystem.rmSync(recoveryPath, { force: true });
    fsyncDirectory(fileSystem, directory);
    return true;
  }

  function prepare(backupFileValue, runtimeConfig) {
    const backupFile = String(backupFileValue ?? "").trim();
    if (!BACKUP_FILE_PATTERN.test(backupFile)) {
      throw failure("RESTORE_REQUEST_INVALID", "Restore requires a finite backup file name from the QuickHack backup directory.");
    }
    const paths = resolvePaths(runtimeConfig);
    ensureDirectory(paths.directory);
    recoverExpiredClaims(paths.directory);
    recoverUnclaimed(paths.directory, paths.publishedPath);

    const operationId = createOperationId();
    const creatorToken = createToken();
    if (!OPERATION_ID_PATTERN.test(operationId) || !TOKEN_PATTERN.test(creatorToken)) {
      throw new TypeError("The restore handoff identity generator returned an invalid value.");
    }
    const manifest = {
      schemaVersion: MANIFEST_VERSION,
      kind: MANIFEST_KIND,
      state: "PUBLISHED",
      operationId,
      backupFile,
      creatorPid: currentPid,
      creatorToken,
      createdAt: now().toISOString(),
    };
    manifest.payloadChecksum = payloadChecksum(manifest);
    const preparedPath = path.join(paths.directory, `restore-request.prepared.${operationId}.${creatorToken}.tmp`);
    let handle;
    try {
      handle = fileSystem.openSync(preparedPath, "wx", 0o600);
      fileSystem.writeFileSync(handle, `${JSON.stringify(manifest)}\n`, "utf8");
      fileSystem.fsyncSync(handle);
      fileSystem.closeSync(handle);
      handle = undefined;
      fileSystem.renameSync(preparedPath, paths.publishedPath);
      fsyncDirectory(fileSystem, paths.directory);
    } catch (error) {
      if (handle !== undefined) fileSystem.closeSync(handle);
      fileSystem.rmSync(preparedPath, { force: true });
      throw error;
    }
    return Object.freeze({
      kind: MANIFEST_KIND,
      operationId,
      creatorPid: currentPid,
      creatorToken,
      backupFile,
      directory: paths.directory,
      publishedPath: paths.publishedPath,
    });
  }

  function cleanupUnclaimed(receipt) {
    if (!receipt || receipt.kind !== MANIFEST_KIND) return false;
    const publishedPath = path.resolve(String(receipt.publishedPath ?? ""));
    const directory = path.resolve(String(receipt.directory ?? ""));
    if (path.dirname(publishedPath) !== directory || path.basename(publishedPath) !== "restore-request.json") {
      throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The restore cleanup receipt path is invalid.");
    }
    if (!fileSystem.existsSync(publishedPath)) return false;
    const before = assertRegularFile(fileSystem, publishedPath);
    const cleanupPath = path.join(
      directory,
      `restore-request.cleanup.${receipt.operationId}.${receipt.creatorToken}.json`
    );
    try {
      fileSystem.renameSync(publishedPath, cleanupPath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    const after = assertRegularFile(fileSystem, cleanupPath);
    const manifest = readManifest(fileSystem, cleanupPath);
    if (
      manifest.operationId !== receipt.operationId ||
      manifest.creatorToken !== receipt.creatorToken ||
      manifest.creatorPid !== receipt.creatorPid ||
      (Number.isInteger(before.ino) && Number.isInteger(after.ino) && before.ino !== after.ino)
    ) {
      restorePublishedAfterMismatch(fileSystem, cleanupPath, publishedPath);
      return false;
    }
    fileSystem.rmSync(cleanupPath, { force: true });
    fsyncDirectory(fileSystem, directory);
    return true;
  }

  function claim(runtimeConfig) {
    const paths = resolvePaths(runtimeConfig);
    ensureDirectory(paths.directory);
    recoverExpiredClaims(paths.directory);
    const ownerToken = createToken();
    let published;
    try {
      published = readManifest(fileSystem, paths.publishedPath);
    } catch (error) {
      try {
        const legacy = readLegacyManifest(fileSystem, paths.publishedPath);
        published = {
          schemaVersion: 1,
          operationId: createOperationId(),
          backupFile: legacy.backupFile,
          legacy: true,
        };
      } catch {
        throw error;
      }
    }
    const claimedPath = path.join(
      paths.directory,
      `restore-request.claimed.${published.operationId}.${currentPid}.${ownerToken}.json`
    );
    try {
      fileSystem.renameSync(paths.publishedPath, claimedPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw failure("RESTORE_REQUEST_UNAVAILABLE", "The restore request was already claimed or is unavailable.", error);
      }
      throw error;
    }
    let manifest;
    try {
      if (published.legacy) {
        const legacy = readLegacyManifest(fileSystem, claimedPath);
        if (legacy.backupFile !== published.backupFile) {
          throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The legacy restore request changed while it was being claimed.");
        }
        manifest = published;
      } else {
        manifest = readManifest(fileSystem, claimedPath);
        if (manifest.operationId !== published.operationId || manifest.creatorToken !== published.creatorToken) {
          throw failure("RESTORE_REQUEST_REQUIRES_REVIEW", "The restore request changed while it was being claimed.");
        }
      }
      fsyncDirectory(fileSystem, paths.directory);
    } catch (error) {
      const quarantinePath = path.join(
        paths.directory,
        `restore-request.quarantined.${published.operationId}.${ownerToken}.json`
      );
      try { fileSystem.renameSync(claimedPath, quarantinePath); } catch {}
      throw error;
    }
    return Object.freeze({
      kind: MANIFEST_KIND,
      schemaVersion: published.schemaVersion,
      operationId: manifest.operationId,
      backupFile: manifest.backupFile,
      ownerPid: currentPid,
      ownerToken,
      directory: paths.directory,
      claimedPath,
    });
  }

  function finalize(claimReceipt, terminalStateValue = "FAILED") {
    if (!claimReceipt || claimReceipt.kind !== MANIFEST_KIND) return false;
    const directory = path.resolve(String(claimReceipt.directory ?? ""));
    const expectedName = `restore-request.claimed.${claimReceipt.operationId}.${claimReceipt.ownerPid}.${claimReceipt.ownerToken}.json`;
    const claimedPath = path.resolve(String(claimReceipt.claimedPath ?? ""));
    if (
      path.dirname(claimedPath) !== directory ||
      path.basename(claimedPath) !== expectedName ||
      !OPERATION_ID_PATTERN.test(String(claimReceipt.operationId ?? "")) ||
      !TOKEN_PATTERN.test(String(claimReceipt.ownerToken ?? "")) ||
      claimReceipt.ownerPid !== currentPid
    ) {
      throw failure("RESTORE_REQUEST_OWNER_MISMATCH", "Only the active restore claim owner may finalize the request.");
    }
    if (!fileSystem.existsSync(claimedPath)) return false;
    const terminalState = String(terminalStateValue ?? "").trim().toUpperCase();
    if (!["SUCCEEDED", "FAILED"].includes(terminalState)) {
      throw new TypeError("The restore request terminal state is invalid.");
    }
    const manifest = claimReceipt.schemaVersion === 1
      ? readLegacyManifest(fileSystem, claimedPath)
      : readManifest(fileSystem, claimedPath);
    if (claimReceipt.schemaVersion !== 1 && manifest.operationId !== claimReceipt.operationId) {
      throw failure("RESTORE_REQUEST_OWNER_MISMATCH", "The restore claim operation does not match its owner receipt.");
    }
    const terminalPath = path.join(
      directory,
      `restore-request.${terminalState.toLowerCase()}.${claimReceipt.operationId}.${claimReceipt.ownerToken}.json`
    );
    fileSystem.renameSync(claimedPath, terminalPath);
    fsyncDirectory(fileSystem, directory);
    fileSystem.rmSync(terminalPath, { force: true });
    fsyncDirectory(fileSystem, directory);
    return true;
  }

  return Object.freeze({ prepare, claim, finalize, cleanupUnclaimed });
}

export const defaultRestoreRequestHandoff = createRestoreRequestHandoff();
