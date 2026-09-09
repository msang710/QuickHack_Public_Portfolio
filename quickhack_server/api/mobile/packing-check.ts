import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  runOperationTrace,
  setOperationTraceField,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

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
    return proxyToServer(request, "/api/mobile/packing-check", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.packing-check",
      source: "HTTP",
      route: "/api/mobile/packing-check",
      method: "POST",
      targetCount: 1,
    },
    async () => {

  const { getAuthSessionFromRequest, toAuthUser } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const session = await getAuthSessionFromRequest(request);

  if (!session) {
    return NextResponse.json(
      { ok: false, code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  const user = toAuthUser(session.users);
  if (!user.mobilePackingEnabled) {
    return NextResponse.json(
      { ok: false, code: "FORBIDDEN" },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, code: "INVALID_BODY" },
      { status: 400 }
    );
  }

  try {
    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      import("@/quickhack_server/mobile/packing-check-service").then(
        ({ checkPackingIntegrity }) =>
          checkPackingIntegrity(body, user, {
            actor: user,
            sessionId: session.session_id,
            scope: "SELF",
          })
      )
    );
    setOperationTraceField("packing.result_code", result.code);

    return NextResponse.json({
      ok: true,
      data: result,
    });
  } catch (error) {
    const { MobileDeviceAuthError } = await import(
      "@/quickhack_server/mobile/mobile-device-service"
    );

    if (error instanceof MobileDeviceAuthError) {
      return apiFailureResponse({
        status: 403,
        code: "MOBILE_DEVICE_AUTH_FAILED",
        cause: error,
      });
    }

    return apiErrorResponse(error);
  }
    }
  );
}
