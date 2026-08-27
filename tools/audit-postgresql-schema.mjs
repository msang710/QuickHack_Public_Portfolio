// QuickHack note: PostgreSQL baseline과 catalog 상태를 비밀값 없이 검사합니다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolvePostgresqlConnectionStringSync } from "../quickhack_server/core/database/postgresql-credential.mjs";
import {
  ACTIVE_ALLOCATION_INDEX_CONTRACT,
  assertActiveAllocationIndex,
  assertAppliedPostgresqlMigrations,
} from "../quickhack_shared/core/postgresql-schema-contract.mjs";

const { Pool } = pg;
const PROHIBITED_TABLES = [
  "coupang_product_inquiry_raw",
  "coupang_call_center_inquiry_raw",
  "coupang_inquiry_work",
  "coupang_inquiry_order_link",
];

export async function auditPostgresqlSchema() {
  const pool = new Pool({
    connectionString: resolvePostgresqlConnectionStringSync({
      role: "migrator",
      applicationName: "quickhack-schema-audit",
    }),
    application_name: "quickhack-schema-audit",
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  try {
    const [connection, migrations, invalidConstraints, prohibited, activeIndex] =
      await Promise.all([
        pool.query(
          "SELECT current_database() AS database_name, current_schema() AS schema_name"
        ),
        pool.query(`
          SELECT migration_name, checksum, finished_at, rolled_back_at
          FROM "_prisma_migrations"
          ORDER BY started_at
        `),
        pool.query(`
          SELECT conname
          FROM pg_catalog.pg_constraint
          WHERE connamespace = current_schema()::regnamespace
            AND NOT convalidated
        `),
        pool.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
          [PROHIBITED_TABLES]
        ),
        pool.query(
          `SELECT index_class.relname AS index_name,
                  table_class.relname AS table_name,
                  index_meta.indisunique AS is_unique,
                  index_meta.indisvalid AS is_valid,
                  index_meta.indisready AS is_ready,
                  pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
           FROM pg_catalog.pg_index AS index_meta
           JOIN pg_catalog.pg_class AS index_class ON index_class.oid = index_meta.indexrelid
           JOIN pg_catalog.pg_class AS table_class ON table_class.oid = index_meta.indrelid
           WHERE index_class.relname = $1`,
          [ACTIVE_ALLOCATION_INDEX_CONTRACT.name]
        ),
      ]);
    const schemaVersion = assertAppliedPostgresqlMigrations(migrations.rows);
    assertActiveAllocationIndex(activeIndex.rows[0]);
    if (invalidConstraints.rowCount !== 0 || prohibited.rowCount !== 0) {
      throw new Error("PostgreSQL baseline catalog does not match the QuickHack contract.");
    }
    return {
      ok: true,
      database: connection.rows[0]?.database_name ?? "",
      schema: connection.rows[0]?.schema_name ?? "",
      migration: migrations.rows.at(-1)?.migration_name ?? "",
      schemaVersion,
    };
  } finally {
    await pool.end();
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const result = await auditPostgresqlSchema();
    console.log(
      `PostgreSQL schema audit passed: ${result.database}/${result.schema} ${result.schemaVersion}`
    );
  } catch (error) {
    console.error(
      `PostgreSQL schema audit failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
