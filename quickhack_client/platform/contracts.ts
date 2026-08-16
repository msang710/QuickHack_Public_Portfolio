export const CLIENT_PLATFORM_CAPABILITIES = [
  "runtime-directories",
  "adb-executable-resolver",
  "printer-backend",
] as const;

export type ClientPlatformCapabilityId =
  (typeof CLIENT_PLATFORM_CAPABILITIES)[number];

export type PlatformCapabilityDescriptor = Readonly<{
  id: ClientPlatformCapabilityId;
  role: "client";
  platform: string;
  state: "READY" | "COMPATIBILITY" | "UNAVAILABLE";
  ownerStage: "PR-04" | "PR-07";
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
    homeDirectory?: string;
    deployment?: "development" | "system-service";
    artifactKind?: "DEMONSTRATION_CLIENT" | "OPERATIONAL_CLIENT";
    environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  }>): RuntimeDirectorySnapshot;
}>;

export type ClientNativeExecutionContext = Readonly<{
  appRoot: string;
  runtimeDir: string;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}>;

export type AdbExecutionPlan = Readonly<{
  executable: string;
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  observedVersion: string;
}>;

export type AdbExecutableResolver = Readonly<{
  descriptor: PlatformCapabilityDescriptor;
  resolve(input: ClientNativeExecutionContext): Promise<AdbExecutionPlan>;
}>;

export type PrinterQueue = Readonly<{
  name: string;
  isDefault: boolean;
  isOffline: boolean;
  status: string;
}>;

export type PrinterSubmitStatus = "SPOOLED" | "FAILED" | "UNKNOWN";

export type PrinterSubmitRequest = ClientNativeExecutionContext &
  Readonly<{
    printerName: string;
    spoolPath: string;
    requestedBytes: number;
  }>;

export type PrinterSubmitResult = Readonly<{
  status: PrinterSubmitStatus;
  requestedBytes: number;
  writtenBytes: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  nativeJobId: string | null;
}>;

export type PrinterBackend = Readonly<{
  descriptor: PlatformCapabilityDescriptor;
  list(input: ClientNativeExecutionContext): Promise<readonly PrinterQueue[]>;
  submit(input: PrinterSubmitRequest): Promise<PrinterSubmitResult>;
  secureSpoolDirectory(
    input: ClientNativeExecutionContext & Readonly<{ directory: string }>
  ): Promise<void>;
}>;

export type ClientPlatformCapabilities = Readonly<{
  runtimeDirectories: RuntimeDirectories;
  adbExecutableResolver: AdbExecutableResolver;
  printerBackend: PrinterBackend;
}>;

export type ClientPlatform = ClientPlatformCapabilities &
  Readonly<{
    role: "client";
    platform: string;
  }>;
