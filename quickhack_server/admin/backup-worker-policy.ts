export const BACKUP_CONSOLE_WORKER = {
  automaticBackup: "database-auto-backup",
  retentionAndIntegrity: "backup-retention-and-integrity",
} as const;

export const BACKUP_CONSOLE_WORKER_KEYS = [
  BACKUP_CONSOLE_WORKER.automaticBackup,
  BACKUP_CONSOLE_WORKER.retentionAndIntegrity,
] as const;

export type BackupConsoleWorkerKey =
  (typeof BACKUP_CONSOLE_WORKER_KEYS)[number];

export const WORKER_MANAGEMENT_SURFACE = {
  quickHackClient: "QUICKHACK_CLIENT",
  serverConsole: "SERVER_CONSOLE",
} as const;

export type WorkerManagementSurface =
  (typeof WORKER_MANAGEMENT_SURFACE)[keyof typeof WORKER_MANAGEMENT_SURFACE];

export function isBackupConsoleWorkerKey(
  value: unknown
): value is BackupConsoleWorkerKey {
  return BACKUP_CONSOLE_WORKER_KEYS.includes(
    String(value ?? "") as BackupConsoleWorkerKey
  );
}

export function workerManagementSurface(
  workerKey: string
): WorkerManagementSurface {
  return isBackupConsoleWorkerKey(workerKey)
    ? WORKER_MANAGEMENT_SURFACE.serverConsole
    : WORKER_MANAGEMENT_SURFACE.quickHackClient;
}
