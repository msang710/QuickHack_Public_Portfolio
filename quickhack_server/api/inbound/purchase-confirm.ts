// QuickHack note: 매입 확정 요청을 검증하고 입고/재고 상태를 함께 반영하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { SENSITIVE_ACTIONS } from "@/quickhack_shared/auth/sensitive-auth";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

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

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inbound/purchase-confirm", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inbound.purchase.confirm",
      source: "HTTP",
      route: "/api/inbound/purchase-confirm",
      method: "POST",
    },
    async () => {

  const {
    getAuthSessionFromRequest,
    isSensitiveSessionVerified,
    toAuthUser,
  } = await import("@/quickhack_server/auth/auth-service");
  const session = await getAuthSessionFromRequest(request);

  if (!session) {
    return apiFailureResponse({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",

    });
  }

  const user = toAuthUser(session.users);
  setOperationTraceUserId(user.userId);

  if (!canAccessRole(user.role, "MANAGER")) {
    return apiFailureResponse({
      status: 403,
      code: "PERMISSION_DENIED",

    });
  }

  if (!isSensitiveSessionVerified(session, SENSITIVE_ACTIONS.inboundPurchaseConfirm)) {
    return apiFailureResponse({
      status: 403,
      code: "SENSITIVE_AUTH_REQUIRED",

      extra: {
        sensitiveAuthRequired: true,
        sensitiveAction: SENSITIVE_ACTIONS.inboundPurchaseConfirm,
      },
    });
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_REQUEST_BODY",

    });
  }
  setOperationTraceTargetCount(Array.isArray(body.items) ? body.items.length : 0);

  try {
    const [{ prisma }, { confirmInboundPurchases }] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/inbound/purchase-confirm-service"),
    ]);
    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      confirmInboundPurchases(prisma, body, user)
    );
    return NextResponse.json({
      ok: true,
      resultCode: result.resultCode,
      messageArguments: result.messageArguments,
      confirmedCount: result.confirmedCount,
      recoveredCount: result.recoveredCount,
      skippedCount: result.skippedCount,
      conflictCount: result.conflictCount,
      results: result.results,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}
