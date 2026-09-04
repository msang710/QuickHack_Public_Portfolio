import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ carrierShipmentId: string }> }
) {
  const { carrierShipmentId } = await context.params;
  const path = `/api/shipments/tracking-events/${encodeURIComponent(carrierShipmentId)}${request.nextUrl.search}`;
  if (isClientRuntime()) {
    return proxyToServer(request, path, { method: "GET", contentType: null });
  }

  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });
  }
  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  try {
    const { listCarrierTrackingEventPage } = await import(
      "@/quickhack_server/shipment/carrier-integration/tracking-event-query-service"
    );
    const result = await listCarrierTrackingEventPage({
      carrierShipmentId,
      cursor: request.nextUrl.searchParams.get("cursor"),
      limit: request.nextUrl.searchParams.get("limit"),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
