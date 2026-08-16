import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "@/generated/prisma/client";

const { Pool } = pg;

export const POSTGRESQL_POOL_POLICY = Object.freeze({
  max: 12,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statementTimeoutMillis: 30_000,
  queryTimeoutMillis: 35_000,
});

export type PostgresqlPrismaClientOptions = {
  connectionString: string;
  applicationName: string;
};

function connectionSchema(connectionString: string) {
  const schema = new URL(connectionString).searchParams.get("schema")?.trim();
  if (!schema) return undefined;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error("PostgreSQL schema name is invalid.");
  }
  return schema;
}

export function createPostgresqlPrismaClient(
  options: PostgresqlPrismaClientOptions
) {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: POSTGRESQL_POOL_POLICY.max,
    connectionTimeoutMillis: POSTGRESQL_POOL_POLICY.connectionTimeoutMillis,
    idleTimeoutMillis: POSTGRESQL_POOL_POLICY.idleTimeoutMillis,
    statement_timeout: POSTGRESQL_POOL_POLICY.statementTimeoutMillis,
    query_timeout: POSTGRESQL_POOL_POLICY.queryTimeoutMillis,
    allowExitOnIdle: false,
  });
  const adapter = new PrismaPg(pool, {
    schema: connectionSchema(options.connectionString),
    disposeExternalPool: true,
    onPoolError: () => undefined,
    onConnectionError: () => undefined,
  });

  return {
    pool,
    client: new PrismaClient({ adapter }),
  };
}
