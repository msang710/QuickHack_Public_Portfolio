export const POSTGRESQL_BACKUP_PROTOCOL: "QUICKHACK_POSTGRESQL_BACKUP_V1";
export const POSTGRESQL_MAJOR_VERSION: 18;
export const POSTGRESQL_BACKUP_QUARANTINE_POLICY: Readonly<{
  retentionMs: number;
  graceMs: number;
  maxBatchSize: number;
  keepLatest: number;
}>;

export class PostgresqlNativeOperationError extends Error {
  readonly code: string;
  readonly details?: unknown;
}

export type PostgresqlNativeProcessExecution = Readonly<{
  postgresqlExecutable(binDirectory: string, tool: string): string;
  childEnvironment(input?: Readonly<{
    source?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    executableDirectories?: readonly string[];
    overrides?: Record<string, string | number | boolean | undefined>;
  }>): NodeJS.ProcessEnv;
}>;

export type NativeToolInput = {
  tool: string;
  args: string[];
  connectionString: string;
  binDirectory: string;
  privateDirectory: string;
  processExecution?: PostgresqlNativeProcessExecution;
  timeoutMs?: number;
};

export type NativeToolResult = {
  stdout: string;
  stderr: string;
};

export type NativeToolRunner = (
  input: NativeToolInput
) => Promise<NativeToolResult>;

export type PostgresqlBackupManifest = {
  protocol: typeof POSTGRESQL_BACKUP_PROTOCOL;
  applicationVersion: string;
  schemaVersion: string;
  postgresqlMajor: typeof POSTGRESQL_MAJOR_VERSION;
  database: string;
  fileName: string;
  createdAt: string;
  encryptedSize: number;
  encryptedSha256: string;
  dumpSha256: string;
};

export type ListedPostgresqlBackup = {
  fileName: string;
  createdAt: string | null;
  sizeBytes: number;
  valid: boolean;
  validationCode: string | null;
  applicationVersion: string | null;
  schemaVersion: string | null;
};

export type PostgresqlBackupRetentionResult = {
  retainedCount: number;
  removed: string[];
};

export type PostgresqlBackupFileTransform = (
  sourcePath: string,
  targetPath: string
) => void | Promise<void>;

export type PostgresqlBackupStorageInput = {
  backupDirectory: string;
  binDirectory: string;
  privateDirectory: string;
  processExecution?: PostgresqlNativeProcessExecution;
};

export type PostgresqlCutoverPhase =
  | "STAGING_READY"
  | "LIVE_RENAMED"
  | "DATABASE_ACTIVATED"
  | "CUTOVER_COMPLETE"
  | "ROLLED_BACK";

export type PostgresqlCutoverState = {
  phase: PostgresqlCutoverPhase;
  liveDatabase: string;
  stagingDatabase: string;
  previousDatabase: string;
  manifest: PostgresqlBackupManifest;
};

export function runPostgresqlTool(
  input: NativeToolInput
): Promise<NativeToolResult>;

export function inspectPostgresqlToolchain(input: {
  binDirectory: string;
  capability?: "service" | "backup" | "package";
  runVersion?: (input: {
    tool: string;
    executable: string;
    processExecution?: PostgresqlNativeProcessExecution;
  }) => string | Promise<string>;
  processExecution: PostgresqlNativeProcessExecution;
}): Promise<Readonly<{
  capability: "service" | "backup" | "package";
  major: 18;
  tools: Readonly<Record<string, number>>;
}>>;

export function listPostgresqlBackups(
  backupDirectory: string
): Promise<ListedPostgresqlBackup[]>;

export function listPostgresqlBackupQuarantines(
  backupDirectory: string
): Promise<Array<{
  protocol: string;
  originalFileName: string;
  reasonCode: string;
  quarantinedAt: string;
  finalDirectoryName: string;
  directoryName: string;
}>>;

export function applyPostgresqlBackupRetention(
  backupDirectory: string,
  retentionCount: number,
  options?: { verifiedFileNames?: readonly string[] }
): Promise<PostgresqlBackupRetentionResult>;

export function createPostgresqlBackup(
  input: PostgresqlBackupStorageInput & {
    connectionString: string;
    applicationVersion: string;
    schemaVersion: string;
    encryptFile: PostgresqlBackupFileTransform;
    runTool?: NativeToolRunner;
    now?: Date;
    operationId?: string;
  }
): Promise<{
  backup: PostgresqlBackupManifest & { path: string };
  observed: boolean;
  prePublicationQuarantined: Array<{
    directory: string;
    protocol: string;
    originalFileName: string;
    reasonCode: string;
    quarantinedAt: string;
    finalDirectoryName: string;
  }>;
}>;

export function cleanupPostgresqlBackupQuarantine(input: {
  backupDirectory: string;
  now?: Date;
  dryRun?: boolean;
  maxBatchSize?: number;
}): Promise<{
  dryRun: boolean;
  cutoffExclusive: Date;
  maxBatchSize: number;
  attemptedCount: number;
  changedCount: number;
  backlogCount: number;
  oldestEligibleAgeMs: number | null;
}>;

export function verifyPostgresqlBackupsAndApplyRetention(
  input: PostgresqlBackupStorageInput & {
    connectionString: string;
    retentionCount: number;
    decryptFile: PostgresqlBackupFileTransform;
    runTool?: NativeToolRunner;
    now?: Date;
    requiredFileName?: string | null;
  }
): Promise<{
  candidateCount: number;
  verifiedCount: number;
  remainingVerifiedCount: number;
  verifiedFileNames: string[];
  quarantinedCount: number;
  quarantined: Array<{
    directory: string;
    protocol: string;
    originalFileName: string;
    reasonCode: string;
    quarantinedAt: string;
    finalDirectoryName: string;
  }>;
  warningCount: number;
  recoveredQuarantineCount: number;
  retention: PostgresqlBackupRetentionResult;
  quarantineCleanup: {
    dryRun: boolean;
    cutoffExclusive: Date;
    maxBatchSize: number;
    attemptedCount: number;
    changedCount: number;
    backlogCount: number;
    oldestEligibleAgeMs: number | null;
  };
}>;

export function withInspectedPostgresqlBackup<TResult>(
  input: PostgresqlBackupStorageInput & {
    fileName: string;
    connectionString: string;
    decryptFile: PostgresqlBackupFileTransform;
    runTool?: NativeToolRunner;
    operation: (input: {
      manifest: PostgresqlBackupManifest;
      restoredDumpPath: string;
    }) => TResult | Promise<TResult>;
  }
): Promise<TResult>;

export function restorePostgresqlBackup<TStagingResult = undefined>(
  input: PostgresqlBackupStorageInput & {
    fileName: string;
    operatorConnectionString: string;
    expectedDatabase: string;
    restoredDatabaseOwner: string;
    expectedApplicationVersion: string;
    expectedSchemaVersion: string;
    decryptFile: PostgresqlBackupFileTransform;
    runTool?: NativeToolRunner;
    onStagingRestored?: (input: Omit<PostgresqlCutoverState, "phase">) =>
      | TStagingResult
      | Promise<TStagingResult>;
    onCutoverPhase?: (
      state: PostgresqlCutoverState
    ) => void | Promise<void>;
  }
): Promise<{
  restored: true;
  fileName: string;
  database: string;
  manifest: PostgresqlBackupManifest;
  stagingResult: TStagingResult | undefined;
}>;
