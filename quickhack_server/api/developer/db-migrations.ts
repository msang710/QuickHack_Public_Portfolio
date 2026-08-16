import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { nowKstSqlDateTime } from "@/quickhack_shared/core/time";
import { requireDeveloper } from "@/quickhack_server/api/developer/common";
import { prisma } from "@/quickhack_server/core/prisma";

export const runtime = "nodejs";

const TABLES = [
  "devices",
  "inbounds",
  "inspections",
  "inventory",
  "sales_offers",
  "channel_credentials",
  "channel_credential_events",
  "sales_channel_product_mappings",
  "coupang_order_raw",
  "order_matching_work_queue",
  "server_worker_jobs",
] as const;

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countTable(tableName: (typeof TABLES)[number]) {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
    `SELECT COUNT(*) AS count FROM "${tableName}"`
  );

  return Number(rows[0]?.count ?? 0);
}

async function tableCounts() {
  const entries = await Promise.all(
    TABLES.map(async (tableName) => [
      tableName,
      await countTable(tableName).catch(() => null),
    ])
  );

  return Object.fromEntries(entries) as Record<
    (typeof TABLES)[number],
    number | null
  >;
}

async function listMigrationFiles() {
  const migrationsDir = "prisma/migrations";

  if (!(await exists(migrationsDir))) {
    return { migrationsDir, exists: false, items: [] };
  }

  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const items = await Promise.all(
    directories.map(async (name) => {
      const sqlPath = `${migrationsDir}/${name}/migration.sql`;
      const stat = await fs.stat(sqlPath).catch(() => null);

      return { name, hasSql: Boolean(stat), sqlSizeBytes: stat?.size ?? 0 };
    })
  );

  return { migrationsDir, exists: true, items };
}

async function migrationTableState() {
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        migration_name: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }>
    >`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY migration_name
    `;

    return {
      exists: true,
      appliedCount: rows.filter((row) => row.finished_at && !row.rolled_back_at)
        .length,
      rows,
    };
  } catch {
    return {
      exists: false,
      appliedCount: 0,
      rows: [],
      message: "마이그레이션 기록을 확인하지 못했습니다.",
    };
  }
}

async function integrityCheck() {
  try {
    const [connectionRows, invalidConstraintRows] = await Promise.all([
      prisma.$queryRaw<Array<{ database_name: string; schema_name: string }>>`
        SELECT current_database() AS database_name, current_schema() AS schema_name
      `,
      prisma.$queryRaw<Array<{ constraint_name: string }>>`
        SELECT conname AS constraint_name
        FROM pg_catalog.pg_constraint
        WHERE NOT convalidated
        ORDER BY conname
      `,
    ]);
    const connection = connectionRows[0] ?? null;

    return {
      ok: Boolean(connection) && invalidConstraintRows.length === 0,
      connection,
      invalidConstraints: invalidConstraintRows.map((row) => row.constraint_name),
    };
  } catch {
    return {
      ok: false,
      connection: null,
      invalidConstraints: [],
      message: "PostgreSQL 연결 및 제약 조건 상태를 확인하지 못했습니다.",
    };
  }
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/developer/db-migrations", {
      method: "GET",
      contentType: null,
    });
  }

  const auth = await requireDeveloper(request);

  if (!auth.ok) {
    return auth.response;
  }

  const runtimeConfig = runtimeConfigService.read();
  const database = runtimeConfig.database.accessible
    ? runtimeConfig.database.postgresql
    : null;
  const schemaPath = "prisma/schema.prisma";
  const [schemaExists, migrations, migrationTable, counts, integrity] =
    await Promise.all([
      exists(schemaPath),
      listMigrationFiles(),
      migrationTableState(),
      tableCounts(),
      integrityCheck(),
    ]);

  return NextResponse.json({
    ok: true,
    checkedAt: nowKstSqlDateTime(),
    database: {
      provider: "postgresql",
      endpoint: database
        ? { host: database.host, port: database.port, name: database.name }
        : null,
      configured: runtimeConfig.database.configured,
      integrity,
    },
    prisma: { schemaPath, schemaExists, migrations, migrationTable },
    tableCounts: counts,
  });
}
