// QuickHack note: 쿠팡 반품 mock 데이터를 읽기 API 형태로 제공하는 테스트 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/mock/return-requests", {
      method: "GET",
      contentType: null,
    });
  }

  if (runtimeConfigService.isProduction()) {
    return NextResponse.json(
      { ok: false, code: "MOCK_MODE_REQUIRED" },
      { status: 403 }
    );
  }

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

  const { getCoupangRuntimeConfig } = await import(
    "@/quickhack_server/sales-channel/coupang/config"
  );
  const config = getCoupangRuntimeConfig();

  if (config.mode !== "mock") {
    return NextResponse.json(
      { ok: false, code: "MOCK_MODE_REQUIRED" },
      { status: 409 }
    );
  }

  const { getMockReturnRequests } = await import(
    "@/quickhack_server/sales-channel/coupang/mock-client"
  );
  const payload = await getMockReturnRequests({
    status: request.nextUrl.searchParams.get("status") || undefined,
  });

  return NextResponse.json({
    ok: true,
    source: payload.source,
    data: payload.payload,
  });
}
