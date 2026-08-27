export type AppliedMigrationRow = {
  migration_name?: unknown;
  checksum?: unknown;
  finished_at?: unknown;
  rolled_back_at?: unknown;
};

export type PostgresqlIndexContractRow = {
  index_name?: unknown;
  table_name?: unknown;
  is_unique?: unknown;
  is_valid?: unknown;
  is_ready?: unknown;
  predicate?: unknown;
};

export const QUICKHACK_POSTGRESQL_MIGRATIONS: readonly Readonly<{
  name: string;
  checksum: string;
}>[];
export const QUICKHACK_POSTGRESQL_SCHEMA_VERSION: string;
export const ACTIVE_ALLOCATION_INDEX_CONTRACT: Readonly<{
  name: string;
  table: string;
  statuses: readonly string[];
}>;
export function assertAppliedPostgresqlMigrations(rows: AppliedMigrationRow[]): string;
export function normalizedIndexPredicate(value: unknown): string;
export function assertActiveAllocationIndex(row: PostgresqlIndexContractRow | null | undefined): true;
