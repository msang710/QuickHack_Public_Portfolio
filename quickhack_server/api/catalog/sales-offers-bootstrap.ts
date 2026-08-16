// QuickHack note: 활성 기종마다 기본 판매 오퍼(용량/색상 제한 없음)를 생성합니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(
      request,
      "/api/catalog/sales-offers/bootstrap-from-criteria",
      { method: "POST", body: bodyText }
    );
  }

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

  if (!canAccessRole(user.role, "MANAGER")) {
    return NextResponse.json(
      { ok: false, message: "판매 오퍼 생성 권한이 없습니다." },
      { status: 403 }
    );
  }

  const { bootstrapSalesOffersFromCriteria } = await import(
    "@/quickhack_server/catalog/sales-offer-service"
  );

  return NextResponse.json({
    ok: true,
    data: await bootstrapSalesOffersFromCriteria(user),
  });
}
