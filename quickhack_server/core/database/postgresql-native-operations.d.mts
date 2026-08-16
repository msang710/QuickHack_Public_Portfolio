export const POSTGRESQL_BACKUP_PROTOCOL: "QUICKHACK_POSTGRESQL_BACKUP_V1";
export const POSTGRESQL_MAJOR_VERSION: 18;

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

export function applyPostgresqlBackupRetention(
  backupDirectory: string,
  retentionCount: number
): Promise<PostgresqlBackupRetentionResult>;

export function createPostgresqlBackup(
  input: PostgresqlBackupStorageInput & {
    connectionString: string;
    applicationVersion: string;
    schemaVersion: string;
    encryptFile: PostgresqlBackupFileTransform;
    runTool?: NativeToolRunner;
    now?: Date;
  }
): Promise<{
  backup: PostgresqlBackupManifest & { path: string };
}>;

export function verifyPostgresqlBackupsAndApplyRetention(
  input: PostgresqlBackupStorageInput & {
    connectionString: string;
    retentionCount: number;
    decryptFile: PostgresqlBackupFileTransform;
    runTool?: NativeToolRunner;
  }
): Promise<{
  candidateCount: number;
  verifiedCount: number;
  retention: PostgresqlBackupRetentionResult;
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
