import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { todayKstDate } from "@/quickhack_shared/core/time";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
  setOperationTraceField,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/inventory/inbound-reconciliation${request.nextUrl.search}`
    );
  }

  return runOperationTrace(
    {
      operationName: "inventory.inbound-reconciliation.read",
      source: "HTTP",
      route: "/api/inventory/inbound-reconciliation",
      method: "GET",
    },
    async () => {
      const { getAuthUserFromRequest } = await import(
        "@/quickhack_server/auth/auth-service"
      );
      const user = await getAuthUserFromRequest(request);

      if (!user) {
        return apiFailureResponse({
          status: 401,
          code: "AUTHENTICATION_REQUIRED",

        });
      }

      if (!canAccessRole(user.role, "STAFF")) {
        return apiFailureResponse({
          status: 403,
          code: "PERMISSION_DENIED",

        });
      }

      setOperationTraceUserId(user.userId);

      try {
        const {
          buildInboundReconciliationDetail,
          getInboundReconciliation,
          normalizeInboundReconciliationDetailScope,
        } = await import(
          "@/quickhack_server/inbound/inbound-reconciliation-service"
        );
        const { prisma } = await import("@/quickhack_server/core/prisma");
        const businessDate =
          request.nextUrl.searchParams.get("businessDate")?.trim() ||
          todayKstDate();
        const scope = normalizeInboundReconciliationDetailScope(
          request.nextUrl.searchParams.get("scope")
        );

        setOperationTraceField(
          "inventory.reconciliation_scope",
          scope
        );
        setOperationTraceField(
          "inventory.business_date",
          businessDate
        );

        const data = await traceOperationSpan("SERVICE_READ", async () => {
          const summary = await getInboundReconciliation(prisma, {
            businessDate,
            batchDate: businessDate,
          });

          return buildInboundReconciliationDetail(summary, scope);
        });
        setOperationTraceTargetCount(
          data.scope === "UNASSIGNED"
            ? data.devices.length
            : data.batches.length
        );

        return NextResponse.json({ ok: true, data });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}
