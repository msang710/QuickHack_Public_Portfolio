import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  CLIENT_TRACE_OBSERVATION_PATH,
  type ClientHttpTraceObservationInput,
} from "@/quickhack_shared/observability/http-trace";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, CLIENT_TRACE_OBSERVATION_PATH, {
      method: "POST",
      body: bodyText,
      contentType: "application/json",
    });
  }

  const [{ getAuthUserFromRequest }, service] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/observability/client-trace-service"),
  ]);
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  if (bodyText.length > 65_536) {
    return NextResponse.json(
      { ok: false, code: "REQUEST_BODY_TOO_LARGE" },
      { status: 413 }
    );
  }

  let payload: unknown;

  try {
    payload = JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { ok: false, code: "INVALID_JSON_BODY" },
      { status: 400 }
    );
  }

  let items: ClientHttpTraceObservationInput[];

  try {
    items = service.normalizeClientTraceBatch(payload);
  } catch (error) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_CLIENT_TRACE_DATA",
      cause: error,
    });
  }

  try {
    await service.saveClientTraceObservations({ userId: user.userId, items });
    return NextResponse.json({ ok: true, acceptedCount: items.length });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
