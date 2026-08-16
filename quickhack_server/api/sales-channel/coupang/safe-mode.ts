// QuickHack note: 쿠팡 API 안전 모드 상태를 반환해 실수로 쓰기 호출되는 것을 방지합니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/safe-mode", {
      method: "GET",
      contentType: null,
    });
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
      { ok: false, message: "쿠팡 안전 모드 조회 권한이 없습니다." },
      { status: 403 }
    );
  }

  const { getCoupangSafeModeStatus } = await import(
    "@/quickhack_server/sales-channel/coupang/safe-mode-status"
  );

  return NextResponse.json({
    ok: true,
    data: await getCoupangSafeModeStatus(),
  });
}
