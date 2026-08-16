export const RUNTIME_DIRECTORY_FIELDS: readonly [
  "appRoot",
  "runtimeDir",
  "configDir",
  "dataDir",
  "stateDir",
  "logDir",
  "cacheDir",
  "secretDir",
  "artifactDir"
];

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

export type RuntimeDirectoryContext = Readonly<{
  appRoot: string;
  runtimeDir?: string;
  dataDirectory?: string;
  homeDirectory?: string;
  deployment?: "development" | "system-service";
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}>;

export function createRuntimeDirectorySnapshot(
  input: RuntimeDirectorySnapshot
): RuntimeDirectorySnapshot;
export function assertAbsoluteRuntimeDirectory(
  value: unknown,
  fieldName: string
): string;
