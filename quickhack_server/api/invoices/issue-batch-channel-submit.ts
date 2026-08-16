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

type RouteContext = {
  params: Promise<{ issueBatchId?: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const issueBatchId = String(params.issueBatchId ?? "").trim();
  const path = `/api/invoices/issue-batches/${encodeURIComponent(issueBatchId)}/channel-submit`;

  if (isClientRuntime()) {
    return proxyToServer(request, path, { method: "POST", body: "{}" });
  }

  return runOperationTrace(
    {
      operationName: "carrier.invoice-channel.submit",
      source: "HTTP",
      route: "/api/invoices/issue-batches/[issueBatchId]/channel-submit",
      method: "POST",
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
          { ok: false, message: "You do not have permission to upload invoices." },
          { status: 403 }
        );
      }
      setOperationTraceUserId(user.userId);

      const service = await import(
        "@/quickhack_server/shipment/carrier-integration/coupang-invoice-upload-service"
      );
      try {
        const result = await traceOperationSpan("SERVICE_WRITE", () =>
          service.submitCoupangInvoicesForIssueBatch({
            issueBatchId,
            userId: user.userId,
          })
        );
        if (result.completedCount > 0) {
          const { wakeWorkerManager } = await import(
            "@/quickhack_server/workers/manager"
          );
          wakeWorkerManager();
        }
        setOperationTraceTargetCount(result.targetCount);
        return NextResponse.json(
          { ok: result.status === "COMPLETED", channelSubmission: result },
          { status: result.status === "COMPLETED" ? 200 : 202 }
        );
      } catch (error) {
        if (error instanceof service.CoupangInvoiceSubmissionError) {
          return apiFailureResponse({
            status: error.code === "INVALID_ID" ? 400 : error.code.endsWith("NOT_FOUND") ? 404 : 409,
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
