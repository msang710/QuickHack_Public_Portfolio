import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/invoices/replacements${request.nextUrl.search}`,
      { method: "GET", contentType: null }
    );
  }
  const [
    { getAuthUserFromRequest },
    { listCarrierInvoiceReplacements },
  ] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import(
      "@/quickhack_server/shipment/carrier-integration/coupang-invoice-replacement-service"
    ),
  ]);
  const user = await getAuthUserFromRequest(request);
  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }
  if (!canAccessRole(user.role, "MANAGER")) {
    return NextResponse.json(
      { ok: false, message: "송장 교체 작업 조회 권한이 없습니다." },
      { status: 403 }
    );
  }
  const result = await listCarrierInvoiceReplacements({
    status: request.nextUrl.searchParams.get("status"),
    scope: request.nextUrl.searchParams.get("scope"),
    search: request.nextUrl.searchParams.get("search"),
    limit: request.nextUrl.searchParams.get("limit"),
    cursor: request.nextUrl.searchParams.get("cursor"),
  });
  return NextResponse.json({ ok: true, ...result });
}

export async function POST(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/invoices/replacements", {
      method: "POST",
      body: await request.text(),
    });
  }
  const [
    { getAuthUserFromRequest },
    {
      CarrierInvoiceReplacementError,
      startCarrierInvoiceReplacement,
    },
  ] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import(
      "@/quickhack_server/shipment/carrier-integration/coupang-invoice-replacement-service"
    ),
  ]);
  const user = await getAuthUserFromRequest(request);
  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }
  if (!canAccessRole(user.role, "MANAGER")) {
    return NextResponse.json(
      { ok: false, message: "송장 재발급 권한이 없습니다." },
      { status: 403 }
    );
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const replacement = await startCarrierInvoiceReplacement({
      packageGroupId: body.packageGroupId,
      sourceType: body.sourceType,
      shipmentAddressChangeWorkId: body.shipmentAddressChangeWorkId,
      reasonCode: body.reasonCode,
      reasonNote: body.reasonNote,
      userId: user.userId,
    });
    return NextResponse.json({ ok: true, replacement }, { status: 201 });
  } catch (error) {
    if (error instanceof CarrierInvoiceReplacementError) {
      const status = error.status === 400 || error.status === 404 ? error.status : 409;
      return apiFailureResponse({
        status,
        code: error.code,
        message: error.message,
        cause: error,
      });
    }

    return apiErrorResponse(error);
  }
}
