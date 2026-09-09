import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  markOperationTraceFailed,
  runOperationTrace,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";
import {
  buildInvoiceIssueMutationResponse,
  type InvoiceChannelSubmission,
} from "@/quickhack_server/shipment/carrier-integration/invoice-submission-response";
import { MUTATION_RECEIPT_OUTCOMES } from "@/quickhack_shared/core/mutation-receipt";
import {
  createMutationReceipt,
  settleOptionalWorkerWake,
  stableMutationOperationId,
} from "@/quickhack_server/api/mutation-receipt";

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

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/invoices/issue-batches${request.nextUrl.search}`,
      { method: "GET", contentType: null }
    );
  }

  return runOperationTrace(
    {
      operationName: "carrier.invoice-issue.list-by-shipment-batch",
      source: "HTTP",
      route: "/api/invoices/issue-batches",
      method: "GET",
    },
    async () => {
      const { getAuthUserFromRequest } = await import(
        "@/quickhack_server/auth/auth-service"
      );
      const user = await getAuthUserFromRequest(request);
      if (!user) {
        return NextResponse.json(
          { ok: false, code: "AUTH_REQUIRED" },
          { status: 401 }
        );
      }
      if (!canAccessRole(user.role, "STAFF")) {
        return NextResponse.json(
          { ok: false, code: "FORBIDDEN" },
          { status: 403 }
        );
      }
      setOperationTraceUserId(user.userId);

      const service = await import(
        "@/quickhack_server/shipment/carrier-integration/carrier-invoice-issue-service"
      );
      try {
        const batches = await traceOperationSpan("SERVICE_READ", () =>
          service.listCarrierInvoiceIssueBatchesForShipmentPrintBatch({
            shipmentListPrintBatchId: request.nextUrl.searchParams.get(
              "shipmentListPrintBatchId"
            ),
          })
        );
        setOperationTraceTargetCount(batches.length);
        return NextResponse.json({ ok: true, issueBatches: batches });
      } catch (error) {
        if (error instanceof service.CarrierInvoiceIssueError) {
          return apiFailureResponse({
            status: error.code.endsWith("NOT_FOUND") ? 404 : error.code === "INVALID_ID" ? 400 : 409,
            code: error.code,
            cause: error,
          });
        }
        return apiErrorResponse(error);
      }
    }
  );
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/invoices/issue-batches", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "carrier.invoice-issue.create",
      source: "HTTP",
      route: "/api/invoices/issue-batches",
      method: "POST",
    },
    async () => {
      const { getAuthUserFromRequest } = await import(
        "@/quickhack_server/auth/auth-service"
      );
      const user = await getAuthUserFromRequest(request);
      if (!user) {
        return NextResponse.json(
          { ok: false, code: "AUTH_REQUIRED" },
          { status: 401 }
        );
      }
      if (!canAccessRole(user.role, "STAFF")) {
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

      const service = await import(
        "@/quickhack_server/shipment/carrier-integration/carrier-invoice-issue-service"
      );
      const returnConflict = await import(
        "@/quickhack_server/returns/shipment-return-conflict-service"
      );

      try {
        const result = await traceOperationSpan("SERVICE_WRITE", () =>
          service.issueCarrierInvoicesForShipmentBatch({
            shipmentListPrintBatchId: body.shipmentListPrintBatchId,
            userId: user.userId,
          })
        );
        setOperationTraceTargetCount(result.requestedPackageGroupCount);

        const allocated = result.status === "ALLOCATED";
        let channelSubmission: InvoiceChannelSubmission | null = null;
        if (allocated) {
          try {
            const channelService = await import(
              "@/quickhack_server/shipment/carrier-integration/coupang-invoice-upload-service"
            );
            channelSubmission = await traceOperationSpan(
              "COUPANG_INVOICE_SUBMIT",
              () =>
                channelService.submitCoupangInvoicesForIssueBatch({
                  issueBatchId: result.issueBatchId,
                  userId: user.userId,
                })
            );
          } catch (error) {
            markOperationTraceFailed(error, "COUPANG_INVOICE_SUBMIT_FAILED");
            channelSubmission = {
              status: "FAILED",
              errorCode: "COUPANG_INVOICE_SUBMIT_FAILED",
            };
          }
        }
        const outcome = buildInvoiceIssueMutationResponse({
          issueBatch: result,
          channelSubmission,
        });
        const shouldWakeWorkers =
          typeof channelSubmission === "object" &&
          channelSubmission !== null &&
          "completedCount" in channelSubmission &&
          Number(channelSubmission.completedCount) > 0;
        const receipt = createMutationReceipt(
          { issueBatch: result, channelSubmission },
          {
            operationId: stableMutationOperationId("invoice-issue-batch", [
              result.issueBatchId,
              result.status,
              ...outcome.requestIds,
            ]),
            outcome:
              outcome.status === 202
                ? MUTATION_RECEIPT_OUTCOMES.accepted
                : MUTATION_RECEIPT_OUTCOMES.committed,
          }
        );
        const settledReceipt = shouldWakeWorkers
          ? await settleOptionalWorkerWake(receipt, async () => {
              const { wakeWorkerManager } = await import(
                "@/quickhack_server/workers/manager"
              );
              wakeWorkerManager();
            })
          : receipt;
        return NextResponse.json(
          {
            ok: outcome.ok,
            reviewRequired: outcome.reviewRequired,
            partial: outcome.partial,
            requestIds: outcome.requestIds,
            issueBatch: result,
            channelSubmission,
            resultCode: outcome.resultCode,
            receipt: settledReceipt,
          },
          { status: outcome.status }
        );
      } catch (error) {
        if (returnConflict.isShipmentReturnConflictError(error)) {
          return apiFailureResponse({
            status: 409,
            code: error.code,
            extra: { conflicts: error.conflicts },
            cause: error,
          });
        }
        if (error instanceof service.CarrierInvoiceIssueError) {
          const status = error.code.endsWith("NOT_FOUND") ? 404 :
            error.code === "INVALID_ID" ? 400 : 409;
          return apiFailureResponse({
            status,
            code: error.code,
            cause: error,
          });
        }
        return apiErrorResponse(error);
      }
    }
  );
}
