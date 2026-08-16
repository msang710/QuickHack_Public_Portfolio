export function createLinuxPostgresqlCredentialTransaction(options: Record<string, unknown>): Readonly<{
  prepare(runtimeConfig: Record<string, unknown>): Promise<Record<string, unknown>>;
  commit(token: Record<string, unknown>): Promise<Record<string, unknown>>;
  activate(token: Record<string, unknown>): Promise<Record<string, unknown>>;
  rollback(token: Record<string, unknown>): Promise<void>;
  dispose(token: Record<string, unknown>): Promise<void>;
}>;
