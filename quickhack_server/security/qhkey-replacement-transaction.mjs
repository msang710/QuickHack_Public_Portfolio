import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { composeServerPlatform } from "../platform/compose-server-platform.ts";
import {
  QhkeyPlatformError,
  assertQhkeyProvider,
  assertQhkeyReplacementState,
  assertQhkeyTransactionId,
  createQhkeyVolumeIdentity,
  publicQhkeyReplacement,
  qhkeyProviderRelativePath,
} from "../platform/qhkey-contract.mjs";
import {
  createEncryptedQhkey,
  decryptQhkeyBuffer,
  readQhkeyMetadataBuffer,
} from "./qhkey-format.mjs";
import { clearAllQhkeyCredentialStateCaches } from "./qhkey-cache-invalidation.mjs";

const TRANSACTION_VERSION = 1;
const DEFAULT_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_STALE_MS = 2 * 60 * 1000;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_STAGE_BYTES = 64 * 1024;
const MISSING_HASH = "MISSING";
const ACTIVE_STATES = new Set(["PREPARED", "AUTHORIZATION_REQUIRED", "PUBLISHING"]);
const TERMINAL_STATES = new Set(["PUBLISHED", "CANCELLED", "FAILED", "EXPIRED", "RECOVERY_REQUIRED"]);

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isoDate(clock) {
  return new Date(clock()).toISOString();
}

function transactionError(code, message) {
  return new QhkeyPlatformError(code, message);
}

function errorCode(error, fallback = "QHKEY_PUBLISH_FAILED") {
  const code = String(error?.code ?? "").trim();
  return code.startsWith("QHKEY_") ? code : fallback;
}

function publicMessage(code) {
  const messages = {
    QHKEY_VOLUME_MISSING: "The selected QHKEY volume is not available.",
    QHKEY_VOLUME_AMBIGUOUS: "More than one QHKEY volume matches the request.",
    QHKEY_VOLUME_IDENTITY_CHANGED: "The selected QHKEY volume identity changed.",
    QHKEY_VOLUME_PERMISSION_DENIED: "The selected QHKEY volume cannot be written safely.",
    QHKEY_MASTER_PROVISIONING_REQUIRED: "The QHKEY master key must be provisioned first.",
    QHKEY_AUTHORIZATION_REQUIRED: "Operating-system administrator authorization is required.",
    QHKEY_AUTHORIZATION_CANCELLED: "QHKEY replacement authorization was cancelled.",
    QHKEY_TRANSACTION_EXPIRED: "The QHKEY replacement transaction expired.",
    QHKEY_TARGET_CHANGED: "The QHKEY target changed after the transaction was prepared.",
    QHKEY_PUBLISH_FAILED: "The QHKEY replacement could not be published.",
    QHKEY_PUBLISH_RECOVERY_REQUIRED: "The QHKEY publish result requires operator recovery.",
  };
  return messages[code] ?? messages.QHKEY_PUBLISH_FAILED;
}

function providerCredentialKind(provider) {
  return provider === "COUPANG" ? "COUPANG_OPEN_API" : "LOGEN_OPEN_API";
}

function resolveStateRoot(value) {
  const stateRoot = path.resolve(String(value ?? ""));
  if (!String(value ?? "").trim() || !path.isAbsolute(stateRoot)) {
    throw new TypeError("An absolute QHKEY transaction state root is required.");
  }
  return stateRoot;
}

function recordPaths(stateRoot, transactionId) {
  const id = assertQhkeyTransactionId(transactionId);
  return Object.freeze({
    record: path.join(stateRoot, `${id}.json`),
    stage: path.join(stateRoot, `${id}.stage`),
    lock: path.join(stateRoot, `${id}.lock`),
  });
}

async function fileHash(fileSystem, filePath, { allowMissing = false } = {}) {
  try {
    const stat = await fileSystem.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STAGE_BYTES) {
      throw transactionError("QHKEY_TARGET_CHANGED", "The QHKEY target is not a bounded regular file.");
    }
    return hashBuffer(await fileSystem.readFile(filePath));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return MISSING_HASH;
    throw error;
  }
}

function validateRecordShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== TRANSACTION_VERSION) {
    throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY transaction record is invalid.");
  }
  const transactionId = assertQhkeyTransactionId(value.transactionId);
  const provider = assertQhkeyProvider(value.provider);
  const state = assertQhkeyReplacementState(value.state);
  const relativePath = qhkeyProviderRelativePath(provider);
  if (value.relativePath !== relativePath || !/^[a-f0-9]{64}$/u.test(String(value.newPayloadHash ?? ""))) {
    throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY transaction record is invalid.");
  }
  if (value.oldTargetHash !== MISSING_HASH && !/^[a-f0-9]{64}$/u.test(String(value.oldTargetHash ?? ""))) {
    throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY transaction target hash is invalid.");
  }
  const volume = createQhkeyVolumeIdentity(value.volume);
  const createdAtMs = Date.parse(String(value.createdAt ?? ""));
  const authorizationExpiresAtMs = Date.parse(String(value.authorizationExpiresAt ?? ""));
  if (
    typeof value.requireProtectedVolume !== "boolean" ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(authorizationExpiresAtMs) ||
    authorizationExpiresAtMs <= createdAtMs
  ) {
    throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY transaction time boundary is invalid.");
  }
  return {
    ...value,
    transactionId,
    provider,
    state,
    volume,
    relativePath,
  };
}

function createQhkeyReplacementServiceOptions(options) {
  const dataDir = String(options.dataDir ?? "").trim();
  const platformComposition =
    options.masterKeyProvider && options.volumeProvider
      ? null
      : composeServerPlatform({ platform: options.platform });
  return {
    dataDir,
    platform: options.platform ?? platformComposition?.platform,
    masterKeyProvider: options.masterKeyProvider ?? platformComposition.qhkeyMasterKey,
    volumeProvider: options.volumeProvider ?? platformComposition.removableVolume,
  };
}

export function createQhkeyReplacementService(options = {}) {
  const composed = createQhkeyReplacementServiceOptions(options);
  if (!composed.dataDir || !path.isAbsolute(composed.dataDir)) {
    throw new TypeError("An absolute QuickHack data directory is required.");
  }
  const platform = composed.platform;
  if (platform !== "win32" && platform !== "linux") {
    throw new TypeError("QHKEY replacement supports Windows and Linux only.");
  }
  const stateRoot = resolveStateRoot(
    options.stateRoot ?? path.join(composed.dataDir, "state", "qhkey-replacements")
  );
  const fileSystem = options.fileSystem ?? fsPromises;
  const clock = options.clock ?? Date.now;
  const randomUUID = options.randomUUID ?? crypto.randomUUID;
  const getUid = options.getUid ?? (() => (typeof process.getuid === "function" ? process.getuid() : null));
  const getGid = options.getGid ?? (() => (typeof process.getgid === "function" ? process.getgid() : null));
  const invalidateCredentialState =
    options.invalidateCredentialState ?? clearAllQhkeyCredentialStateCaches;
  const syncDirectory = options.syncDirectory ?? (async (directoryPath) => {
    const directoryHandle = await fileSystem.open(directoryPath, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  });
  const transactionTtlMs = Number(options.transactionTtlMs ?? DEFAULT_TRANSACTION_TTL_MS);
  const lockStaleMs = Number(options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);
  const enforcePosixSecurity = options.enforcePosixSecurity ?? platform === "linux";

  if (!Number.isSafeInteger(transactionTtlMs) || transactionTtlMs < 1000 || transactionTtlMs > 60 * 60 * 1000) {
    throw new TypeError("QHKEY transaction TTL is invalid.");
  }
  if (!Number.isSafeInteger(lockStaleMs) || lockStaleMs < 1000 || lockStaleMs > 10 * 60 * 1000) {
    throw new TypeError("QHKEY transaction lock timeout is invalid.");
  }

  async function ensureStateRoot() {
    await fileSystem.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const stat = await fileSystem.lstat(stateRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY transaction state root is invalid.");
    }
    if (enforcePosixSecurity && Number.isInteger(stat.mode) && (stat.mode & 0o077) !== 0) {
      throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY transaction state root permissions are invalid.");
    }
  }

  async function writeAtomic(filePath, payload, owner = {}) {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fileSystem.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      if (enforcePosixSecurity && Number.isInteger(owner.uid) && typeof handle.chown === "function") {
        await handle.chown(owner.uid, Number.isInteger(owner.gid) ? owner.gid : owner.uid);
      }
      await handle.close();
      handle = null;
      await fileSystem.rename(temporaryPath, filePath);
      await syncDirectory(path.dirname(filePath));
    } catch (error) {
      await handle?.close?.().catch(() => undefined);
      await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function writeRecord(record, { exclusive = false } = {}) {
    const files = recordPaths(stateRoot, record.transactionId);
    const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (payload.length > MAX_RECORD_BYTES) {
      throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY transaction record is too large.");
    }
    if (exclusive) {
      const handle = await fileSystem.open(files.record, "wx", 0o600);
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(path.dirname(files.record));
    } else {
      await writeAtomic(files.record, payload, {
        uid: record.ownerUid,
        gid: record.ownerGid,
      });
    }
  }

  async function readSecureFile(filePath, label, maxBytes, expectedOwnerUid) {
    const stat = await fileSystem.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
      throw transactionError("QHKEY_PUBLISH_FAILED", `${label} is invalid.`);
    }
    if (enforcePosixSecurity) {
      if (Number.isInteger(stat.mode) && (stat.mode & 0o077) !== 0) {
        throw transactionError("QHKEY_PUBLISH_FAILED", `${label} permissions are invalid.`);
      }
      if (Number.isInteger(expectedOwnerUid) && Number.isInteger(stat.uid) && stat.uid !== expectedOwnerUid) {
        throw transactionError("QHKEY_PUBLISH_FAILED", `${label} ownership is invalid.`);
      }
    }
    return fileSystem.readFile(filePath);
  }

  async function readRecord(transactionId) {
    const files = recordPaths(stateRoot, transactionId);
    let initial;
    try {
      initial = await readSecureFile(files.record, "QHKEY transaction record", MAX_RECORD_BYTES);
      const parsed = validateRecordShape(JSON.parse(initial.toString("utf8")));
      if (enforcePosixSecurity) {
        const stat = await fileSystem.lstat(files.record);
        if (Number.isInteger(parsed.ownerUid) && Number.isInteger(stat.uid) && stat.uid !== parsed.ownerUid) {
          throw transactionError("QHKEY_PUBLISH_FAILED", "QHKEY transaction record ownership changed.");
        }
      }
      return parsed;
    } catch (error) {
      if (error instanceof QhkeyPlatformError) throw error;
      throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY transaction record could not be read.");
    } finally {
      initial?.fill(0);
    }
  }

  async function stagePayload(record) {
    const files = recordPaths(stateRoot, record.transactionId);
    const payload = await readSecureFile(
      files.stage,
      "QHKEY encrypted stage",
      MAX_STAGE_BYTES,
      record.ownerUid
    );
    if (hashBuffer(payload) !== record.newPayloadHash) {
      payload.fill(0);
      throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY encrypted stage hash changed.");
    }
    return payload;
  }

  async function terminal(record, state, code = "", message = "") {
    const updated = {
      ...record,
      state,
      updatedAt: isoDate(clock),
      errorCode: code,
      message: message || (code ? publicMessage(code) : ""),
    };
    await writeRecord(updated);
    if (TERMINAL_STATES.has(state)) {
      await fileSystem.rm(recordPaths(stateRoot, record.transactionId).stage, { force: true }).catch(() => undefined);
    }
    return updated;
  }

  async function withTransactionLock(transactionId, action) {
    const files = recordPaths(stateRoot, transactionId);
    return withExclusiveLock(files.lock, action);
  }

  async function acquireExclusiveLock(lockPath) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await fileSystem.open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let stale = false;
        try {
          const stat = await fileSystem.lstat(lockPath);
          stale = Number.isFinite(stat.mtimeMs) && Date.now() - stat.mtimeMs >= lockStaleMs;
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        if (!stale || attempt > 0) return null;
        await fileSystem.rm(lockPath, { force: true });
      }
    }
    return null;
  }

  async function tryWithExclusiveLock(lockPath, action) {
    const lock = await acquireExclusiveLock(lockPath);
    if (!lock) return Object.freeze({ acquired: false });
    try {
      return Object.freeze({ acquired: true, value: await action() });
    } finally {
      await lock.close().catch(() => undefined);
      await fileSystem.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  async function withExclusiveLock(lockPath, action) {
    const result = await tryWithExclusiveLock(lockPath, action);
    if (!result.acquired) {
      throw transactionError("QHKEY_PUBLISH_FAILED", "The QHKEY transaction is already active.");
    }
    return result.value;
  }

  function preparationLockPath(provider, volumeId) {
    const identityHash = hashBuffer(Buffer.from(`${provider}\0${volumeId}`, "utf8"));
    return path.join(stateRoot, `prepare-${identityHash}.lock`);
  }

  async function expireIfRequired(record) {
    if (ACTIVE_STATES.has(record.state) && clock() >= Date.parse(record.authorizationExpiresAt)) {
      return terminal(record, "EXPIRED", "QHKEY_TRANSACTION_EXPIRED");
    }
    return record;
  }

  async function inspectTransaction(transactionId) {
    const id = assertQhkeyTransactionId(transactionId);
    const initial = await readRecord(id);
    const inspected = await tryWithExclusiveLock(recordPaths(stateRoot, id).lock, async () => {
      let record = await readRecord(id);
      if (record.state === "PUBLISHING") return reconcile(record);
      record = await expireIfRequired(record);
      return record;
    });
    return inspected.acquired ? inspected.value : initial;
  }

  async function activeTransaction(provider, volumeId) {
    await ensureStateRoot();
    const names = await fileSystem.readdir(stateRoot);
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/u.test(name)) continue;
      const record = await inspectTransaction(name.slice(0, -5));
      if (record.provider === provider && record.volume.volumeId === volumeId && ACTIVE_STATES.has(record.state)) {
        return record;
      }
    }
    return null;
  }

  async function prepareReplacement(input) {
    await ensureStateRoot();
    const provider = assertQhkeyProvider(input.provider);
    const volume = await composed.volumeProvider.locate({
      volumeId: input.volumeId,
      rootPath: input.rootPath,
      requireWritable: true,
      production: Boolean(input.production),
    });
    if (volume.readOnly) {
      throw transactionError("QHKEY_VOLUME_PERMISSION_DENIED", "The selected QHKEY volume is read-only.");
    }
    return withExclusiveLock(preparationLockPath(provider, volume.volumeId), async () => {
      const duplicate = await activeTransaction(provider, volume.volumeId);
      if (duplicate) return publicQhkeyReplacement(duplicate);

      const relativePath = qhkeyProviderRelativePath(provider);
      const targetPath = path.join(volume.rootPath, relativePath);
      const oldTargetHash = await fileHash(fileSystem, targetPath, { allowMissing: true });
      if (oldTargetHash !== MISSING_HASH && !input.replaceExisting) {
        throw transactionError("QHKEY_TARGET_CHANGED", "Existing QHKEY replacement confirmation is required.");
      }
      const masterKey = await composed.masterKeyProvider.read({ dataDir: composed.dataDir });
      let encrypted;
      try {
        encrypted = createEncryptedQhkey({
          masterKey,
          credentialKind: providerCredentialKind(provider),
          environment: input.environment,
          keyAlias: input.keyAlias,
          credential: input.credential,
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
        });
        const verified = decryptQhkeyBuffer(encrypted.buffer, masterKey);
        const metadata = readQhkeyMetadataBuffer(encrypted.buffer);
        if (
          verified.metadata.keyFingerprint !== encrypted.metadata.keyFingerprint ||
          metadata.keyFingerprint !== encrypted.metadata.keyFingerprint
        ) {
          throw transactionError("QHKEY_PUBLISH_FAILED", "The encrypted QHKEY self-check failed.");
        }
      } finally {
        masterKey.fill(0);
      }

      const transactionId = randomUUID();
      assertQhkeyTransactionId(transactionId);
      const files = recordPaths(stateRoot, transactionId);
      const now = clock();
      const ownerUid = getUid();
      const ownerGid = getGid();
      const record = {
        version: TRANSACTION_VERSION,
        transactionId,
        provider,
        relativePath,
        volume,
        requireProtectedVolume: Boolean(input.production),
        oldTargetHash,
        newPayloadHash: hashBuffer(encrypted.buffer),
        payloadBytes: encrypted.buffer.length,
        state: platform === "linux" ? "AUTHORIZATION_REQUIRED" : "PREPARED",
        keyAlias: encrypted.metadata.keyAlias,
        keyFingerprint: encrypted.metadata.keyFingerprint,
        expiresAt: encrypted.metadata.expiresAt,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        authorizationExpiresAt: new Date(now + transactionTtlMs).toISOString(),
        ownerUid,
        ownerGid,
        errorCode: "",
        message: "",
      };
      let stageHandle;
      try {
        stageHandle = await fileSystem.open(files.stage, "wx", 0o600);
        await stageHandle.writeFile(encrypted.buffer);
        await stageHandle.sync();
        await stageHandle.close();
        stageHandle = null;
        await writeRecord(record, { exclusive: true });
      } catch (error) {
        await stageHandle?.close?.().catch(() => undefined);
        await fileSystem.rm(files.stage, { force: true }).catch(() => undefined);
        await fileSystem.rm(files.record, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        encrypted.buffer.fill(0);
      }

      if (platform === "win32") return publishReplacement(transactionId, { requireRoot: false });
      return publicQhkeyReplacement(record);
    });
  }

  async function reconcile(record) {
    const targetPath = path.join(record.volume.rootPath, record.relativePath);
    let currentHash;
    try {
      currentHash = await fileHash(fileSystem, targetPath, { allowMissing: true });
    } catch {
      currentHash = "UNKNOWN";
    }
    if (currentHash === record.newPayloadHash) {
      const published = await terminal(record, "PUBLISHED");
      invalidateCredentialState(record.provider);
      return published;
    }
    if (currentHash === record.oldTargetHash) {
      return terminal(record, "FAILED", "QHKEY_PUBLISH_FAILED");
    }
    return terminal(record, "RECOVERY_REQUIRED", "QHKEY_PUBLISH_RECOVERY_REQUIRED");
  }

  async function publishReplacement(transactionId, publishOptions = {}) {
    await ensureStateRoot();
    const id = assertQhkeyTransactionId(transactionId);
    return withTransactionLock(id, async () => {
      let record = await expireIfRequired(await readRecord(id));
      if (TERMINAL_STATES.has(record.state)) return publicQhkeyReplacement(record);
      if (record.state === "PUBLISHING") return publicQhkeyReplacement(await reconcile(record));
      if (platform === "linux" && publishOptions.requireRoot !== false) {
        const uid = publishOptions.uid ?? getUid();
        if (uid !== 0) {
          throw transactionError("QHKEY_AUTHORIZATION_REQUIRED", "Operating-system administrator authorization is required.");
        }
      }

      const payload = await stagePayload(record);
      const targetPath = path.join(record.volume.rootPath, record.relativePath);
      const targetDirectory = path.dirname(targetPath);
      const temporaryTarget = path.join(targetDirectory, `.${path.basename(targetPath)}.${id}.tmp`);
      let targetHandle;
      let committed = false;
      try {
        const currentVolume = await composed.volumeProvider.validate(record.volume, {
          production: record.requireProtectedVolume,
        });
        if (currentVolume.readOnly) {
          throw transactionError("QHKEY_VOLUME_PERMISSION_DENIED", "The selected QHKEY volume is read-only.");
        }
        if ((await fileHash(fileSystem, targetPath, { allowMissing: true })) !== record.oldTargetHash) {
          throw transactionError("QHKEY_TARGET_CHANGED", "The QHKEY target changed after preparation.");
        }
        await fileSystem.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
        const rootStat = await fileSystem.lstat(record.volume.rootPath);
        const directoryStat = await fileSystem.lstat(targetDirectory);
        if (
          !rootStat.isDirectory() || rootStat.isSymbolicLink() ||
          !directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
          path.resolve(await fileSystem.realpath(targetDirectory)) !== path.resolve(targetDirectory)
        ) {
          throw transactionError("QHKEY_VOLUME_IDENTITY_CHANGED", "The QHKEY target directory identity changed.");
        }

        record = { ...record, state: "PUBLISHING", updatedAt: isoDate(clock) };
        await writeRecord(record);
        targetHandle = await fileSystem.open(temporaryTarget, "wx", 0o600);
        await targetHandle.writeFile(payload);
        await targetHandle.sync();
        await targetHandle.close();
        targetHandle = null;
        await composed.volumeProvider.validate(record.volume, {
          production: record.requireProtectedVolume,
        });
        const currentDirectoryStat = await fileSystem.lstat(targetDirectory);
        if (
          !currentDirectoryStat.isDirectory() ||
          currentDirectoryStat.isSymbolicLink() ||
          path.resolve(await fileSystem.realpath(targetDirectory)) !== path.resolve(targetDirectory)
        ) {
          throw transactionError(
            "QHKEY_VOLUME_IDENTITY_CHANGED",
            "The QHKEY target directory identity changed before publish."
          );
        }
        if ((await fileHash(fileSystem, temporaryTarget)) !== record.newPayloadHash) {
          throw transactionError("QHKEY_TARGET_CHANGED", "The QHKEY temporary target changed before publish.");
        }
        if ((await fileHash(fileSystem, targetPath, { allowMissing: true })) !== record.oldTargetHash) {
          throw transactionError("QHKEY_TARGET_CHANGED", "The QHKEY target changed before publish.");
        }
        await fileSystem.rename(temporaryTarget, targetPath);
        committed = true;
        if (platform === "linux") {
          await syncDirectory(targetDirectory);
        }
        if ((await fileHash(fileSystem, targetPath)) !== record.newPayloadHash) {
          throw transactionError(
            "QHKEY_PUBLISH_RECOVERY_REQUIRED",
            "The published QHKEY payload could not be verified."
          );
        }
        record = await terminal(record, "PUBLISHED");
        invalidateCredentialState(record.provider);
        return publicQhkeyReplacement(record);
      } catch (error) {
        await targetHandle?.close?.().catch(() => undefined);
        await fileSystem.rm(temporaryTarget, { force: true }).catch(() => undefined);
        if (committed) {
          return publicQhkeyReplacement(await reconcile(record));
        }
        const code = errorCode(error);
        record = await terminal(record, "FAILED", code, publicMessage(code));
        return publicQhkeyReplacement(record);
      } finally {
        payload.fill(0);
      }
    });
  }

  async function replacementStatus(transactionId) {
    await ensureStateRoot();
    return publicQhkeyReplacement(await inspectTransaction(transactionId));
  }

  async function cancelReplacement(transactionId) {
    await ensureStateRoot();
    const id = assertQhkeyTransactionId(transactionId);
    return withTransactionLock(id, async () => {
      let record = await expireIfRequired(await readRecord(id));
      if (TERMINAL_STATES.has(record.state)) return publicQhkeyReplacement(record);
      if (record.state === "PUBLISHING") return publicQhkeyReplacement(await reconcile(record));
      record = await terminal(record, "CANCELLED", "QHKEY_AUTHORIZATION_CANCELLED");
      return publicQhkeyReplacement(record);
    });
  }

  return Object.freeze({
    platform,
    stateRoot,
    prepareReplacement,
    publishReplacement,
    replacementStatus,
    cancelReplacement,
  });
}
