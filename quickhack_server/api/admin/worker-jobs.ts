import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  BACKUP_CONSOLE_WORKER_KEYS,
  isBackupConsoleWorkerKey,
  workerManagementSurface,
} from "@/quickhack_server/admin/backup-worker-policy";
import { findRegisteredWorker } from "@/quickhack_server/workers/registry";
import {
  registeredWorkerIntervalSeconds,
  registeredWorkerScheduleKind,
  registeredWorkerScheduleLabel,
} from "@/quickhack_server/workers/schedule";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

export const runtime = "nodejs";

const SERVER_CONSOLE_WORKER_CONTROL_ERROR =
  "WORKER_CONTROL_REQUIRES_SERVER_CONSOLE";

function parseJsonObject(text: string) {
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function bodyText(value: Record<string, unknown>, key: string) {
  const text = String(value[key] ?? "").trim();
  return text || "";
}

function bodyPositiveInteger(value: Record<string, unknown>, key: string) {
  const number = Number(value[key]);

  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }

  return number;
}

function bodyBoolean(value: Record<string, unknown>, key: string) {
  return value[key] === true || String(value[key]).toLowerCase() === "true";
}

function toDto(row: {
  worker_job_id: number;
  worker_key: string;
  worker_name: string;
  worker_type: string;
  status: string;
  schedule_enabled: number;
  interval_seconds: number | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  locked_by: string | null;
  locked_until: Date | null;
  progress_current: number;
  progress_total: number | null;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  result_summary_text: string | null;
  result_processed_count: number | null;
  result_succeeded_count: number | null;
  result_failed_count: number | null;
  result_skipped_count: number | null;
  result_created_count: number | null;
  result_updated_count: number | null;
  result_warning_count: number | null;
  triggered_by_user_id: number | null;
  created_at: Date;
  updated_at: Date;
  users?: {
    username: string;
    employee_profiles?: {
      display_name: string;
    } | null;
  } | null;
}) {
  const registeredWorker = findRegisteredWorker(row.worker_key);

  return {
    workerJobId: row.worker_job_id,
    workerKey: row.worker_key,
    workerName: row.worker_name,
    workerType: row.worker_type,
    status: row.status,
    scheduleEnabled: row.schedule_enabled === 1,
    scheduleRequired: registeredWorker?.scheduleRequired === true,
    schedulable: Boolean(
      registeredWorker &&
        registeredWorkerIntervalSeconds(registeredWorker)
    ),
    scheduleKind:
      registeredWorkerScheduleKind(registeredWorker),
    scheduleLabel:
      registeredWorkerScheduleLabel(registeredWorker),
    managementSurface: workerManagementSurface(row.worker_key),
    intervalSeconds: row.interval_seconds,
    nextRunAt: apiDateTime(row.next_run_at) ?? "",
    lastRunAt: apiDateTime(row.last_run_at) ?? "",
    startedAt: apiDateTime(row.started_at) ?? "",
    finishedAt: apiDateTime(row.finished_at) ?? "",
    lockedBy: row.locked_by ?? "",
    lockedUntil: apiDateTime(row.locked_until) ?? "",
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lastErrorCode: row.last_error_code ?? "",
    lastErrorMessage: row.last_error_message ?? "",
    resultSummaryText: row.result_summary_text ?? "",
    resultProcessedCount: row.result_processed_count,
    resultSucceededCount: row.result_succeeded_count,
    resultFailedCount: row.result_failed_count,
    resultSkippedCount: row.result_skipped_count,
    resultCreatedCount: row.result_created_count,
    resultUpdatedCount: row.result_updated_count,
    resultWarningCount: row.result_warning_count,
    triggeredByUserId: row.triggered_by_user_id,
    username: row.users?.username ?? "",
    displayName: row.users?.employee_profiles?.display_name ?? row.users?.username ?? "",
    createdAt: requiredApiDateTime(row.created_at),
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

async function requireLeader(request: NextRequest) {
  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, message: "로그인이 필요합니다." },
        { status: 401 }
      ),
    };
  }

  if (!canAccessRole(user.role, "LEADER")) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, message: "worker 작업 관리 권한이 없습니다." },
        { status: 403 }
      ),
    };
  }

  return { ok: true as const, user };
}

function serverConsoleWorkerControlResponse() {
  return NextResponse.json(
    {
      ok: false,
      code: SERVER_CONSOLE_WORKER_CONTROL_ERROR,
      message: "이 백업 작업은 서버 콘솔의 DB 백업 관리에서만 변경할 수 있습니다.",
    },
    { status: 403 }
  );
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/worker-jobs", {
      method: "GET",
      contentType: null,
    });
  }

  const auth = await requireLeader(request);

  if (!auth.ok) {
    return auth.response;
  }

  const [
    { listWorkerJobs },
    { getWorkerManagerState, startWorkerManager },
    { getCoupangReadSyncHealth },
  ] =
    await Promise.all([
      import("@/quickhack_server/workers/worker-jobs"),
      import("@/quickhack_server/workers/manager"),
      import(
        "@/quickhack_server/sales-channel/coupang/read-sync-recovery-service"
      ),
    ]);
  startWorkerManager();
  const [rows, readSyncHealth] = await Promise.all([
    listWorkerJobs(),
    getCoupangReadSyncHealth(),
  ]);

  return NextResponse.json({
    ok: true,
    manager: getWorkerManagerState(),
    readSyncHealth,
    items: rows.map(toDto),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/worker-jobs", {
      method: "POST",
      body,
    });
  }

  const auth = await requireLeader(request);

  if (!auth.ok) {
    return auth.response;
  }

  const parsed = parseJsonObject(body);

  if (!parsed) {
    return NextResponse.json(
      { ok: false, message: "요청 본문은 JSON 객체여야 합니다." },
      { status: 400 }
    );
  }

  const action = bodyText(parsed, "action");
  const {
    ensureRegisteredWorkerJobs,
    listWorkerJobs,
    runDueWorkerJobs,
    runWorkerJob,
    updateWorkerSchedule,
  } = await import("@/quickhack_server/workers/worker-jobs");

  try {
    if (action === "syncRegistry") {
      await ensureRegisteredWorkerJobs();
      const rows = await listWorkerJobs();

      return NextResponse.json({ ok: true, items: rows.map(toDto) });
    }

    if (action === "runWorker") {
      const workerKey = bodyText(parsed, "workerKey");

      if (!workerKey) {
        return NextResponse.json(
          { ok: false, message: "workerKey가 필요합니다." },
          { status: 400 }
        );
      }

      if (isBackupConsoleWorkerKey(workerKey)) {
        return serverConsoleWorkerControlResponse();
      }

      return NextResponse.json({
        ok: true,
        data: await runWorkerJob(workerKey, auth.user),
      });
    }

    if (action === "runDue") {
      return NextResponse.json({
        ok: true,
        data: await runDueWorkerJobs(auth.user, {
          excludeWorkerKeys: BACKUP_CONSOLE_WORKER_KEYS,
        }),
      });
    }

    if (action === "updateSchedule") {
      const workerKey = bodyText(parsed, "workerKey");
      const scheduleEnabled = bodyBoolean(parsed, "scheduleEnabled");
      const intervalSeconds = bodyPositiveInteger(parsed, "intervalSeconds");

      if (!workerKey) {
        return NextResponse.json(
          { ok: false, message: "workerKey가 필요합니다." },
          { status: 400 }
        );
      }

      if (isBackupConsoleWorkerKey(workerKey)) {
        return serverConsoleWorkerControlResponse();
      }

      return NextResponse.json({
        ok: true,
        item: toDto(
          await updateWorkerSchedule({
            workerKey,
            scheduleEnabled,
            intervalSeconds,
            triggeredBy: auth.user,
          })
        ),
      });
    }

    return NextResponse.json(
      { ok: false, message: "지원하지 않는 worker 작업입니다." },
      { status: 400 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
