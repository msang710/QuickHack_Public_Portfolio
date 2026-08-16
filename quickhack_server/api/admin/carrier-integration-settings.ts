import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { SENSITIVE_ACTIONS } from "@/quickhack_shared/auth/sensitive-auth";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

function parseJsonObject(text: string) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function leaderAuth(request: NextRequest) {
  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);
  if (!user) {
    return { response: NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 }) };
  }
  if (!canAccessRole(user.role, "LEADER")) {
    return { response: NextResponse.json({ ok: false, message: "택배사 발송 설정 권한이 없습니다." }, { status: 403 }) };
  }
  return { user };
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/carrier-integration-settings", {
      method: "GET",
      contentType: null,
    });
  }

  const auth = await leaderAuth(request);
  if ("response" in auth) return auth.response;

  try {
    const { getLogenIntegrationSettings } = await import(
      "@/quickhack_server/shipment/carrier-integration/logen/settings-service"
    );
    return NextResponse.json({ ok: true, item: await getLogenIntegrationSettings() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/carrier-integration-settings", {
      method: "POST",
      body: bodyText,
    });
  }

  const auth = await leaderAuth(request);
  if ("response" in auth) return auth.response;

  const { getAuthSessionFromRequest, isSensitiveSessionVerified } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const session = await getAuthSessionFromRequest(request);
  if (
    !session ||
    !isSensitiveSessionVerified(
      session,
      SENSITIVE_ACTIONS.carrierIntegrationSettings
    )
  ) {
    return NextResponse.json(
      {
        ok: false,
        message: "택배사 발송 설정을 변경하려면 OTP 인증이 필요합니다.",
        sensitiveAuthRequired: true,
        sensitiveAction: SENSITIVE_ACTIONS.carrierIntegrationSettings,
      },
      { status: 403 }
    );
  }

  const body = parseJsonObject(bodyText);
  if (!body) {
    return NextResponse.json(
      { ok: false, message: "요청 본문이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  try {
    const { saveLogenIntegrationSettings } = await import(
      "@/quickhack_server/shipment/carrier-integration/logen/settings-service"
    );
    const item = await saveLogenIntegrationSettings(body, auth.user);
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
