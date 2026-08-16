import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  PublicError,
  normalizePublicErrorCode,
  type PublicErrorDetails,
  type PublicErrorStatus,
} from "@/quickhack_server/core/public-error";
import {
  getOperationTraceId,
  markOperationTraceFailed,
} from "@/quickhack_server/observability/operation-trace";
import { QUICKHACK_TRACE_ID_HEADER } from "@/quickhack_shared/observability/http-trace";

const INTERNAL_ERROR_MESSAGE =
  "요청을 처리하는 중 문제가 발생했습니다. 문제가 계속되면 추적 ID와 함께 관리자에게 문의하세요.";

type ApiFailureResponseInput = {
  status: PublicErrorStatus | 500;
  code: string;
  message: string;
  details?: PublicErrorDetails;
  extra?: Record<string, unknown>;
  cause?: unknown;
};

function traceIdForResponse() {
  return getOperationTraceId() ?? randomUUID();
}

export function apiFailureResponse(input: ApiFailureResponseInput) {
  const code = normalizePublicErrorCode(input.code);
  const failure = input.cause ?? new Error(input.message);
  markOperationTraceFailed(failure, code);

  const traceId = traceIdForResponse();
  const body: Record<string, unknown> = {
    ...input.extra,
    ok: false,
    code,
    message: input.message,
    traceId,
  };

  if (input.details !== undefined) {
    body.details = input.details;
  }

  return NextResponse.json(body, {
    status: input.status,
    headers: { [QUICKHACK_TRACE_ID_HEADER]: traceId },
  });
}

export function apiErrorResponse(error: unknown) {
  if (error instanceof PublicError) {
    return apiFailureResponse({
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
      cause: error,
    });
  }

  return apiFailureResponse({
    status: 500,
    code: "INTERNAL_ERROR",
    message: INTERNAL_ERROR_MESSAGE,
    cause: error,
  });
}
