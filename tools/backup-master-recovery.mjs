import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createBackupMasterRecoveryEnvelope,
  openBackupMasterRecoveryEnvelope,
} from "../quickhack_server/security/backup-master-recovery-envelope.mjs";

const MAX_BUNDLE_BYTES = 16 * 1024;

export class BackupMasterRecoveryOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupMasterRecoveryOperationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BackupMasterRecoveryOperationError(code, message);
}

async function writeNewFileAtomic(destinationPath, payload, fileSystem) {
  const resolved = path.resolve(destinationPath);
  if (!path.isAbsolute(destinationPath)) {
    fail(
      "BACKUP_RECOVERY_DESTINATION_INVALID",
      "The offline recovery destination must be an absolute path."
    );
  }
  const directory = path.dirname(resolved);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const handle = await fileSystem.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fileSystem.link(temporaryPath, resolved);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(
          "BACKUP_RECOVERY_DESTINATION_EXISTS",
          "The offline recovery destination already exists."
        );
      }
      throw error;
    }
  } finally {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return resolved;
}

export async function exportBackupMasterRecoveryBundle(options) {
  const fileSystem = options?.fileSystem ?? fs;
  if (!options?.sourceProvider || typeof options.sourceProvider.withKey !== "function") {
    throw new TypeError("A backup master key provider is required.");
  }
  return options.sourceProvider.withKey(async (key) => {
    let envelope;
    let verified;
    try {
      envelope = createBackupMasterRecoveryEnvelope(key, options.passphrase, {
        randomBytes: options.randomBytes,
        scrypt: options.scrypt,
      });
      verified = openBackupMasterRecoveryEnvelope(envelope, options.passphrase);
      if (!verified.equals(key)) {
        fail(
          "BACKUP_RECOVERY_VERIFY_FAILED",
          "The offline recovery bundle verification failed."
        );
      }
      const destinationPath = await writeNewFileAtomic(
        options.destinationPath,
        envelope,
        fileSystem
      );
      return Object.freeze({
        state: "RECOVERY_BUNDLE_CREATED",
        destinationPath,
      });
    } finally {
      envelope?.fill(0);
      verified?.fill(0);
    }
  });
}

export async function importBackupMasterRecoveryBundle(options) {
  const fileSystem = options?.fileSystem ?? fs;
  if (!options?.operator || typeof options.operator.provision !== "function") {
    throw new TypeError("A backup master recovery operator is required.");
  }
  const sourcePath = path.resolve(options.sourcePath);
  const stat = await fileSystem.lstat(sourcePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > MAX_BUNDLE_BYTES
  ) {
    fail(
      "BACKUP_RECOVERY_SOURCE_INVALID",
      "The offline recovery source is not a valid regular file."
    );
  }
  const envelope = await fileSystem.readFile(sourcePath);
  let key;
  try {
    key = openBackupMasterRecoveryEnvelope(envelope, options.passphrase);
    return await options.operator.provision(key);
  } finally {
    envelope.fill(0);
    key?.fill(0);
  }
}
