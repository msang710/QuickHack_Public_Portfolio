import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
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

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/mobile/activate-device", {
      method: "POST",
      body: bodyText,
    });
  }

  const { getAuthSessionFromRequest, toAuthUser } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const session = await getAuthSessionFromRequest(request);

  if (!session) {
    return NextResponse.json(
      { ok: false, message: "Login is required." },
      { status: 401 }
    );
  }

  const user = toAuthUser(session.users);
  if (!user.mobilePackingEnabled) {
    return NextResponse.json(
      { ok: false, message: "Packing check permission is required." },
      { status: 403 }
    );
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, message: "Request body must be a JSON object." },
      { status: 400 }
    );
  }

  try {
    const { activateMobileDevice } = await import(
      "@/quickhack_server/mobile/mobile-device-service"
    );
    const data = await activateMobileDevice(body, {
      actor: user,
      sessionId: session.session_id,
      scope: "SELF",
    });

    return NextResponse.json({
      ok: true,
      data,
    });
  } catch (error) {
    const { MobileDeviceAuthError } = await import(
      "@/quickhack_server/mobile/mobile-device-service"
    );

    if (error instanceof MobileDeviceAuthError) {
      return apiFailureResponse({
        status: error.status,
        code: error.code,
        message: error.message,
        cause: error,
      });
    }

    return apiErrorResponse(error);
  }
}
