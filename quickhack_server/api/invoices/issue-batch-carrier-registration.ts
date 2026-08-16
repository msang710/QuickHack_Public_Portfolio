import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
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
          { ok: false, message: "Login is required." },
          { status: 401 }
        );
      }
      if (!canAccessRole(user.role, "STAFF")) {
        return NextResponse.json(
          { ok: false, message: "You do not have permission to register carrier shipments." },
          { status: 403 }
        );
      }
      if (!Number.isSafeInteger(issueBatchId) || issueBatchId <= 0) {
        return NextResponse.json(
          { ok: false, message: "A valid issue batch ID is required." },
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
        const { wakeWorkerManager } = await import(
          "@/quickhack_server/workers/manager"
        );
        wakeWorkerManager();
        return NextResponse.json({ ok: true, queuedCount: count }, { status: 202 });
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
