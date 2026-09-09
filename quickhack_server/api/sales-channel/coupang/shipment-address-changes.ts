// QuickHack note: Read-only list API for shipment address change work items.
import { NextRequest, NextResponse } from "next/server";
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

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/shipment-address-changes", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.address-change.read",
      source: "HTTP",
      route: "/api/coupang/shipment-address-changes",
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
  const status = request.nextUrl.searchParams.get("status");
  const limit = request.nextUrl.searchParams.get("limit");
  const cursor = request.nextUrl.searchParams.get("cursor");
  setOperationTraceField("shipment.status_filter_present", Boolean(status?.trim()));

  const { listShipmentAddressChangeRows } = await import(
    "@/quickhack_server/shipment/shipment-address-change-list-service"
  );
  const result = await traceOperationSpan("SERVICE_READ", () =>
    listShipmentAddressChangeRows({ status, limit, cursor })
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
