import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

function path(workId: string) {
  return `/api/invoices/replacements/${encodeURIComponent(workId)}`;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ replacementWorkId: string }> }
) {
  const { replacementWorkId } = await context.params;
  if (isClientRuntime()) {
    return proxyToServer(request, path(replacementWorkId), {
      method: "GET",
      contentType: null,
    });
  }
  const [
    { getAuthUserFromRequest },
    { getCarrierInvoiceReplacement },
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
  try {
    const replacement = await getCarrierInvoiceReplacement({
      replacementWorkId,
    });
    return NextResponse.json({ ok: true, replacement });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ replacementWorkId: string }> }
) {
  const { replacementWorkId } = await context.params;
  if (isClientRuntime()) {
    return proxyToServer(request, path(replacementWorkId), {
      method: "PATCH",
      body: await request.text(),
    });
  }
  const [
    { getAuthUserFromRequest },
    replacementService,
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
      { ok: false, message: "송장 교체 작업 권한이 없습니다." },
      { status: 403 }
    );
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "").trim();
    const replacement =
      action === "confirmOldInvoiceHandling"
        ? await replacementService.confirmCarrierInvoiceOldHandling({
            replacementWorkId,
            userId: user.userId,
            note: body.note,
          })
        : action === "resume"
          ? await replacementService.resumeCarrierInvoiceReplacement({
              replacementWorkId,
              userId: user.userId,
            })
          : action === "cancel"
            ? await replacementService.cancelCarrierInvoiceReplacement({
                replacementWorkId,
                userId: user.userId,
                note: body.note,
              })
            : null;
    if (!replacement) {
      return NextResponse.json(
        { ok: false, message: "지원하지 않는 송장 교체 작업입니다." },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true, replacement });
  } catch (error) {
    if (error instanceof replacementService.CarrierInvoiceReplacementError) {
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
