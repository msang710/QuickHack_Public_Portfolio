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
    return proxyToServer(request, "/api/inventory/audit-candidates", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "inventory.audit-candidates.read",
      source: "HTTP",
      route: "/api/inventory/audit-candidates",
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

        });
      }
      if (!canAccessRole(user.role, "STAFF")) {
        return apiFailureResponse({
          status: 403,
          code: "PERMISSION_DENIED",

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
              DEVICE_LIST_CONTEXT.audit
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
