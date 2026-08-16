export type PostgresqlConnectionRole =
  | "runtime"
  | "migrator"
  | "backup"
  | "operator"
  | "coupangMock"
  | "logenMock";

export class PostgresqlCredentialError extends Error {
  readonly code: string;
}

export const POSTGRESQL_ROLE_FILES: Readonly<
  Record<PostgresqlConnectionRole, string>
>;

export function postgresqlCredentialPath(
  role: PostgresqlConnectionRole,
  dataDir: string
): string;

export function resolvePostgresqlConnectionStringSync(options?: {
  role?: PostgresqlConnectionRole;
  applicationName?: string;
  env?: NodeJS.ProcessEnv;
  allowSchemaOnlyFallback?: boolean;
  runtimeConfigPath?: string;
  secretProtector?: ServerSecretProtector;
}): string;

export function protectedPostgresqlCredentialFile(
  password: Buffer,
  secretProtector?: ServerSecretProtector
): Promise<Buffer>;
import type { ServerSecretProtector } from "../../platform/contracts.ts";
import type { ServerSecretProtector } from "../../platform/contracts.ts";
