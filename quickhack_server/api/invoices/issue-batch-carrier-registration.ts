import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
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

async function handle(
  request: NextRequest,
  context: RouteContext,
  reconcileOnly: boolean
) {
  const params = await context.params;
  const issueBatchId = Number(params.issueBatchId);
  const suffix = reconcileOnly
    ? "/carrier-registration/reconcile"
    : "/carrier-registration";
  const path = `/api/invoices/issue-batches/${encodeURIComponent(
    String(params.issueBatchId ?? "")
  )}${suffix}`;
  if (isClientRuntime()) {
    return proxyToServer(request, path, { method: "POST", body: "{}" });
  }

  return runOperationTrace(
    {
      operationName: reconcileOnly
        ? "carrier.logen-registration.reconcile"
        : "carrier.logen-registration.queue",
      source: "HTTP",
      route: `/api/invoices/issue-batches/[issueBatchId]${suffix}`,
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
      if (!Number.isSafeInteger(issueBatchId) || issueBatchId <= 0) {
        return NextResponse.json(
          { ok: false, code: "INVALID_ISSUE_BATCH_ID" },
          { status: 400 }
        );
      }
      setOperationTraceUserId(user.userId);

      try {
        const { queueLogenRegistrationForIssueBatch } = await import(
          "@/quickhack_server/shipment/carrier-integration/logen/shipment-registration-service"
        );
        const count = await traceOperationSpan("SERVICE_WRITE", () =>
          queueLogenRegistrationForIssueBatch({
            issueBatchId,
            reconcileOnly,
          })
        );
        setOperationTraceTargetCount(count);
        const receipt = createMutationReceipt(
          { issueBatchId, queuedCount: count, reconcileOnly },
          {
            operationId: stableMutationOperationId(
              "carrier-registration-queue",
              [issueBatchId, reconcileOnly, count]
            ),
            outcome: MUTATION_RECEIPT_OUTCOMES.accepted,
          }
        );
        const settledReceipt = await settleOptionalWorkerWake(
          receipt,
          async () => {
            const { wakeWorkerManager } = await import(
              "@/quickhack_server/workers/manager"
            );
            wakeWorkerManager();
          }
        );
        return NextResponse.json(
          { ok: true, queuedCount: count, receipt: settledReceipt },
          { status: 202 }
        );
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, false);
}

export function POST_RECONCILE(request: NextRequest, context: RouteContext) {
  return handle(request, context, true);
}
