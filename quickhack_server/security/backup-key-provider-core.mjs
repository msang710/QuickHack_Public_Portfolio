import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { serverSecretFilePrefix } from "../platform/server-secret-file-format.mjs";
import { serverSecretIdentity } from "../platform/server-secret-identity.mjs";

export const BACKUP_KEY_BYTES = 32;
export const BACKUP_KEY_FILE_NAME = "backup-master.key";

const BACKUP_KEY_FILE_MAX_BYTES = 4_096;

const STATUS_MESSAGES = {
  READY:
    "DB 백업은 서버 실행 계정으로 보호된 서버 소유 키로 암호화됩니다.",
  ENCRYPTED_BACKUPS_REQUIRE_EXISTING_KEY:
    "기존 암호화 DB 백업이 있지만 서버 소유 키를 찾을 수 없어 백업과 복구를 차단했습니다.",
  INVALID_KEY_FILE:
    "서버 소유 DB 백업 키를 현재 Windows 계정으로 열 수 없어 백업과 복구를 차단했습니다.",
  CREATE_FAILED:
    "서버 소유 DB 백업 키를 안전하게 준비하지 못해 백업과 복구를 차단했습니다.",
  UNSUPPORTED_PLATFORM:
    "서버 키 보호 기능을 사용할 수 없어 DB 백업과 복구를 차단했습니다.",
  PROVISIONING_REQUIRED:
    "The backup master credential must be provisioned by an administrator.",
  RECOVERY_BUNDLE_REQUIRED:
    "Existing encrypted backups require the offline backup master recovery bundle.",
};

function isErrorCode(error, code) {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === code
  );
}

function strictBase64Payload(text, filePrefix) {
  if (!text.startsWith(filePrefix) || !text.endsWith("\n")) {
    throw new Error("The DB backup key file format is not recognized.");
  }

  const encoded = text.slice(filePrefix.length, -1);

  if (
    !encoded ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded
    )
  ) {
    throw new Error("The DB backup key file payload is invalid.");
  }

  const payload = Buffer.from(encoded, "base64");

  if (payload.toString("base64") !== encoded) {
    payload.fill(0);
    throw new Error("The DB backup key file payload is not canonical base64.");
  }

  return payload;
}

function status(state, encryptedBackupCount, protection) {
  const ready = state === "READY";

  return {
    state,
    configured: ready,
    protection: ready ? protection : null,
    encryptedBackupCount,
    message: STATUS_MESSAGES[state],
  };
}

export class BackupKeyProviderError extends Error {
  constructor(state, message = STATUS_MESSAGES[state]) {
    super(message);
    this.name = "BackupKeyProviderError";
    this.code = state;
    this.state = state;
  }
}

export function defaultBackupKeyFilePath(dataDir) {
  return path.join(dataDir, "security", BACKUP_KEY_FILE_NAME);
}

export function createBackupKeyProvider(options) {
  const dataDir = path.resolve(String(options?.dataDir || ""));
  const backupDirectory = path.resolve(String(options?.backupDirectory || ""));
  const randomBytes = options?.randomBytes ?? crypto.randomBytes;
  const secretProtector = options?.secretProtector;
  const keyFilePath = defaultBackupKeyFilePath(dataDir);
  let readiness = null;

  if (!options?.dataDir || !options?.backupDirectory) {
    throw new Error("DB backup key provider paths are required.");
  }

  if (
    !secretProtector ||
    typeof secretProtector.protect !== "function" ||
    typeof secretProtector.unprotect !== "function" ||
    typeof secretProtector.ensureDirectory !== "function" ||
    typeof secretProtector.readProvisioned !== "function" ||
    !secretProtector.metadata
  ) {
    throw new Error("DB backup key provider protection dependencies are required.");
  }
  const filePrefix = serverSecretFilePrefix(
    "BACKUP_MASTER_KEY",
    secretProtector.metadata
  );
  const activationMode =
    secretProtector.metadata.lifecycle === "ACTIVATION_CREDENTIAL";
  const identity = serverSecretIdentity({ kind: "BACKUP_MASTER_KEY" });

  async function encryptedBackupCount() {
    let entries;

    try {
      entries = await fs.readdir(backupDirectory, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return 0;
      }
      throw error;
    }

    return entries.filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".qhb")
    ).length;
  }

  async function readKeyFile() {
    const fileStats = await fs.lstat(keyFilePath);

    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      throw new Error("The DB backup key path is not a regular file.");
    }

    if (fileStats.size <= 0 || fileStats.size > BACKUP_KEY_FILE_MAX_BYTES) {
      throw new Error("The DB backup key file size is invalid.");
    }

    const filePayload = await fs.readFile(keyFilePath);
    let protectedPayload = null;

    try {
      protectedPayload = strictBase64Payload(filePayload.toString("utf8"), filePrefix);
      const key = await secretProtector.unprotect(
        "BACKUP_MASTER_KEY",
        protectedPayload
      );

      if (!Buffer.isBuffer(key) || key.length !== BACKUP_KEY_BYTES) {
        if (Buffer.isBuffer(key)) {
          key.fill(0);
        }
        throw new Error("The unprotected DB backup key length is invalid.");
      }

      return key;
    } finally {
      filePayload.fill(0);
      protectedPayload?.fill(0);
    }
  }

  async function readExistingKey() {
    if (activationMode) {
      const key = await secretProtector.readProvisioned(identity);
      if (!Buffer.isBuffer(key) || key.length !== BACKUP_KEY_BYTES) {
        if (Buffer.isBuffer(key)) key.fill(0);
        throw new Error("The provisioned DB backup key length is invalid.");
      }
      return key;
    }
    try {
      return await readKeyFile();
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  }

  async function createKeyFile() {
    if (activationMode) {
      throw new BackupKeyProviderError("PROVISIONING_REQUIRED");
    }
    const directoryPath = path.dirname(keyFilePath);
    await secretProtector.ensureDirectory(directoryPath);

    const candidateKey = randomBytes(BACKUP_KEY_BYTES);
    let protectedPayload = null;
    let filePayload = null;
    const temporaryPath = path.join(
      directoryPath,
      `.${BACKUP_KEY_FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`
    );

    try {
      if (!Buffer.isBuffer(candidateKey) || candidateKey.length !== BACKUP_KEY_BYTES) {
        throw new Error("The DB backup key generator returned an invalid key length.");
      }

      protectedPayload = await secretProtector.protect(
        "BACKUP_MASTER_KEY",
        candidateKey
      );

      if (!Buffer.isBuffer(protectedPayload) || protectedPayload.length === 0) {
        throw new Error("The DB backup key protector returned an invalid payload.");
      }

      filePayload = Buffer.from(
        `${filePrefix}${protectedPayload.toString("base64")}\n`,
        "utf8"
      );
      const handle = await fs.open(temporaryPath, "wx", 0o600);

      try {
        await handle.writeFile(filePayload);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await fs.link(temporaryPath, keyFilePath);
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
          throw error;
        }
      }

      const publishedKey = await readKeyFile();
      publishedKey.fill(0);
    } finally {
      if (Buffer.isBuffer(candidateKey)) {
        candidateKey.fill(0);
      }
      protectedPayload?.fill(0);
      filePayload?.fill(0);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async function ensureReadyInternal() {
    if (secretProtector.descriptor.state !== "READY") {
      return status("UNSUPPORTED_PLATFORM", 0, null);
    }

    let backupCount;

    try {
      backupCount = await encryptedBackupCount();
    } catch {
      return status("CREATE_FAILED", 0, null);
    }

    try {
      const existingKey = await readExistingKey();

      if (existingKey) {
        existingKey.fill(0);
        return status("READY", backupCount, secretProtector.metadata.protection);
      }
    } catch (error) {
      if (
        activationMode &&
        isErrorCode(error, "SERVER_SECRET_PROVISIONING_REQUIRED")
      ) {
        return status(
          backupCount > 0
            ? "RECOVERY_BUNDLE_REQUIRED"
            : "PROVISIONING_REQUIRED",
          backupCount,
          null
        );
      }
      return status("INVALID_KEY_FILE", backupCount, null);
    }

    if (backupCount > 0) {
      return status("ENCRYPTED_BACKUPS_REQUIRE_EXISTING_KEY", backupCount, null);
    }

    if (activationMode) {
      return status("PROVISIONING_REQUIRED", 0, null);
    }

    try {
      await createKeyFile();
      return status("READY", 0, secretProtector.metadata.protection);
    } catch {
      return status("CREATE_FAILED", 0, null);
    }
  }

  function ensureReady() {
    if (!readiness) {
      readiness = ensureReadyInternal().finally(() => {
        readiness = null;
      });
    }
    return readiness;
  }

  async function getStatus() {
    return ensureReady();
  }

  async function withKey(operation) {
    let key;

    try {
      key =
        secretProtector.descriptor.state === "READY"
          ? await readExistingKey()
          : null;
    } catch {
      if (!activationMode) {
        throw new BackupKeyProviderError("INVALID_KEY_FILE");
      }
    }

    if (!key) {
      const currentStatus = await ensureReady();

      if (currentStatus.state !== "READY") {
        throw new BackupKeyProviderError(currentStatus.state, currentStatus.message);
      }

      try {
        key = activationMode
          ? await readExistingKey()
          : await readKeyFile();
      } catch {
        throw new BackupKeyProviderError("INVALID_KEY_FILE");
      }
    }

    try {
      return await operation(key);
    } finally {
      key.fill(0);
    }
  }

  return {
    getStatus,
    keyFilePath: () => keyFilePath,
    withKey,
  };
}
