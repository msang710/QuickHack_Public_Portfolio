import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { prisma } from "@/quickhack_server/core/prisma";
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

type RouteContext = {
  params: Promise<{ balanceId?: string }>;
};

export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  const params = await context.params;
  const balanceId = String(params.balanceId ?? "").trim();
  const path = `/api/inventory/quantity-ledger/${encodeURIComponent(
    balanceId
  )}/movements`;

  if (isClientRuntime()) {
    return proxyToServer(request, path, {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "inventory.quantity-ledger.movements.read",
      source: "HTTP",
      route:
        "/api/inventory/quantity-ledger/[balanceId]/movements",
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
      setOperationTraceField(
        "inventory.balance_id_present",
        Boolean(balanceId)
      );
      setOperationTraceField(
        "inventory.cursor_present",
        request.nextUrl.searchParams.has("cursor")
      );
      setOperationTraceField(
        "inventory.limit_present",
        request.nextUrl.searchParams.has("limit")
      );

      const service = await import(
        "@/quickhack_server/inventory/inventory-quantity-query-service"
      );

      try {
        const data = await traceOperationSpan("SERVICE_READ", () =>
          service.getInventoryQuantityMovements(prisma, {
            balanceId,
            cursor: request.nextUrl.searchParams.get("cursor"),
            limit: request.nextUrl.searchParams.get("limit"),
          })
        );

        if (!data) {
          return apiFailureResponse({
            status: 404,
            code: "INVENTORY_QUANTITY_BALANCE_NOT_FOUND",

          });
        }

        setOperationTraceTargetCount(data.items.length);
        return NextResponse.json({ ok: true, data });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}
