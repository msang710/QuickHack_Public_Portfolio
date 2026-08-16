export type ServerRuntimeEnvironment = "development" | "production";
type ServerRuntimeDatabaseBase = {
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  name: string;
  runtimeUser: string;
  migratorUser: string;
};

type ServerRuntimeConfigBase = {
  schemaVersion: 3;
  environment: ServerRuntimeEnvironment;
  coupangWriteApiEnabled: boolean;
  logenWriteApiEnabled: boolean;
  dataDirectory: string;
  backupRetentionCount: number;
};

export type OperationalServerRuntimeConfig = ServerRuntimeConfigBase & {
  packageFlavor: "OPERATIONAL";
  database: ServerRuntimeDatabaseBase;
};

export type DemonstrationServerRuntimeConfig = ServerRuntimeConfigBase & {
  packageFlavor: "DEMONSTRATION";
  database: ServerRuntimeDatabaseBase & {
    coupangMockName: string;
    coupangMockUser: string;
    logenMockName: string;
    logenMockUser: string;
  };
};

export type ServerRuntimeConfig =
  | OperationalServerRuntimeConfig
  | DemonstrationServerRuntimeConfig;

export type ServerRuntimeConfigLocation = {
  kind: "source" | "operational";
  sourceRoot: string;
  configPath: string;
};

export const SERVER_RUNTIME_CONFIG_SCHEMA_VERSION: 3;
export const SERVER_RUNTIME_CONFIG_FILE_NAME: string;
export const SOURCE_SERVER_RUNTIME_CONFIG_RELATIVE_PATH: string;

export class ServerRuntimeConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function findQuickHackSourceRoot(startDirectory?: string): string;
export function sourceServerRuntimeConfigPath(sourceRoot: string): string;
export function operationalServerRuntimeConfigPath(
  configDirectory: string
): string;
export function resolveServerRuntimeConfigLocation(options?: {
  startDirectory?: string;
  operationalConfigDirectory?: string;
  argv?: string[];
}): ServerRuntimeConfigLocation;
export function defaultSourceServerRuntimeConfig(
  sourceRoot: string
): ServerRuntimeConfig;
export function validateServerRuntimeConfig(value: unknown): ServerRuntimeConfig;
export function readServerRuntimeConfigSync(options?: {
  startDirectory?: string;
  operationalConfigDirectory?: string;
  argv?: string[];
  configPath?: string;
  kind?: "source" | "operational";
  sourceRoot?: string;
}): {
  config: ServerRuntimeConfig;
  location: ServerRuntimeConfigLocation;
  persisted: boolean;
};
export function writeServerRuntimeConfigAtomicSync(
  configPath: string,
  value: ServerRuntimeConfig
): ServerRuntimeConfig;
