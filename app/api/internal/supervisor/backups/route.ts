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
  constructor(readonly messageCode: string) {
    super(messageCode);
  }
}

function parseAction(value: unknown): BackupAction {
  const action = String(value ?? "").trim();

  if (action === "setSchedule" || action === "runNow") {
    return action;
  }

  throw new BackupConsoleRequestError("BACKUP_ACTION_UNSUPPORTED");
}

function parseWorkerKey(value: unknown) {
  if (!isBackupConsoleWorkerKey(value)) {
    throw new BackupConsoleRequestError("BACKUP_WORKER_UNSUPPORTED");
  }

  return value;
}

function parseScheduleEnabled(value: unknown) {
  if (typeof value !== "boolean") {
    throw new BackupConsoleRequestError("BACKUP_SCHEDULE_INVALID");
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
      extra: {
        messageCode:
          error instanceof BackupConsoleRequestError
            ? error.messageCode
            : "BACKUP_CONSOLE_CONFLICT",
      },
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
        messageCode: scheduleEnabled
          ? "BACKUP_SCHEDULE_ENABLED"
          : "BACKUP_SCHEDULE_DISABLED",
        state: await setBackupWorkerSchedule({
          workerKey,
          scheduleEnabled,
        }),
      });
    }

    const result = await runBackupWorkerNow(workerKey);

    return NextResponse.json({
      ok: true,
      messageCode:
        workerKey === "database-auto-backup"
          ? "DATABASE_BACKUP_COMPLETED"
          : "BACKUP_RETENTION_COMPLETED",
      ...result,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
