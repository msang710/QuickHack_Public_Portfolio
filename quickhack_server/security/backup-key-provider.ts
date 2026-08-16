import path from "node:path";
import {
  createBackupKeyProvider,
  type BackupKeyStatus,
} from "@/quickhack_server/security/backup-key-provider-core.mjs";
import { getServerSecretProtector } from "@/quickhack_server/platform/server-runtime";
import { getDataDir } from "@/quickhack_shared/core/runtime";

function backupDirectory() {
  return path.join(getDataDir(), "backups");
}

const backupKeyProvider = createBackupKeyProvider({
  dataDir: getDataDir(),
  backupDirectory: backupDirectory(),
  secretProtector: getServerSecretProtector(),
});

export function getBackupKeyStatus(): Promise<BackupKeyStatus> {
  return backupKeyProvider.getStatus();
}

export function withBackupEncryptionKey<T>(
  operation: (key: Buffer) => T | Promise<T>
) {
  return backupKeyProvider.withKey(operation);
}
