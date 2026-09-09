// QuickHack note: 판매 채널 상품/옵션 구조를 읽기 전용으로 조회하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/channel-products", {
      method: "GET",
      contentType: null,
    });
  }

  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
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

  const { listCoupangChannelProducts } = await import(
    "@/quickhack_server/sales-channel/coupang/product-mapping-service"
  );
  try {
    const result = await listCoupangChannelProducts();

    return NextResponse.json({
      ok: true,
      items: result.items,
      count: result.items.length,
      completeness: result.completeness,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
