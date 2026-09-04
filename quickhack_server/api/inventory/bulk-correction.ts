// QuickHack note: 기존 재고 수정 메뉴에서 선택한 여러 PG에 같은 수정 컬럼을 일괄 반영하는 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { SENSITIVE_ACTIONS } from "@/quickhack_shared/auth/sensitive-auth";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
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

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function bulkItems(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : null
    )
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

export async function PATCH(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inventory/devices/bulk-correction", {
      method: "PATCH",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inventory.bulk-correction",
      source: "HTTP",
      route: "/api/inventory/devices/bulk-correction",
      method: "PATCH",
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

  if (!canAccessRole(user.role, "MANAGER")) {
    return apiFailureResponse({
      status: 403,
      code: "PERMISSION_DENIED",

    });
  }
  setOperationTraceUserId(user.userId);

  const { getAuthSessionFromRequest, isSensitiveSessionVerified } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const session = await getAuthSessionFromRequest(request);

  if (!session || !isSensitiveSessionVerified(session, SENSITIVE_ACTIONS.inventoryEdit)) {
    return apiFailureResponse({
      status: 403,
      code: "SENSITIVE_AUTH_REQUIRED",

      extra: {
        sensitiveAuthRequired: true,
        sensitiveAction: SENSITIVE_ACTIONS.inventoryEdit,
      },
    });
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_REQUEST_BODY",

    });
  }

  const editReason = text(body.editReason);
  const items = bulkItems(body.items);
  setOperationTraceTargetCount(items.length);

  if (!editReason) {
    return apiFailureResponse({
      status: 400,
      code: "INVENTORY_CORRECTION_INPUT_INVALID",

    });
  }

  if (items.length === 0) {
    return apiFailureResponse({
      status: 400,
      code: "INVENTORY_CORRECTION_INPUT_INVALID",

    });
  }

  try {
    const [{ prisma }, { updateExistingInventoryRecordsAtomically }] =
      await Promise.all([
        import("@/quickhack_server/core/prisma"),
        import("@/quickhack_server/inventory/inventory-correction-command-service"),
      ]);

    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      updateExistingInventoryRecordsAtomically(
        prisma,
        items.map((item) => ({
          pgNo: text(item.pgNo),
          patches: item.patches,
        })),
        editReason,
        user
      )
    );

    return NextResponse.json({
      ok: true,
      resultCode: "INVENTORY_BULK_CORRECTION_SAVED",
      messageArguments: { updatedCount: result.updatedCount },
      updatedCount: result.updatedCount,
      pgNos: result.pgNos,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}
