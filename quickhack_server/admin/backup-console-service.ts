import path from "node:path";
import { prisma } from "@/quickhack_server/core/prisma";
import type { BackupConsoleWorkerKey } from "@/quickhack_server/admin/backup-worker-policy";
import { BACKUP_CONSOLE_WORKER_KEYS } from "@/quickhack_server/admin/backup-worker-policy";
import {
  inspectOperationalPostgresqlBinDirectory,
  listOperationalPostgresqlBackupQuarantines,
  listOperationalPostgresqlBackups,
} from "@/quickhack_server/admin/postgresql-backup-service";
import { getBackupEncryptionState } from "@/quickhack_server/security/backup-encryption";
import { getWorkerShutdownState } from "@/quickhack_server/workers/shutdown-runtime";
import {
  listWorkerJobs,
  runWorkerJobImmediately,
  updateWorkerSchedule,
} from "@/quickhack_server/workers/worker-jobs";
import {
  getPostgresqlDatabaseConfig,
  getRuntimeConfig,
} from "@/quickhack_shared/core/runtime";
import { POSTGRESQL_MAJOR_VERSION } from "@/quickhack_shared/platform/native-runtime-contract.mjs";

export class BackupConsoleConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "BACKUP_CONSOLE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "BackupConsoleConflictError";
  }
}

export async function readBackupConsoleState() {
  const shutdown = getWorkerShutdownState();
  const database = getPostgresqlDatabaseConfig();
  const runtime = getRuntimeConfig();
  const backupDirectory = path.join(runtime.paths.dataDir, "backups");
  const [encryption, backups, quarantines, allWorkers, recentRuns] = await Promise.all([
    getBackupEncryptionState(),
    listOperationalPostgresqlBackups(),
    listOperationalPostgresqlBackupQuarantines(),
    listWorkerJobs(),
    prisma.server_job_logs.findMany({
      where: { job_type: "WORKER_DATABASE_MAINTENANCE" },
      orderBy: [{ started_at: "desc" }, { id: "desc" }],
      take: 20,
      select: {
        id: true,
        job_type: true,
        status: true,
        started_at: true,
        finished_at: true,
        error_code: true,
        error_message: true,
        summary_text: true,
      },
    }),
  ]);
  let nativeToolsAvailable = true;
  let nativeToolsMessage = `PostgreSQL ${POSTGRESQL_MAJOR_VERSION} native tools are ready.`;
  try {
    await inspectOperationalPostgresqlBinDirectory();
  } catch (error) {
    nativeToolsAvailable = false;
    nativeToolsMessage = error instanceof Error ? error.message : String(error);
  }

  return {
    operationsReady: encryption.enabled && nativeToolsAvailable,
    errorCode:
      encryption.enabled && nativeToolsAvailable
        ? null
        : "POSTGRESQL_OPERATIONS_UNAVAILABLE",
    message: encryption.enabled ? nativeToolsMessage : encryption.message,
    database: {
      provider: "postgresql" as const,
      host: database.host,
      port: database.port,
      name: database.name,
      path: null,
      exists: null,
      sizeBytes: null,
      modifiedAt: null,
    },
    backupDirectory,
    encryption: {
      enabled: encryption.enabled,
      available: encryption.valid,
      message: encryption.message,
    },
    retentionCount: runtime.serverConfig?.backupRetentionCount ?? 30,
    backups,
    quarantines,
    shutdown: {
      requested: shutdown.requested,
      requestedAt: shutdown.requestedAt,
      reason: shutdown.reason,
    },
    workers: allWorkers.filter((worker) =>
      BACKUP_CONSOLE_WORKER_KEYS.includes(
        worker.worker_key as BackupConsoleWorkerKey
      )
    ),
    recentRuns,
  };
}

export async function setBackupWorkerSchedule(input: {
  workerKey: BackupConsoleWorkerKey;
  scheduleEnabled: boolean;
}) {
  await updateWorkerSchedule({
    workerKey: input.workerKey,
    scheduleEnabled: input.scheduleEnabled,
    triggeredBy: null,
  });
  return readBackupConsoleState();
}

export async function runBackupWorkerNow(workerKey: BackupConsoleWorkerKey) {
  const state = await readBackupConsoleState();
  if (!state.operationsReady) {
    throw new BackupConsoleConflictError(state.message);
  }
  const result = await runWorkerJobImmediately(workerKey, null, {
    waitTimeoutMs: 60 * 60_000,
  });
  return { result, state: await readBackupConsoleState() };
}
