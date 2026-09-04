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
  setOperationTraceField,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inventory/devices", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "inventory.device-list.read",
      source: "HTTP",
      route: "/api/inventory/devices",
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
      if (!canAccessRole(user.role, "VIEWER")) {
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
        const requestedContext =
          request.nextUrl.searchParams.get("context")?.toUpperCase() ||
          DEVICE_LIST_CONTEXT.inventory;
        if (
          requestedContext !== DEVICE_LIST_CONTEXT.inventory &&
          requestedContext !== DEVICE_LIST_CONTEXT.correction
        ) {
          return apiFailureResponse({
            status: 400,
            code: "DEVICE_LIST_CONTEXT_INVALID",

          });
        }
        const context = requestedContext;
        const data = await traceOperationSpan("SERVICE_READ", () =>
          queryDeviceListPage(
            deviceListQueryInputFromSearchParams(
              request.nextUrl.searchParams,
              context
            )
          )
        );
        setOperationTraceField("inventory.list_context", context);
        setOperationTraceTargetCount(data.items.length);
        return NextResponse.json({ ok: true, data });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}
