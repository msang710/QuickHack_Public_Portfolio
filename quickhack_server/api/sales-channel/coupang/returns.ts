// QuickHack note: Coupang return lists and pre-shipment return actions.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  runOperationTrace,
  setOperationTraceField,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";
import { SalesChannelWriteReviewRequiredError } from "@/quickhack_server/sales-channel/write/sales-channel-write-service";

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

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/returns", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "return.list.read",
      source: "HTTP",
      route: "/api/coupang/returns",
      method: "GET",
    },
    async () => {

  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, message: "반품 목록 조회 권한이 없습니다." },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);
  const phase = request.nextUrl.searchParams.get("phase");
  const limit = request.nextUrl.searchParams.get("limit");
  const cursor = request.nextUrl.searchParams.get("cursor");
  setOperationTraceField("return.phase", phase === "after" ? "after" : "before");
  const { listCoupangReturnRows } = await import(
    "@/quickhack_server/returns/return-list-service"
  );
  const result = await traceOperationSpan("SERVICE_READ", () =>
    listCoupangReturnRows({ phase, limit, cursor })
  );
  setOperationTraceTargetCount(result.items.length);

  return NextResponse.json({
    ok: true,
    ...result,
    count: result.items.length,
  });
    }
  );
}

export async function PATCH(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/returns", {
      method: "PATCH",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "return.action",
      source: "HTTP",
      route: "/api/coupang/returns",
      method: "PATCH",
    },
    async () => {

  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, message: "반품 처리 권한이 없습니다." },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, message: "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }
  setOperationTraceField("return.action", body.action);
  setOperationTraceTargetCount(
    Array.isArray(body.allocationIds) ? body.allocationIds.length : 1
  );

  try {
    const { processCoupangPreShipmentReturnAction } = await import(
      "@/quickhack_server/returns/return-action-service"
    );
    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      processCoupangPreShipmentReturnAction({
        returnRawId: body.returnRawId,
        expectedProjectionRevision: body.expectedProjectionRevision,
        action: body.action,
        allocationIds: body.allocationIds,
        returnInspections: body.returnInspections,
        userId: user.userId,
      })
    );

    return NextResponse.json({
      ok: true,
      completed: true,
      reviewRequired: false,
      message: `${result.actionLabel} 처리되었습니다.`,
      ...result,
    });
  } catch (error) {
    if (error instanceof SalesChannelWriteReviewRequiredError) {
      return NextResponse.json(
        {
          ok: true,
          completed: false,
          reviewRequired: true,
          writeRequestId: error.requestId,
          message:
            "쿠팡 상태를 자동으로 확정하지 못해 판매 채널 동기화 점검으로 이동했습니다.",
        },
        { status: 202 }
      );
    }

    return apiErrorResponse(error);
  }
    }
  );
}
