import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { isDeviceHistorySection } from "@/quickhack_shared/device/device-history";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ pgNo?: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const pgNo = String(params.pgNo || "").trim().toUpperCase();

  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/inventory/devices/${encodeURIComponent(pgNo)}/history${request.nextUrl.search}`,
      { method: "GET", contentType: null }
    );
  }

  return runOperationTrace(
    {
      operationName: "inventory.device-history.read",
      source: "HTTP",
      route: "/api/inventory/devices/[pgNo]/history",
      method: "GET",
      targetCount: 1,
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
      if (!canAccessRole(user.role, "VIEWER")) {
        return apiFailureResponse({
          status: 403,
          code: "PERMISSION_DENIED",
          message: "기기 이력 조회 권한이 없습니다.",
        });
      }
      const section = request.nextUrl.searchParams.get("section") ?? "";
      if (!pgNo || !isDeviceHistorySection(section)) {
        return apiFailureResponse({
          status: 400,
          code: "DEVICE_HISTORY_QUERY_INVALID",
          message: "PG 번호와 올바른 이력 구분이 필요합니다.",
        });
      }
      setOperationTraceUserId(user.userId);

      try {
        const { getDeviceHistoryPage } = await import(
          "@/quickhack_server/inventory/device-history-query-service"
        );
        const data = await traceOperationSpan("SERVICE_READ", () =>
          getDeviceHistoryPage({
            pgNo,
            section,
            cursor: request.nextUrl.searchParams.get("cursor"),
            limit: request.nextUrl.searchParams.get("limit"),
          })
        );
        if (!data) {
          return apiFailureResponse({
            status: 404,
            code: "DEVICE_NOT_FOUND",
            message: "기기를 찾을 수 없습니다.",
          });
        }
        return NextResponse.json({ ok: true, data });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}
