import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { DEVICE_LIST_CONTEXT } from "@/quickhack_shared/device/device-list-query";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inbound/purchase-pending", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "inbound.purchase-pending.read",
      source: "HTTP",
      route: "/api/inbound/purchase-pending",
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
      if (!canAccessRole(user.role, "MANAGER")) {
        return apiFailureResponse({
          status: 403,
          code: "PERMISSION_DENIED",
          message: "매입 대기 목록 조회 권한이 없습니다.",
        });
      }
      setOperationTraceUserId(user.userId);

      try {
        const {
          deviceListQueryInputFromSearchParams,
          queryDeviceListPage,
        } = await import(
          "@/quickhack_server/inventory/device-list-query-service"
        );
        const data = await traceOperationSpan("SERVICE_READ", () =>
          queryDeviceListPage(
            deviceListQueryInputFromSearchParams(
              request.nextUrl.searchParams,
              DEVICE_LIST_CONTEXT.purchasePending
            )
          )
        );
        setOperationTraceTargetCount(data.items.length);
        return NextResponse.json({ ok: true, data });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}
