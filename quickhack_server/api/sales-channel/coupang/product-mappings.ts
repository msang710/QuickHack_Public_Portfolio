// QuickHack note: 쿠팡 vendorItemId와 판매 상품 조합 매핑을 조회/저장하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { SENSITIVE_ACTIONS } from "@/quickhack_shared/auth/sensitive-auth";
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
  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return {
      response: NextResponse.json(
        { ok: false, code: "AUTH_REQUIRED" },
        { status: 401 }
      ),
    };
  }

  if (!canAccessRole(user.role, minRole)) {
    return {
      response: NextResponse.json(
        { ok: false, code: "FORBIDDEN" },
        { status: 403 }
      ),
    };
  }

  return { user };
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/product-mappings", {
      method: "GET",
      contentType: null,
    });
  }

  const authResult = await auth(request, "VIEWER");

  if ("response" in authResult) {
    return authResult.response;
  }

  const { listCoupangProductMappings } = await import(
    "@/quickhack_server/sales-channel/coupang/product-mapping-service"
  );
  const items = await listCoupangProductMappings();

  return NextResponse.json({ ok: true, items, count: items.length });
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/product-mappings", {
      method: "POST",
      body: bodyText,
    });
  }

  const authResult = await auth(request, "MANAGER");

  if ("response" in authResult) {
    return authResult.response;
  }

  const {
    getAuthSessionFromRequest,
    isSensitiveSessionVerified,
  } = await import("@/quickhack_server/auth/auth-service");
  const session = await getAuthSessionFromRequest(request);

  if (
    !session ||
    !isSensitiveSessionVerified(session, SENSITIVE_ACTIONS.channelOrderMatching)
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "SENSITIVE_AUTH_REQUIRED",
        sensitiveAuthRequired: true,
        sensitiveAction: SENSITIVE_ACTIONS.channelOrderMatching,
      },
      { status: 403 }
    );
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, code: "INVALID_BODY" },
      { status: 400 }
    );
  }

  try {
    if (body.action !== "set") {
      return NextResponse.json(
        {
          ok: false,
          code: "COUPANG_PRODUCT_MAPPING_ACTION_INVALID",

        },
        { status: 400 }
      );
    }

    const { setCoupangProductMapping } = await import(
      "@/quickhack_server/sales-channel/coupang/product-mapping-service"
    );

    const item = await setCoupangProductMapping(body, authResult.user);

    return NextResponse.json({ ok: true, item, data: item });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
