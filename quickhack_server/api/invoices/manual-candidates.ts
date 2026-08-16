import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { markOperationTraceFailed } from "@/quickhack_server/observability/operation-trace";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
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

async function authorize(request: NextRequest) {
  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);
  if (!user) {
    return {
      user: null,
      response: NextResponse.json(
        { ok: false, message: "로그인이 필요합니다." },
        { status: 401 }
      ),
    };
  }
  if (!canAccessRole(user.role, "MANAGER")) {
    return {
      user: null,
      response: NextResponse.json(
        { ok: false, message: "수동 송장 발급 권한이 없습니다." },
        { status: 403 }
      ),
    };
  }
  return { user, response: null };
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/invoices/manual-candidates${request.nextUrl.search}`,
      { method: "GET", contentType: null }
    );
  }
  const auth = await authorize(request);
  if (!auth.user) return auth.response;

  try {
    const { listCarrierInvoiceManualCandidates } = await import(
      "@/quickhack_server/shipment/carrier-integration/invoice-operation-query-service"
    );
    const result = await listCarrierInvoiceManualCandidates({
      search: request.nextUrl.searchParams.get("search"),
      limit: request.nextUrl.searchParams.get("limit"),
      cursor: request.nextUrl.searchParams.get("cursor"),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/invoices/manual-candidates", {
      method: "POST",
      body: bodyText,
    });
  }
  const auth = await authorize(request);
  if (!auth.user) return auth.response;

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SyntaxError("JSON object required");
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_JSON_BODY",
      message: "요청 본문이 올바른 JSON 객체 형식이 아닙니다.",
      cause: error,
    });
  }

  const service = await import(
    "@/quickhack_server/shipment/carrier-integration/carrier-invoice-issue-service"
  );
  try {
    if (body.action !== "retryAllocation") {
      return apiFailureResponse({
        status: 400,
        code: "INVALID_MANUAL_INVOICE_ACTION",
        message: "지원하지 않는 수동 송장 발급 작업입니다.",
      });
    }

    const issueBatch = await service.retryFailedCarrierInvoiceIssueBatch({
      issueBatchId: body.issueBatchId,
      userId: auth.user.userId,
    });
    let channelSubmission: InvoiceChannelSubmission | null = null;
    let shouldWakeWorkers = false;
    if (issueBatch.status === "ALLOCATED") {
      try {
        const { submitCoupangInvoicesForIssueBatch } = await import(
          "@/quickhack_server/shipment/carrier-integration/coupang-invoice-upload-service"
        );
        channelSubmission = await submitCoupangInvoicesForIssueBatch({
          issueBatchId: issueBatch.issueBatchId,
          userId: auth.user.userId,
        });
        shouldWakeWorkers = true;
      } catch (error) {
        markOperationTraceFailed(error, "COUPANG_INVOICE_SUBMIT_FAILED");
        channelSubmission = {
          status: "FAILED",
          errorCode: "COUPANG_INVOICE_SUBMIT_FAILED",
          errorMessage: "쿠팡 송장 등록을 완료하지 못했습니다.",
        };
      }
    }
    const outcome = buildInvoiceIssueMutationResponse({
      issueBatch,
      channelSubmission,
    });
    const receipt = createMutationReceipt(
      { issueBatch, channelSubmission },
      {
        operationId: stableMutationOperationId("manual-invoice-retry", [
          issueBatch.issueBatchId,
          issueBatch.status,
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
        issueBatch,
        channelSubmission,
        message: outcome.message,
        receipt: settledReceipt,
      },
      { status: outcome.status }
    );
  } catch (error) {
    if (error instanceof service.CarrierInvoiceIssueError) {
      return apiFailureResponse({
        status: error.code.endsWith("NOT_FOUND")
          ? 404
          : error.code === "INVALID_ID"
            ? 400
            : 409,
        code: error.code,
        message: error.message,
        cause: error,
      });
    }
    return apiErrorResponse(error);
  }
}
