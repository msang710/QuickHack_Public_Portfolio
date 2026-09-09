// QuickHack note: 시스템 관리의 주문 매칭 운영 정책 조회/저장 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { publicBadRequest } from "@/quickhack_server/core/public-error";
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
    return proxyToServer(request, "/api/admin/order-matching-policies", {
      method: "GET",
      contentType: null,
    });
  }

  const authResult = await auth(request, "VIEWER");

  if ("response" in authResult) {
    return authResult.response;
  }

  const { listOrderMatchingPolicies } = await import(
    "@/quickhack_server/sales-channel/order-matching-policy-service"
  );
  const data = await listOrderMatchingPolicies();

  return NextResponse.json({ ok: true, data });
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/order-matching-policies", {
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
    const {
      resetSalesOfferOrderMatchingPolicy,
      saveSalesOfferOrderMatchingPolicy,
    } = await import("@/quickhack_server/sales-channel/order-matching-policy-service");

    if (body.action === "resetSalesOfferPolicy") {
      const item = await resetSalesOfferOrderMatchingPolicy(body, authResult.user);

      return NextResponse.json({ ok: true, item });
    }

    if (body.action === "saveSalesOfferPolicy") {
      const item = await saveSalesOfferOrderMatchingPolicy(body, authResult.user);

      return NextResponse.json({ ok: true, item });
    }

    throw publicBadRequest(
      "INVALID_ORDER_MATCHING_POLICY_ACTION",
      "INVALID_ORDER_MATCHING_POLICY_ACTION"
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
