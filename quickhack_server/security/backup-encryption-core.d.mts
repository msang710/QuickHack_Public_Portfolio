export const ENCRYPTED_BACKUP_MAGIC: Buffer;
export const BACKUP_ENCRYPTION_ALGORITHM: "aes-256-gcm";
export const BACKUP_ENCRYPTION_KEY_BYTES: 32;

export function isEncryptedBackupFileName(fileName: string): boolean;
export function isEncryptedBackupFile(filePath: string): Promise<boolean>;
export function encryptBackupFile(
  inputPath: string,
  outputPath: string,
  encryptionKey: Buffer
): Promise<void>;
export function decryptBackupFile(
  inputPath: string,
  outputPath: string,
  encryptionKey: Buffer
): Promise<void>;
