// QuickHack note: 수집된 쿠팡 주문 데이터를 UI 조회용으로 반환하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
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

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/orders", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.orders.read",
      source: "HTTP",
      route: "/api/coupang/orders",
      method: "GET",
    },
    async () => {

  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "VIEWER")) {
    return NextResponse.json(
      { ok: false, code: "FORBIDDEN" },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);

  const mode = request.nextUrl.searchParams.get("mode");
  const limit = request.nextUrl.searchParams.get("limit");
  const cursor = request.nextUrl.searchParams.get("cursor");
  setOperationTraceField("shipment.mode", mode === "matched" ? "matched" : "all");

  const { listShipmentOrderItems } = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );
  const result = await traceOperationSpan("SERVICE_READ", () =>
    listShipmentOrderItems({ mode, limit, cursor })
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
