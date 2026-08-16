export const BACKUP_MASTER_RECOVERY_ENVELOPE_HEADER: "QUICKHACK_BACKUP_MASTER_RECOVERY_V1";
export class BackupMasterRecoveryEnvelopeError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
export function createBackupMasterRecoveryEnvelope(
  backupMasterKey: Buffer,
  passphrase: string | Buffer,
  options?: {
    randomBytes?: (size: number) => Buffer;
    scrypt?: { N: number; r: number; p: number };
  }
): Buffer;
export function openBackupMasterRecoveryEnvelope(
  envelope: Buffer,
  passphrase: string | Buffer
): Buffer;
