export class BackupMasterRecoveryOperationError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
export function exportBackupMasterRecoveryBundle(options: {
  sourceProvider: { withKey<T>(operation: (key: Buffer) => Promise<T>): Promise<T> };
  passphrase: string | Buffer;
  destinationPath: string;
  randomBytes?: (size: number) => Buffer;
  scrypt?: { N: number; r: number; p: number };
  fileSystem?: Record<string, unknown>;
}): Promise<Readonly<{
  state: "RECOVERY_BUNDLE_CREATED";
  destinationPath: string;
}>>;
export function importBackupMasterRecoveryBundle<T>(options: {
  sourcePath: string;
  passphrase: string | Buffer;
  operator: { provision(key: Buffer): Promise<T> };
  fileSystem?: Record<string, unknown>;
}): Promise<T>;
