// QuickHack note: 판매 오퍼 목록 조회와 생성/활성 상태 변경을 처리합니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

function parseJsonObject(text: string) {
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function auth(request: NextRequest, minRole: "VIEWER" | "MANAGER") {
  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return {
      response: NextResponse.json(
        { ok: false, message: "로그인이 필요합니다." },
        { status: 401 }
      ),
    };
  }

  if (!canAccessRole(user.role, minRole)) {
    return {
      response: NextResponse.json(
        { ok: false, message: "판매 오퍼 접근 권한이 없습니다." },
        { status: 403 }
      ),
    };
  }

  return { user };
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/catalog/sales-offers", {
      method: "GET",
      contentType: null,
    });
  }

  const authResult = await auth(request, "VIEWER");

  if ("response" in authResult) {
    return authResult.response;
  }

  const { listSalesOffers } = await import(
    "@/quickhack_server/catalog/sales-offer-service"
  );
  const items = await listSalesOffers();

  return NextResponse.json({ ok: true, items, count: items.length });
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/catalog/sales-offers", {
      method: "POST",
      body: bodyText,
    });
  }

  const authResult = await auth(request, "MANAGER");

  if ("response" in authResult) {
    return authResult.response;
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, message: "요청 본문이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  try {
    const { saveSalesOffer } = await import(
      "@/quickhack_server/catalog/sales-offer-service"
    );
    const item = await saveSalesOffer(body, authResult.user);

    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
