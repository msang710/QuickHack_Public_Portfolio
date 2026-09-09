import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { apiErrorResponse, apiFailureResponse } from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ clientRecordId?: string }> };

function jsonObject(text: string) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function staffUser(request: NextRequest) {
  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);
  if (!user) return { response: apiFailureResponse({ status: 401, code: "AUTHENTICATION_REQUIRED" }) } as const;
  if (!canAccessRole(user.role, "STAFF")) return { response: apiFailureResponse({ status: 403, code: "PERMISSION_DENIED" }) } as const;
  return { user } as const;
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inspection-pg-reservations", { method: "POST", body: bodyText });
  }
  return runOperationTrace({
    operationName: "inspection.pg.reserve", source: "HTTP",
    route: "/api/inspection-pg-reservations", method: "POST", targetCount: 1,
  }, async () => {
    const auth = await staffUser(request);
    if ("response" in auth) return auth.response;
    setOperationTraceUserId(auth.user.userId);
    const body = jsonObject(bodyText);
    if (!body) return apiFailureResponse({ status: 400, code: "INVALID_REQUEST_BODY" });
    try {
      const [{ prisma }, { reserveInspectionPg, inspectionPgAutoIssuanceEnabled }] = await Promise.all([
        import("@/quickhack_server/core/prisma"),
        import("@/quickhack_server/inspection/pg-issuance-service"),
      ]);
      if (!inspectionPgAutoIssuanceEnabled()) {
        return apiFailureResponse({ status: 503, code: "PG_AUTO_ISSUANCE_DISABLED" });
      }
      const result = await traceOperationSpan("SERVICE_WRITE", () => reserveInspectionPg(prisma, body, auth.user));
      return NextResponse.json({ ok: true, result });
    } catch (error) {
      return apiErrorResponse(error);
    }
  });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { clientRecordId = "" } = await context.params;
  if (isClientRuntime()) {
    return proxyToServer(request, `/api/inspection-pg-reservations/${encodeURIComponent(clientRecordId)}`, { method: "DELETE", contentType: null });
  }
  return runOperationTrace({
    operationName: "inspection.pg.abandon", source: "HTTP",
    route: "/api/inspection-pg-reservations/[clientRecordId]", method: "DELETE", targetCount: 1,
  }, async () => {
    const auth = await staffUser(request);
    if ("response" in auth) return auth.response;
    setOperationTraceUserId(auth.user.userId);
    try {
      const [{ prisma }, { abandonInspectionPg }] = await Promise.all([
        import("@/quickhack_server/core/prisma"),
        import("@/quickhack_server/inspection/pg-issuance-service"),
      ]);
      const result = await traceOperationSpan("SERVICE_WRITE", () => abandonInspectionPg(prisma, decodeURIComponent(clientRecordId), auth.user));
      return NextResponse.json({ ok: true, result });
    } catch (error) {
      return apiErrorResponse(error);
    }
  });
}
