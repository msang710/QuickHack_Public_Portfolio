// QuickHack note: 쿠팡 주문 mock 데이터를 읽기 API 형태로 제공하는 테스트 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/mock/ordersheets", {
      method: "GET",
      contentType: null,
    });
  }

  if (runtimeConfigService.isProduction()) {
    return NextResponse.json(
      { ok: false, message: "운영 모드에서는 쿠팡 mock 주문 조회를 사용할 수 없습니다." },
      { status: 403 }
    );
  }

  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "VIEWER")) {
    return NextResponse.json(
      { ok: false, message: "쿠팡 mock 주문 조회 권한이 없습니다." },
      { status: 403 }
    );
  }

  const { getCoupangRuntimeConfig } = await import(
    "@/quickhack_server/sales-channel/coupang/config"
  );
  const config = getCoupangRuntimeConfig();

  if (config.mode !== "mock") {
    return NextResponse.json(
      { ok: false, message: "쿠팡 API 모드가 mock일 때만 mock 서버 데이터를 제공합니다." },
      { status: 409 }
    );
  }

  const { getMockOrdersheets } = await import(
    "@/quickhack_server/sales-channel/coupang/mock-client"
  );
  const payload = await getMockOrdersheets({
    status: request.nextUrl.searchParams.get("status") || undefined,
    nextToken: request.nextUrl.searchParams.get("nextToken"),
  });

  return NextResponse.json({
    ok: true,
    source: payload.source,
    data: payload.payload,
  });
}
