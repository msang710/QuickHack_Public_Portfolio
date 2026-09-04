import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { publicBadRequest } from "@/quickhack_server/core/public-error";
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

async function auth(request: NextRequest) {
  const { authorizeAccountManagement } = await import(
    "@/quickhack_server/auth/account-management-access"
  );
  const authorization = await authorizeAccountManagement(request);
  return authorization.authorized
    ? {
        user: authorization.user,
        securityContext: {
          ...authorization.securityContext,
          scope: "ACCOUNT_MANAGEMENT" as const,
        },
      }
    : { response: authorization.response };
}

function parseOptionalUserId(value: string | null) {
  if (!value) return null;
  const userId = Number(value);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw publicBadRequest("INVALID_ACCOUNT_ID", "INVALID_ACCOUNT_ID");
  }
  return userId;
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    const query = request.nextUrl.searchParams.toString();
    return proxyToServer(
      request,
      `/api/admin/mobile-devices${query ? `?${query}` : ""}`,
      { method: "GET", contentType: null }
    );
  }
  const authResult = await auth(request);
  if ("response" in authResult) return authResult.response;
  try {
    const { listMobileRegisteredDevices } = await import(
      "@/quickhack_server/mobile/mobile-device-service"
    );
    const page = await listMobileRegisteredDevices({
      userId: parseOptionalUserId(request.nextUrl.searchParams.get("userId")),
      cursor: request.nextUrl.searchParams.get("cursor"),
      limit: request.nextUrl.searchParams.get("limit"),
    });
    return NextResponse.json({ ok: true, ...page });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/mobile-devices", {
      method: "POST",
      body: bodyText,
    });
  }
  const authResult = await auth(request);
  if ("response" in authResult) return authResult.response;
  const body = parseJsonObject(bodyText);
  if (!body) {
    return NextResponse.json(
      { ok: false, code: "INVALID_BODY" },
      { status: 400 }
    );
  }
  try {
    const {
      beginMobileDeviceProvisioning,
      cancelMobileDeviceProvisioning,
      revokeMobileDevice,
    } = await import("@/quickhack_server/mobile/mobile-device-service");
    const action = String(body.action ?? "").trim();
    if (action === "beginProvisioning" || action === "reprovision") {
      const result = await beginMobileDeviceProvisioning(
        {
          userId: body.userId,
          adbSerial: body.adbSerial,
          label: body.label,
          deviceId: action === "reprovision" ? body.deviceId : undefined,
          expectedRegistrationRevision:
            action === "reprovision" ? body.expectedRegistrationRevision : undefined,
        },
        authResult.securityContext
      );
      return NextResponse.json({
        ok: true,
        resultCode: "MOBILE_DEVICE_PROVISION_STARTED",
        ...result,
      });
    }
    if (action === "cancelProvisioning") {
      const item = await cancelMobileDeviceProvisioning(
        {
          deviceId: body.deviceId,
          expectedRegistrationRevision: body.expectedRegistrationRevision,
          provisioningToken: body.provisioningToken,
        },
        authResult.securityContext
      );
      return NextResponse.json({ ok: true, item });
    }
    if (action === "revoke") {
      const item = await revokeMobileDevice(
        {
          deviceId: body.deviceId,
          expectedRegistrationRevision: body.expectedRegistrationRevision,
        },
        authResult.securityContext
      );
      return NextResponse.json({ ok: true, resultCode: "MOBILE_DEVICE_REVOKED", item });
    }
    return NextResponse.json(
      { ok: false, code: "ACTION_UNSUPPORTED" },
      { status: 400 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
