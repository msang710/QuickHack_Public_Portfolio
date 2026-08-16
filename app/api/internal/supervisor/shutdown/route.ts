import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { authorizeSupervisorRequest } from "@/quickhack_server/admin/supervisor-auth";
import {
  beginServerShutdown,
  finalizeServerShutdown,
  getServerShutdownStatus,
  scheduleServerTermination,
  SERVER_SHUTDOWN_REASONS,
  ServerShutdownConflictError,
  type ServerShutdownReason,
} from "@/quickhack_server/admin/server-shutdown-service";

export const runtime = "nodejs";

type ShutdownAction = "quiesce" | "status" | "finalize" | "terminate";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function parseAction(value: unknown): ShutdownAction {
  const action = text(value);

  if (
    action === "quiesce" ||
    action === "status" ||
    action === "finalize" ||
    action === "terminate"
  ) {
    return action;
  }

  throw new Error("Unsupported server shutdown action.");
}

function parseOperationId(value: unknown) {
  const operationId = text(value);

  if (!/^[a-zA-Z0-9-]{8,100}$/.test(operationId)) {
    throw new Error("operationId is invalid.");
  }

  return operationId;
}

function parseReason(value: unknown): ServerShutdownReason {
  const reason = text(value);

  if (
    !SERVER_SHUTDOWN_REASONS.includes(reason as ServerShutdownReason)
  ) {
    throw new Error("Server shutdown reason is invalid.");
  }

  return reason as ServerShutdownReason;
}

function parseWarningEpochMs(value: unknown) {
  const warningEpochMs = Number(value);

  if (!Number.isSafeInteger(warningEpochMs) || warningEpochMs <= 0) {
    throw new Error("warningEpochMs is invalid.");
  }

  return warningEpochMs;
}

export async function POST(request: NextRequest) {
  const authorizationFailure = authorizeSupervisorRequest(request);

  if (authorizationFailure) {
    return authorizationFailure;
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = parseAction(body.action);
    const operationId = parseOperationId(body.operationId);
    let shutdown;

    if (action === "quiesce") {
      shutdown = beginServerShutdown({
        operationId,
        reason: parseReason(body.reason),
        warningEpochMs: parseWarningEpochMs(body.warningEpochMs),
      });
    } else if (action === "status") {
      shutdown = getServerShutdownStatus(operationId);
    } else if (action === "finalize") {
      shutdown = await finalizeServerShutdown(operationId);
    } else {
      shutdown = scheduleServerTermination(operationId);
    }

    return NextResponse.json({ ok: true, shutdown });
  } catch (error) {
    if (error instanceof ServerShutdownConflictError) {
      return apiFailureResponse({
        status: error.statusCode,
        code: "SERVER_SHUTDOWN_CONFLICT",
        message: error.message,
        cause: error,
      });
    }

    return apiErrorResponse(error);
  }
}
