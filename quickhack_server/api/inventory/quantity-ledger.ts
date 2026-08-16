import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
  setOperationTraceField,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/inventory/quantity-ledger${request.nextUrl.search}`
    );
  }

  return runOperationTrace(
    {
      operationName: "inventory.quantity-ledger.read",
      source: "HTTP",
      route: "/api/inventory/quantity-ledger",
      method: "GET",
    },
    async () => {

  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return apiFailureResponse({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      message: "로그인이 필요합니다.",
    });
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return apiFailureResponse({
      status: 403,
      code: "PERMISSION_DENIED",
      message: "재고 수량 원장 조회 권한이 없습니다.",
    });
  }
  setOperationTraceUserId(user.userId);
  const format = (
    request.nextUrl.searchParams.get("format") ?? ""
  )
    .trim()
    .toLowerCase();

  if (format && format !== "matrix") {
    return apiFailureResponse({
      status: 400,
      code: "INVENTORY_QUANTITY_FORMAT_INVALID",
      message: "지원하지 않는 재고 수량 원장 응답 형식입니다.",
    });
  }

  setOperationTraceField(
    "inventory.response_format",
    "matrix"
  );

  try {
    const { getInventoryQuantityMatrix } = await import(
      "@/quickhack_server/inventory/inventory-quantity-query-service"
    );
    const data = await traceOperationSpan("SERVICE_READ", () =>
      getInventoryQuantityMatrix()
    );
    setOperationTraceTargetCount(data.rows.length);

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}
