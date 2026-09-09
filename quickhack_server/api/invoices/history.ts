import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/invoices/history${request.nextUrl.search}`,
      { method: "GET", contentType: null }
    );
  }
  const [{ getAuthUserFromRequest }, { listCarrierInvoiceHistory }] =
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
    const result = await listCarrierInvoiceHistory({
      search: request.nextUrl.searchParams.get("search"),
      status: request.nextUrl.searchParams.get("status"),
      cursor: request.nextUrl.searchParams.get("cursor"),
      limit: request.nextUrl.searchParams.get("limit"),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
