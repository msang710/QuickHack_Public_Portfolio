// QuickHack note: Coupang orders currently in delivery status.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  runOperationTrace,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/delivering", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.delivering.read",
      source: "HTTP",
      route: "/api/coupang/delivering",
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
      { ok: false, message: "배송중 목록 조회 권한이 없습니다." },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);

  const { listDeliveringShipmentItems } = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );
  const result = await traceOperationSpan("SERVICE_READ", () =>
    listDeliveringShipmentItems({
      limit: request.nextUrl.searchParams.get("limit"),
    })
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
