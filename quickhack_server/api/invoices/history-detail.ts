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
  const path = `/api/invoices/history/${encodeURIComponent(
    carrierShipmentId
  )}`;
  if (isClientRuntime()) {
    return proxyToServer(request, path, {
      method: "GET",
      contentType: null,
    });
  }
  const [{ getAuthUserFromRequest }, { getCarrierInvoiceHistoryDetail }] =
    await Promise.all([
      import("@/quickhack_server/auth/auth-service"),
      import(
        "@/quickhack_server/shipment/carrier-integration/invoice-operation-query-service"
      ),
    ]);
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
  try {
    const history = await getCarrierInvoiceHistoryDetail({
      carrierShipmentId,
    });
    return NextResponse.json({ ok: true, history });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
