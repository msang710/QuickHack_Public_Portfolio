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
    return proxyToServer(request, "/api/shipments/in-transit", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.tracking-list.read",
      source: "HTTP",
      route: "/api/shipments/in-transit",
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
      if (!canAccessRole(user.role, "STAFF")) {
        return NextResponse.json(
          { ok: false, code: "FORBIDDEN" },
          { status: 403 }
        );
      }
      setOperationTraceUserId(user.userId);

      const { listInTransitPackageGroups } = await import(
        "@/quickhack_server/shipment/shipment-tracking-query-service"
      );
      const result = await traceOperationSpan("SERVICE_READ", () =>
        listInTransitPackageGroups({
          limit: request.nextUrl.searchParams.get("limit"),
          cursor: request.nextUrl.searchParams.get("cursor"),
        })
      );
      setOperationTraceTargetCount(result.items.length);
      return NextResponse.json({
        ok: true,
        ...result,
        count: result.items.length,
      });
    }
  );
}
