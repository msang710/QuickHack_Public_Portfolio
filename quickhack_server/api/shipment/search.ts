import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
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
    return proxyToServer(request, "/api/shipments/search", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.delivery-search.read",
      source: "HTTP",
      route: "/api/shipments/search",
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

      const {
        searchShipmentDeliveryPackages,
        ShipmentDeliverySearchValidationError,
      } = await import(
        "@/quickhack_server/shipment/shipment-delivery-search-service"
      );

      try {
        const result = await traceOperationSpan("SERVICE_READ", () =>
          searchShipmentDeliveryPackages({
            dateBasis: request.nextUrl.searchParams.get("dateBasis"),
            from: request.nextUrl.searchParams.get("from"),
            to: request.nextUrl.searchParams.get("to"),
            stage: request.nextUrl.searchParams.get("stage"),
            carrier: request.nextUrl.searchParams.get("carrier"),
            packing: request.nextUrl.searchParams.get("packing"),
            review: request.nextUrl.searchParams.get("review"),
            search: request.nextUrl.searchParams.get("search"),
            cursor: request.nextUrl.searchParams.get("cursor"),
            limit: request.nextUrl.searchParams.get("limit"),
          })
        );
        setOperationTraceTargetCount(result.items.length);
        return NextResponse.json({
          ok: true,
          ...result,
          count: result.items.length,
        });
      } catch (error) {
        if (error instanceof ShipmentDeliverySearchValidationError) {
          return apiFailureResponse({
            status: 400,
            code: "INVALID_SHIPMENT_SEARCH",
            cause: error,
          });
        }
        return apiErrorResponse(error);
      }
    }
  );
}
