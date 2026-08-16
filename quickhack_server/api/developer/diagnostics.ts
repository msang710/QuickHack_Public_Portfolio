import os from "node:os";
import { NextRequest, NextResponse } from "next/server";
import {
  getRuntimeRole,
  isClientRuntime,
} from "@/quickhack_shared/core/runtime";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { nowKstSqlDateTime } from "@/quickhack_shared/core/time";
import { publicUserDto, requireDeveloper } from "@/quickhack_server/api/developer/common";
import { prisma } from "@/quickhack_server/core/prisma";
import { registeredWorkers } from "@/quickhack_server/workers/registry";
import { getTotpServerStatus } from "@/quickhack_server/auth/totp-service";

export const runtime = "nodejs";

const DIAGNOSTIC_TABLES = [
  "devices",
  "inbounds",
  "inspections",
  "inventory",
  "orders",
  "users",
  "employee_activity_logs",
  "server_job_logs",
  "server_worker_jobs",
  "sales_offers",
  "channel_credentials",
  "channel_credential_events",
  "sales_channel_product_mappings",
  "coupang_order_raw",
  "order_matching_work_queue",
  "match_worker_allocation",
] as const;

async function countTable(tableName: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
    `SELECT COUNT(*) AS count FROM "${tableName}"`
  );

  return Number(rows[0]?.count ?? 0);
}

async function tableCounts() {
  const entries = await Promise.all(
    DIAGNOSTIC_TABLES.map(async (tableName) => [
      tableName,
      await countTable(tableName).catch(() => null),
    ])
  );

  return Object.fromEntries(entries) as Record<(typeof DIAGNOSTIC_TABLES)[number], number | null>;
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/developer/diagnostics", {
      method: "GET",
      contentType: null,
    });
  }

  const auth = await requireDeveloper(request);

  if (!auth.ok) {
    return auth.response;
  }

  const [
    { getWorkerManagerState },
    { getOperationTraceQueueState },
    counts,
    workerRows,
  ] = await Promise.all([
    import("@/quickhack_server/workers/manager"),
    import("@/quickhack_server/observability/trace-log-queue"),
    tableCounts(),
    prisma.server_worker_jobs.findMany({
      select: {
        worker_key: true,
        worker_name: true,
        worker_type: true,
        status: true,
        schedule_enabled: true,
        last_run_at: true,
        last_error_message: true,
      },
      orderBy: [{ worker_type: "asc" }, { worker_key: "asc" }],
    }),
  ]);
  const runtimeConfig = runtimeConfigService.read();
  const totpServer = await getTotpServerStatus();
  const failedWorkers = workerRows.filter((row) =>
    ["FAILED", "RETRY_WAITING"].includes(row.status)
  );

  return NextResponse.json({
    ok: true,
    checkedAt: nowKstSqlDateTime(),
    user: publicUserDto(auth.user),
    runtime: {
      quickHackEnvironment: runtimeConfig.environment,
      runtimeRole: getRuntimeRole(),
      nodeEnv: process.env.NODE_ENV || "",
      production: runtimeConfig.production,
      coupangWriteApiEnabled: runtimeConfig.policies.coupangWriteApiEnabled,
      logenWriteApiEnabled: runtimeConfig.policies.logenWriteApiEnabled,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      hostname: os.hostname(),
      uptimeSeconds: Math.round(process.uptime()),
    },
    database: {
      provider: runtimeConfig.database.provider,
      postgresqlImplemented:
        runtimeConfig.database.accessible && runtimeConfig.database.postgresql.implemented,
      endpoint:
        runtimeConfig.database.accessible
          ? {
              host: runtimeConfig.database.postgresql.host,
              port: runtimeConfig.database.postgresql.port,
              name: runtimeConfig.database.postgresql.name,
            }
          : null,
      tableCounts: counts,
    },
    workers: {
      manager: getWorkerManagerState(),
      registeredCount: registeredWorkers.length,
      persistedCount: workerRows.length,
      scheduledCount: workerRows.filter((row) => row.schedule_enabled === 1).length,
      runningCount: workerRows.filter((row) => row.status === "RUNNING").length,
      failedCount: failedWorkers.length,
      failedWorkers: failedWorkers.map((row) => ({
        workerKey: row.worker_key,
        workerName: row.worker_name,
        status: row.status,
        lastRunAt: row.last_run_at,
        lastErrorMessage: row.last_error_message,
      })),
    },
    observability: {
      operationTraceQueue: getOperationTraceQueueState(),
    },
    environment: {
      hasDatabaseUrl: runtimeConfig.database.configured,
      hasRemoteServerUrl: Boolean(runtimeConfig.endpoints.remoteServerUrl),
      totpKeyState: totpServer.state,
      totpKeyProtection: totpServer.protection,
      externalApiMode: runtimeConfig.endpoints.coupang.mode,
    },
  });
}
