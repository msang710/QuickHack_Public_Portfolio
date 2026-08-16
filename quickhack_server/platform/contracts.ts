export const SERVER_PLATFORM_CAPABILITIES = [
  "runtime-directories",
  "process-execution",
  "server-secret-protector",
  "qhkey-master-key-provider",
  "removable-volume-provider",
  "postgresql-service-controller",
] as const;

export type ServerPlatformCapabilityId =
  (typeof SERVER_PLATFORM_CAPABILITIES)[number];

export type PlatformCapabilityDescriptor = Readonly<{
  id: ServerPlatformCapabilityId;
  role: "server";
  platform: string;
  state: "READY" | "COMPATIBILITY" | "UNAVAILABLE";
  ownerStage: "PR-04" | "PR-05" | "PR-06" | "PR-08" | "PR-09";
}>;

export type RuntimeDirectorySnapshot = Readonly<{
  appRoot: string;
  runtimeDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
  logDir: string;
  cacheDir: string;
  secretDir: string;
  artifactDir: string;
}>;

export type RuntimeDirectories = Readonly<{
  descriptor: PlatformCapabilityDescriptor;
  resolve(input: Readonly<{
    appRoot: string;
    runtimeDir?: string;
    dataDirectory?: string;
    homeDirectory?: string;
    deployment?: "development" | "system-service";
    artifactKind?: "DEMONSTRATION_SERVER" | "OPERATIONAL_SERVER";
    environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  }>): RuntimeDirectorySnapshot;
}>;

export type PostgresqlToolKey =
  | "initdb"
  | "pg_ctl"
  | "postgres"
  | "psql"
  | "pg_dump"
  | "pg_restore";

export type ServerProcessExecution = Readonly<{
  descriptor: PlatformCapabilityDescriptor;
  postgresqlBinDirectories(input: Readonly<{
    appRoot: string;
    nodeExecutable: string;
    environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    majorVersion: number;
    deployment?: "development" | "system-service";
  }>): readonly string[];
  postgresqlExecutable(binDirectory: string, tool: PostgresqlToolKey): string;
  childEnvironment(input?: Readonly<{
    source?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    executableDirectories?: readonly string[];
    overrides?: Record<string, string | number | boolean | undefined>;
  }>): NodeJS.ProcessEnv;
}>;

export type ServerSecretKind =
  | "OTP_MASTER_KEY"
  | "BACKUP_MASTER_KEY"
  | "POSTGRESQL_CREDENTIAL"
  | "MOBILE_SERIAL_HMAC"
  | "QHKEY_MASTER_KEY";

export type ServerSecretProtectionMetadata = Readonly<{
  protection: string;
  identityScope: string;
  portable: boolean;
  formatVersion: number;
  lifecycle: "OPAQUE_PAYLOAD" | "ACTIVATION_CREDENTIAL";
}>;

export type ServerSecretIdentity = Readonly<{
  id: string;
  kind: ServerSecretKind;
  postgresqlRole?: string;
  consumerClass:
    | "LONG_LIVED_APPLICATION"
    | "PRIVILEGED_ONE_SHOT"
    | "DEMONSTRATION_MOCK";
  maxBytes: number;
  generationGuard: string;
  recovery: string;
}>;

export type ServerSecretProtector = Readonly<{
  descriptor: PlatformCapabilityDescriptor;
  metadata: ServerSecretProtectionMetadata;
  protect(kind: ServerSecretKind, secret: Buffer): Promise<Buffer>;
  unprotect(kind: ServerSecretKind, payload: Buffer): Promise<Buffer>;
  unprotectSync(kind: ServerSecretKind, payload: Buffer): Buffer;
  readProvisioned(identity: ServerSecretIdentity): Promise<Buffer>;
  readProvisionedSync(identity: ServerSecretIdentity): Buffer;
  ensureDirectory(directoryPath: string): Promise<void>;
}>;

export type PostgresqlServiceController = Readonly<{
  descriptor: PlatformCapabilityDescriptor;
  install(input: unknown): Promise<unknown>;
  repair(input: unknown): Promise<unknown>;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  restart(): Promise<unknown>;
  status(): Promise<unknown>;
}>;

export type QhkeyMasterKeyStatus = Readonly<{
  available: boolean;
  protection: string;
  warningMessage: string | null;
  identityToken: string;
  identityPaths: readonly string[];
}>;

export type QhkeyMasterKeyProvider = Readonly<{
  descriptor: PlatformCapabilityDescriptor;
  read(input: Readonly<{ dataDir: string }>): Promise<Buffer>;
  readSync(input: Readonly<{ dataDir: string }>): Buffer;
  status(input: Readonly<{ dataDir: string; production?: boolean }>): Promise<QhkeyMasterKeyStatus>;
  ensure(input: Readonly<{
    dataDir: string;
    force?: boolean;
    protection?: string;
    production?: boolean;
  }>): Promise<QhkeyMasterKeyStatus>;
}>;

export type QhkeyVolumeIdentity = Readonly<{
  platform: "win32" | "linux";
  volumeId: string;
  rootPath: string;
  deviceId: string;
  fileSystemUuid: string;
  label: string;
  readOnly: boolean;
  providers: readonly ("COUPANG" | "LOGEN")[];
}>;

export type RemovableVolumeProvider = Readonly<{
  descriptor: PlatformCapabilityDescriptor;
  list(input?: Readonly<{ production?: boolean }>): Promise<readonly QhkeyVolumeIdentity[]>;
  locate(input?: Readonly<{
    volumeId?: string;
    rootPath?: string;
    requireProvider?: "COUPANG" | "LOGEN";
    requireWritable?: boolean;
    production?: boolean;
  }>): Promise<QhkeyVolumeIdentity>;
  validate(
    identity: QhkeyVolumeIdentity,
    input?: Readonly<{ production?: boolean }>
  ): Promise<QhkeyVolumeIdentity>;
}>;

export type ServerPlatformCapabilities = Readonly<{
  runtimeDirectories: RuntimeDirectories;
  processExecution: ServerProcessExecution;
  secretProtector: ServerSecretProtector;
  qhkeyMasterKey: QhkeyMasterKeyProvider;
  removableVolume: RemovableVolumeProvider;
  postgresqlService: PostgresqlServiceController;
}>;

export type ServerPlatform = ServerPlatformCapabilities &
  Readonly<{
    role: "server";
    platform: string;
  }>;
