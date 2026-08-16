// QuickHack note: 도구 스크립트에서 서버 소유 PostgreSQL 연결로 Prisma client를 생성합니다.
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../generated/prisma/client.ts";
import { resolvePostgresqlConnectionStringSync } from "../quickhack_server/core/database/postgresql-credential.mjs";

const { Pool } = pg;

function connectionSchema(connectionString) {
  const schema = new URL(connectionString).searchParams.get("schema")?.trim();
  if (!schema) return undefined;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error("PostgreSQL schema name is invalid.");
  }
  return schema;
}

export function createPrismaClient(options = {}) {
  const connectionString = resolvePostgresqlConnectionStringSync({
    role: options.role ?? "runtime",
    applicationName: options.applicationName ?? "quickhack-tool",
  });
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  const adapter = new PrismaPg(pool, {
    schema: connectionSchema(connectionString),
    disposeExternalPool: true,
  });

  return new PrismaClient({ adapter });
}
