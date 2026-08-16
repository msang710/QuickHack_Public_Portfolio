import type { ServerSecretProtector } from "../../../quickhack_server/platform/contracts.ts";
export function createWindowsBackupMasterRecoveryOperator(options: {
  dataDir: string;
  secretProtector?: ServerSecretProtector;
  fileSystem?: Record<string, unknown>;
}): Readonly<{
  provision(key: Buffer): Promise<Readonly<{ state: "ACTIVE"; targetPath: string }>>;
  verify(expectedKey: Buffer): Promise<boolean>;
  targetPath(): string;
}>;
