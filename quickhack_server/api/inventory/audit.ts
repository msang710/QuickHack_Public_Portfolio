// QuickHack note: 재고 실사 화면에서 판매가능 재고의 위치만 일괄 저장하는 API입니다.
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
  setOperationTraceField,
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

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inventory/audit", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inventory.audit.save",
      source: "HTTP",
      route: "/api/inventory/audit",
      method: "POST",
    },
    async () => {

  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
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

  const body = parseJsonObject(bodyText);

  if (!body) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_REQUEST_BODY",

    });
  }

  try {
    const [{ prisma }, { saveInventoryAuditLocations }] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/inventory/inventory-audit-service"),
    ]);

    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      saveInventoryAuditLocations(prisma, body, user)
    );
    setOperationTraceTargetCount(result.changedCount);
    setOperationTraceField("audit.packed_completed_count", result.packedCompletedCount);
    setOperationTraceField(
      "audit.supply_event_count",
      result.packingSupplyConsumption.eventCount
    );
    return NextResponse.json({
      ok: true,
      resultCode: "INVENTORY_AUDIT_SAVED",
      messageArguments: {
        auditBaseDate: result.auditBaseDate,
        changedCount: result.changedCount,
        packingSupplyConsumptionCount:
          result.packingSupplyConsumption.eventCount,
      },
      changedCount: result.changedCount,
      auditBaseDate: result.auditBaseDate,
      auditPeriodFrom: result.auditPeriodFrom,
      auditPeriodTo: result.auditPeriodTo,
      packedCompletedCount: result.packedCompletedCount,
      packingSupplyConsumption: result.packingSupplyConsumption,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}
