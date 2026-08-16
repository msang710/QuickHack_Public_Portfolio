import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  BackupConsoleConflictError,
  readBackupConsoleState,
  runBackupWorkerNow,
  setBackupWorkerSchedule,
} from "@/quickhack_server/admin/backup-console-service";
import { isBackupConsoleWorkerKey } from "@/quickhack_server/admin/backup-worker-policy";
import { authorizeSupervisorRequest } from "@/quickhack_server/admin/supervisor-auth";

export const runtime = "nodejs";

type BackupAction = "setSchedule" | "runNow";

class BackupConsoleRequestError extends Error {
  readonly statusCode = 400;
}

function parseAction(value: unknown): BackupAction {
  const action = String(value ?? "").trim();

  if (action === "setSchedule" || action === "runNow") {
    return action;
  }

  throw new BackupConsoleRequestError("지원하지 않는 백업 관리 요청입니다.");
}

function parseWorkerKey(value: unknown) {
  if (!isBackupConsoleWorkerKey(value)) {
    throw new BackupConsoleRequestError(
      "서버 콘솔에서 관리할 수 없는 worker입니다."
    );
  }

  return value;
}

function parseScheduleEnabled(value: unknown) {
  if (typeof value !== "boolean") {
    throw new BackupConsoleRequestError(
      "scheduleEnabled 값은 boolean이어야 합니다."
    );
  }

  return value;
}

function errorResponse(error: unknown) {
  if (
    error instanceof BackupConsoleRequestError ||
    error instanceof BackupConsoleConflictError
  ) {
    return apiFailureResponse({
      status: error.statusCode,
      code:
        error instanceof BackupConsoleConflictError
          ? "BACKUP_CONSOLE_CONFLICT"
          : "INVALID_BACKUP_CONSOLE_REQUEST",
      message: error.message,
      cause: error,
    });
  }

  return apiErrorResponse(error);
}

export async function GET(request: NextRequest) {
  const authorizationFailure = authorizeSupervisorRequest(request);

  if (authorizationFailure) {
    return authorizationFailure;
  }

  try {
    return NextResponse.json({
      ok: true,
      state: await readBackupConsoleState(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const authorizationFailure = authorizeSupervisorRequest(request);

  if (authorizationFailure) {
    return authorizationFailure;
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = parseAction(body.action);
    const workerKey = parseWorkerKey(body.workerKey);

    if (action === "setSchedule") {
      const scheduleEnabled = parseScheduleEnabled(body.scheduleEnabled);

      return NextResponse.json({
        ok: true,
        message: scheduleEnabled
          ? "자동 실행 일정을 켰습니다."
          : "자동 실행 일정을 껐습니다.",
        state: await setBackupWorkerSchedule({
          workerKey,
          scheduleEnabled,
        }),
      });
    }

    const result = await runBackupWorkerNow(workerKey);

    return NextResponse.json({
      ok: true,
      message:
        workerKey === "database-auto-backup"
          ? "DB 백업을 완료했습니다."
          : "백업 보존·무결성 점검을 완료했습니다.",
      ...result,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
