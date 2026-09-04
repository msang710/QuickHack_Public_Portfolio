// QuickHack note: 판매 상품 조합 조건으로 주문 매칭 가능한 재고 후보를 조회하는 서버 API입니다.
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
    return proxyToServer(request, "/api/coupang/inventory-candidates", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.inventory-candidates.read",
      source: "HTTP",
      route: "/api/coupang/inventory-candidates",
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

  const externalVendorItemId = request.nextUrl.searchParams
    .get("externalVendorItemId")
    ?.trim();

  if (!externalVendorItemId) {
    return NextResponse.json(
      { ok: false, code: "EXTERNAL_VENDOR_ITEM_ID_REQUIRED" },
      { status: 400 }
    );
  }

  const { getCoupangInventoryCandidates } = await import(
    "@/quickhack_server/sales-channel/coupang/product-mapping-service"
  );

  const data = await traceOperationSpan("SERVICE_READ", () =>
    getCoupangInventoryCandidates(externalVendorItemId)
  );
  setOperationTraceTargetCount(data.candidates.length);

  return NextResponse.json({
    ok: true,
    data,
  });
    }
  );
}
