import {
  BACKUP_ENCRYPTION_ALGORITHM,
  decryptBackupFile as decryptBackupFileCore,
  encryptBackupFile as encryptBackupFileCore,
  isEncryptedBackupFile as isEncryptedBackupFileCore,
  isEncryptedBackupFileName as isEncryptedBackupFileNameCore,
} from "@/quickhack_server/security/backup-encryption-core.mjs";
import {
  getBackupKeyStatus,
  withBackupEncryptionKey,
} from "@/quickhack_server/security/backup-key-provider";
import type {
  BackupKeyState,
  BackupKeyStatus,
} from "@/quickhack_server/security/backup-key-provider-core.mjs";

export type BackupEncryptionState = {
  state: BackupKeyState;
  configured: boolean;
  enabled: boolean;
  required: true;
  valid: boolean;
  protection: BackupKeyStatus["protection"];
  encryptedBackupCount: number;
  algorithm: typeof BACKUP_ENCRYPTION_ALGORITHM;
  message: string;
};

export async function getBackupEncryptionState(): Promise<BackupEncryptionState> {
  const keyStatus = await getBackupKeyStatus();
  const ready = keyStatus.state === "READY";

  return {
    state: keyStatus.state,
    configured: ready,
    enabled: ready,
    required: true,
    valid: ready,
    protection: keyStatus.protection,
    encryptedBackupCount: keyStatus.encryptedBackupCount,
    algorithm: BACKUP_ENCRYPTION_ALGORITHM,
    message: keyStatus.message,
  };
}

export async function shouldEncryptBackups() {
  const state = await getBackupEncryptionState();

  if (!state.enabled) {
    throw new Error(state.message);
  }

  return true;
}

export function isEncryptedBackupFileName(fileName: string) {
  return isEncryptedBackupFileNameCore(fileName);
}

export async function isEncryptedBackupFile(filePath: string) {
  return isEncryptedBackupFileCore(filePath);
}

export async function encryptBackupFile(inputPath: string, outputPath: string) {
  await withBackupEncryptionKey((key) =>
    encryptBackupFileCore(inputPath, outputPath, key)
  );
}

export async function decryptBackupFile(inputPath: string, outputPath: string) {
  await withBackupEncryptionKey((key) =>
    decryptBackupFileCore(inputPath, outputPath, key)
  );
}
