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
  setOperationTraceField,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ packageGroupId: string }> }
) {
  const { packageGroupId } = await context.params;
  const path = `/api/shipments/search/${encodeURIComponent(packageGroupId)}`;

  if (isClientRuntime()) {
    return proxyToServer(request, path, {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.delivery-search-detail.read",
      source: "HTTP",
      route: "/api/shipments/search/[packageGroupId]",
      method: "GET",
    },
    async () => {
      const { getAuthUserFromRequest } = await import(
        "@/quickhack_server/auth/auth-service"
      );
      const user = await getAuthUserFromRequest(request);
      if (!user) {
        return NextResponse.json(
          { ok: false, message: "로그인이 필요합니다." },
          { status: 401 }
        );
      }
      if (!canAccessRole(user.role, "STAFF")) {
        return NextResponse.json(
          { ok: false, message: "배송 건 상세 조회 권한이 없습니다." },
          { status: 403 }
        );
      }
      setOperationTraceUserId(user.userId);
      setOperationTraceField("shipment.package_group_id", packageGroupId);

      const {
        getShipmentDeliveryPackageDetail,
        ShipmentDeliverySearchNotFoundError,
        ShipmentDeliverySearchValidationError,
      } = await import(
        "@/quickhack_server/shipment/shipment-delivery-search-service"
      );

      try {
        const detail = await traceOperationSpan("SERVICE_READ", () =>
          getShipmentDeliveryPackageDetail({ packageGroupId })
        );
        setOperationTraceTargetCount(1);
        return NextResponse.json({ ok: true, detail });
      } catch (error) {
        if (error instanceof ShipmentDeliverySearchValidationError) {
          return apiFailureResponse({
            status: 400,
            code: "INVALID_SHIPMENT_SEARCH_DETAIL",
            message: error.message,
            cause: error,
          });
        }
        if (error instanceof ShipmentDeliverySearchNotFoundError) {
          return apiFailureResponse({
            status: 404,
            code: "SHIPMENT_PACKAGE_NOT_FOUND",
            message: error.message,
            cause: error,
          });
        }
        return apiErrorResponse(error);
      }
    }
  );
}
