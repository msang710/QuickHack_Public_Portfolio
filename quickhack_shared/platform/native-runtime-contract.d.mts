import { PlatformCapabilityError } from "./platform-capability-error.mjs";

export const POSTGRESQL_MAJOR_VERSION: 18;

export const POSTGRESQL_TOOL_CAPABILITIES: Readonly<{
  service: readonly ["initdb", "pg_ctl", "postgres", "psql"];
  backup: readonly ["psql", "pg_dump", "pg_restore"];
  package: readonly [
    "initdb",
    "pg_ctl",
    "postgres",
    "psql",
    "pg_dump",
    "pg_restore"
  ];
}>;

export const NATIVE_RUNTIME_CONTRACT: Readonly<{
  node: Readonly<{
    minimumMajor: 24;
    maximumExclusiveMajor: 25;
    engines: ">=24 <25";
  }>;
  npm: Readonly<{ major: 12; packageManager: "npm@12.0.2" }>;
  postgresql: Readonly<{
    major: typeof POSTGRESQL_MAJOR_VERSION;
    tools: typeof POSTGRESQL_TOOL_CAPABILITIES;
  }>;
  android: Readonly<{
    jdkMajor: 17;
    gradleVersion: "8.10.2";
    agpVersion: "8.7.3";
    compileSdk: 35;
    targetSdk: 35;
  }>;
}>;

export class NativeRuntimeContractError extends PlatformCapabilityError {}

export type PostgresqlToolCapability = keyof typeof POSTGRESQL_TOOL_CAPABILITIES;

export function parsePostgresqlMajorVersion(
  output: unknown,
  tool?: string
): number;

export function assertPostgresqlToolVersions(
  observedVersions: Record<string, unknown>,
  options?: { capability?: PostgresqlToolCapability }
): Readonly<{
  capability: PostgresqlToolCapability;
  major: typeof POSTGRESQL_MAJOR_VERSION;
  tools: Readonly<Record<string, number>>;
}>;

export function assertNativeRuntimeCapabilities(observed: {
  node?: unknown;
  npm?: unknown;
  postgresql?: {
    capability: PostgresqlToolCapability;
    versions: Record<string, unknown>;
  };
}): Readonly<Record<string, unknown>>;
