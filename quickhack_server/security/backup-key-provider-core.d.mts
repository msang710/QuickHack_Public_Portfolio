export const BACKUP_KEY_BYTES: 32;
export const BACKUP_KEY_FILE_NAME: "backup-master.key";
import type { ServerSecretProtector } from "../platform/contracts.ts";

export type BackupKeyState =
  | "READY"
  | "ENCRYPTED_BACKUPS_REQUIRE_EXISTING_KEY"
  | "INVALID_KEY_FILE"
  | "CREATE_FAILED"
  | "PROVISIONING_REQUIRED"
  | "RECOVERY_BUNDLE_REQUIRED"
  | "UNSUPPORTED_PLATFORM";

export type BackupKeyStatus = {
  state: BackupKeyState;
  configured: boolean;
  protection: string | null;
  encryptedBackupCount: number;
  message: string;
};

export class BackupKeyProviderError extends Error {
  code: BackupKeyState;
  state: BackupKeyState;
  constructor(state: BackupKeyState, message?: string);
}

export function defaultBackupKeyFilePath(dataDir: string): string;

export type BackupKeyProvider = {
  getStatus(): Promise<BackupKeyStatus>;
  keyFilePath(): string;
  withKey<T>(operation: (key: Buffer) => T | Promise<T>): Promise<T>;
};

export function createBackupKeyProvider(options: {
  dataDir: string;
  backupDirectory: string;
  randomBytes?: (size: number) => Buffer;
  secretProtector: ServerSecretProtector;
}): BackupKeyProvider;
