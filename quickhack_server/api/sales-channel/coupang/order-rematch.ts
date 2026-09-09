import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import {
  SENSITIVE_ACTIONS,
  sensitiveAuthRequiredResponse,
} from "@/quickhack_shared/auth/sensitive-auth";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
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
    return proxyToServer(request, "/api/coupang/order-rematch", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "sales-channel.order-rematch.execute",
      source: "HTTP",
      route: "/api/coupang/order-rematch",
      method: "POST",
    },
    async () => {
      const {
        getAuthSessionFromRequest,
        getAuthUserFromRequest,
        isSensitiveSessionVerified,
      } = await import("@/quickhack_server/auth/auth-service");
      const user = await getAuthUserFromRequest(request);

      if (!user) {
        return NextResponse.json(
          { ok: false, code: "AUTH_REQUIRED" },
          { status: 401 }
        );
      }

      if (!canAccessRole(user.role, "MANAGER")) {
        return NextResponse.json(
          { ok: false, code: "FORBIDDEN" },
          { status: 403 }
        );
      }

      const session = await getAuthSessionFromRequest(request);

      if (
        !session ||
        !isSensitiveSessionVerified(
          session,
          SENSITIVE_ACTIONS.channelOrderMatching
        )
      ) {
        return NextResponse.json(
          sensitiveAuthRequiredResponse(SENSITIVE_ACTIONS.channelOrderMatching),
          { status: 403 }
        );
      }

      const body = parseJsonObject(bodyText);

      if (!body) {
        return NextResponse.json(
          { ok: false, code: "INVALID_BODY" },
          { status: 400 }
        );
      }

      setOperationTraceUserId(user.userId);

      try {
        const { runManagedCoupangOrderRematch } = await import(
          "@/quickhack_server/sales-channel/coupang/order-rematch-service"
        );
        const data = await traceOperationSpan("SERVICE_WRITE", () =>
          runManagedCoupangOrderRematch(body, user)
        );
        setOperationTraceTargetCount(data.reset.workItemCount);

        return NextResponse.json({ ok: true, data });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}
