// QuickHack object: Exports purchase pending rows into purchase statement or Jungabi registration XLSX files.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
  setOperationTraceTargetCount,
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

function contentDisposition(filename: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inbound/purchase-export", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inbound.purchase.export",
      source: "HTTP",
      route: "/api/inbound/purchase-export",
      method: "POST",
    },
    async () => {

  const { getAuthSessionFromRequest, toAuthUser } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const session = await getAuthSessionFromRequest(request);

  if (!session) {
    return apiFailureResponse({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",

    });
  }

  const user = toAuthUser(session.users);
  setOperationTraceUserId(user.userId);

  if (!canAccessRole(user.role, "MANAGER")) {
    return apiFailureResponse({
      status: 403,
      code: "PERMISSION_DENIED",

    });
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_REQUEST_BODY",

    });
  }
  setOperationTraceTargetCount(Array.isArray(body.items) ? body.items.length : 0);

  try {
    const [{ prisma }, { buildPurchaseExportWorkbook, purchaseExportContentType }] =
      await Promise.all([
        import("@/quickhack_server/core/prisma"),
        import("@/quickhack_server/inbound/purchase-export-service"),
      ]);
    const workbook = await traceOperationSpan("SERVICE_READ", () =>
      buildPurchaseExportWorkbook(prisma, body)
    );

    return new NextResponse(new Uint8Array(workbook.buffer), {
      status: 200,
      headers: {
        "content-type": purchaseExportContentType(),
        "content-disposition": contentDisposition(workbook.filename),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}
