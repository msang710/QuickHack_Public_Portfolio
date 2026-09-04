// QuickHack note: 명시적 주문 재매칭의 안전한 대상과 제외 사유를 조회하는 읽기 전용 API입니다.
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
    return proxyToServer(
      request,
      `/api/coupang/order-rematch-preview${request.nextUrl.search}`,
      { method: "GET", contentType: null }
    );
  }

  return runOperationTrace(
    {
      operationName: "sales-channel.order-rematch-preview.read",
      source: "HTTP",
      route: "/api/coupang/order-rematch-preview",
      method: "GET",
    },
    async () => {
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

      if (!canAccessRole(user.role, "MANAGER")) {
        return NextResponse.json(
          { ok: false, code: "FORBIDDEN" },
          { status: 403 }
        );
      }
      setOperationTraceUserId(user.userId);

      const { listCoupangOrderRematchPreview } = await import(
        "@/quickhack_server/sales-channel/coupang/order-rematch-preview-service"
      );
      const data = await traceOperationSpan("SERVICE_READ", () =>
        listCoupangOrderRematchPreview({
          cursor: request.nextUrl.searchParams.get("cursor"),
          limit: request.nextUrl.searchParams.get("limit"),
        })
      );
      setOperationTraceTargetCount(data.items.length);

      return NextResponse.json({ ok: true, data });
    }
  );
}
