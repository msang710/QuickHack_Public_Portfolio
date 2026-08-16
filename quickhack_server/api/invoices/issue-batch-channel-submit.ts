import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { MUTATION_RECEIPT_OUTCOMES } from "@/quickhack_shared/core/mutation-receipt";
import {
  createMutationReceipt,
  settleOptionalWorkerWake,
  stableMutationOperationId,
} from "@/quickhack_server/api/mutation-receipt";
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
        setOperationTraceTargetCount(result.targetCount);
        const receipt = createMutationReceipt(result, {
          operationId: stableMutationOperationId(
            "invoice-channel-submit",
            [
              issueBatchId,
              result.status,
              ...result.requests.map((item) => item.requestId ?? 0),
            ]
          ),
          outcome:
            result.status === "COMPLETED"
              ? MUTATION_RECEIPT_OUTCOMES.committed
              : MUTATION_RECEIPT_OUTCOMES.accepted,
        });
        const settledReceipt =
          result.completedCount > 0
            ? await settleOptionalWorkerWake(receipt, async () => {
                const { wakeWorkerManager } = await import(
                  "@/quickhack_server/workers/manager"
                );
                wakeWorkerManager();
              })
            : receipt;
        return NextResponse.json(
          {
            ok: result.status === "COMPLETED",
            channelSubmission: result,
            receipt: settledReceipt,
          },
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
