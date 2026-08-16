// QuickHack note: PostgreSQL baseline과 catalog 상태를 비밀값 없이 검사합니다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolvePostgresqlConnectionStringSync } from "../quickhack_server/core/database/postgresql-credential.mjs";

const { Pool } = pg;
const EXPECTED_MIGRATION = "20260811010000_postgresql_baseline";
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
    const [connection, migrations, invalidConstraints, prohibited] =
      await Promise.all([
        pool.query(
          "SELECT current_database() AS database_name, current_schema() AS schema_name"
        ),
        pool.query(`
          SELECT migration_name, finished_at, rolled_back_at
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
      ]);
    const applied = migrations.rows.filter(
      (row) => row.finished_at && !row.rolled_back_at
    );
    if (
      applied.length !== 1 ||
      applied[0].migration_name !== EXPECTED_MIGRATION ||
      invalidConstraints.rowCount !== 0 ||
      prohibited.rowCount !== 0
    ) {
      throw new Error("PostgreSQL baseline catalog does not match the QuickHack contract.");
    }
    return {
      ok: true,
      database: connection.rows[0]?.database_name ?? "",
      schema: connection.rows[0]?.schema_name ?? "",
      migration: EXPECTED_MIGRATION,
    };
  } finally {
    await pool.end();
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const result = await auditPostgresqlSchema();
    console.log(
      `PostgreSQL schema audit passed: ${result.database}/${result.schema} ${result.migration}`
    );
  } catch (error) {
    console.error(
      `PostgreSQL schema audit failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
