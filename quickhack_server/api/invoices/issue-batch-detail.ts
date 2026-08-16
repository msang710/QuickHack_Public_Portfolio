import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  runOperationTrace,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ issueBatchId?: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const issueBatchId = String(params.issueBatchId ?? "").trim();
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/invoices/issue-batches/${encodeURIComponent(issueBatchId)}`,
      { method: "GET", contentType: null }
    );
  }

  return runOperationTrace(
    {
      operationName: "carrier.invoice-issue.read",
      source: "HTTP",
      route: "/api/invoices/issue-batches/[issueBatchId]",
      method: "GET",
      targetCount: 1,
    },
    async () => {
      const { getAuthUserFromRequest } = await import(
        "@/quickhack_server/auth/auth-service"
      );
      const user = await getAuthUserFromRequest(request);
      if (!user) {
        return NextResponse.json(
          { ok: false, message: "Login is required." },
          { status: 401 }
        );
      }
      if (!canAccessRole(user.role, "STAFF")) {
        return NextResponse.json(
          { ok: false, message: "You do not have permission to view invoices." },
          { status: 403 }
        );
      }
      setOperationTraceUserId(user.userId);

      const service = await import(
        "@/quickhack_server/shipment/carrier-integration/carrier-invoice-issue-service"
      );
      try {
        const result = await traceOperationSpan("SERVICE_READ", () =>
          service.getCarrierInvoiceIssueBatch({ issueBatchId })
        );
        setOperationTraceTargetCount(result.requestedPackageGroupCount);
        return NextResponse.json({ ok: true, issueBatch: result });
      } catch (error) {
        if (error instanceof service.CarrierInvoiceIssueError) {
          return apiFailureResponse({
            status: error.code.endsWith("NOT_FOUND") ? 404 : error.code === "INVALID_ID" ? 400 : 409,
            code: error.code,
            message: error.message,
            cause: error,
          });
        }
        return apiErrorResponse(error);
      }
    }
  );
}
