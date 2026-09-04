import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { publicBadRequest } from "@/quickhack_server/core/public-error";
import {
  runOperationTrace,
  setOperationTraceField,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";

export const runtime = "nodejs";

async function authorizeStaff(request: NextRequest) {
  const { getAuthUserFromRequest } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return {
      response: apiFailureResponse({
        status: 401,
        code: "AUTHENTICATION_REQUIRED",

      }),
      user: null,
    };
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return {
      response: apiFailureResponse({
        status: 403,
        code: "PERMISSION_DENIED",

      }),
      user: null,
    };
  }

  setOperationTraceUserId(user.userId);
  return { response: null, user };
}

function positiveVerificationStateId(value: unknown) {
  const text = String(value ?? "").trim();

  if (!/^\d+$/.test(text)) {
    throw publicBadRequest(
      "INVALID_INVENTORY_VERIFICATION_STATE_ID",
      "INVALID_INVENTORY_VERIFICATION_STATE_ID"
    );
  }

  const id = Number(text);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw publicBadRequest(
      "INVALID_INVENTORY_VERIFICATION_STATE_ID",
      "INVALID_INVENTORY_VERIFICATION_STATE_ID"
    );
  }

  return id;
}

function positiveSafeInteger(value: unknown, fieldLabel: string) {
  const text = String(value ?? "").trim();

  if (!/^\d+$/.test(text)) {
    throw publicBadRequest(
      "INVALID_INVENTORY_REPAIR_SNAPSHOT",
      "INVALID_INVENTORY_REPAIR_SNAPSHOT"
    );
  }

  const parsed = Number(text);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw publicBadRequest(
      "INVALID_INVENTORY_REPAIR_SNAPSHOT",
      "INVALID_INVENTORY_REPAIR_SNAPSHOT"
    );
  }

  return parsed;
}

function nonNegativeSafeInteger(value: unknown, fieldLabel: string) {
  const text = String(value ?? "").trim();

  if (!/^\d+$/.test(text)) {
    throw publicBadRequest(
      "INVALID_INVENTORY_REPAIR_SNAPSHOT",
      "INVALID_INVENTORY_REPAIR_SNAPSHOT"
    );
  }

  const parsed = Number(text);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw publicBadRequest(
      "INVALID_INVENTORY_REPAIR_SNAPSHOT",
      "INVALID_INVENTORY_REPAIR_SNAPSHOT"
    );
  }

  return parsed;
}

function requiredSnapshotText(value: unknown, fieldLabel: string) {
  const text = String(value ?? "").trim();

  if (!text || text.length > 100) {
    throw publicBadRequest(
      "INVALID_INVENTORY_REPAIR_SNAPSHOT",
      "INVALID_INVENTORY_REPAIR_SNAPSHOT"
    );
  }

  return text;
}

async function readJsonObject(request: NextRequest) {
  let value: unknown;

  try {
    value = await request.json();
  } catch {
    throw publicBadRequest(
      "INVALID_SALES_CHANNEL_SYNC_CHECK_ACTION",
      "INVALID_SALES_CHANNEL_SYNC_CHECK_ACTION"
    );
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw publicBadRequest(
      "INVALID_SALES_CHANNEL_SYNC_CHECK_ACTION",
      "INVALID_SALES_CHANNEL_SYNC_CHECK_ACTION"
    );
  }

  return value as Record<string, unknown>;
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/admin/sales-channel-sync-checks${request.nextUrl.search}`,
      { method: "GET", contentType: null }
    );
  }

  return runOperationTrace(
    {
      operationName: "sales-channel.sync-check.read",
      source: "HTTP",
      route: "/api/admin/sales-channel-sync-checks",
      method: "GET",
    },
    async () => {
      const authorization = await authorizeStaff(request);
      if (authorization.response) return authorization.response;

      try {
        const {
          listSalesChannelSyncChecks,
          parseSalesChannelSyncCheckQuery,
        } = await import(
          "@/quickhack_server/sales-channel/sales-channel-sync-check-service"
        );
        const query = parseSalesChannelSyncCheckQuery({
          kind: request.nextUrl.searchParams.get("kind"),
          status: request.nextUrl.searchParams.get("status"),
          search: request.nextUrl.searchParams.get("search"),
          limit: request.nextUrl.searchParams.get("limit"),
          cursor: request.nextUrl.searchParams.get("cursor"),
        });
        setOperationTraceField("sync_check.kind", query.kind);
        setOperationTraceField("sync_check.status", query.status);
        const result = await traceOperationSpan("SERVICE_READ", () =>
          listSalesChannelSyncChecks(query)
        );
        setOperationTraceTargetCount(result.items.length);
        return NextResponse.json(result);
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}

export async function PATCH(request: NextRequest) {
  if (isClientRuntime()) {
    const bodyText = await request.text();

    return proxyToServer(request, "/api/admin/sales-channel-sync-checks", {
      method: "PATCH",
      body: bodyText,
    });
  }

  let body: Record<string, unknown>;
  const authorization = await authorizeStaff(request);
  if (authorization.response) return authorization.response;

  try {
    body = await readJsonObject(request);
  } catch (error) {
    return apiErrorResponse(error);
  }

  const action = String(body.action ?? "").trim();

  return runOperationTrace(
    {
      operationName:
        action === "repairInventory"
          ? "sales-channel.sync-check.repair-inventory"
          : "sales-channel.sync-check.recheck-inventory",
      source: "HTTP",
      route: "/api/admin/sales-channel-sync-checks",
      method: "PATCH",
      targetCount: 1,
    },
    async () => {
      setOperationTraceUserId(authorization.user!.userId);

      try {
        setOperationTraceField(
          "sync_check.action",
          action === "recheckInventory" || action === "repairInventory"
            ? action
            : "unknown"
        );

        if (action !== "recheckInventory" && action !== "repairInventory") {
          throw publicBadRequest(
            "INVALID_SALES_CHANNEL_SYNC_CHECK_ACTION",
            "INVALID_SALES_CHANNEL_SYNC_CHECK_ACTION"
          );
        }

        const verificationStateId = positiveVerificationStateId(
          body.verificationStateId
        );
        setOperationTraceField(
          "inventory.verification_state_id",
          verificationStateId
        );
        if (action === "repairInventory") {
          const observedDesiredVersion = positiveSafeInteger(
            body.observedDesiredVersion,
            "화면의 projection 버전"
          );
          const observedMismatchSince = requiredSnapshotText(
            body.observedMismatchSince,
            "불일치 시작 시각"
          );
          const observedExpectedChannelQuantity = nonNegativeSafeInteger(
            body.observedExpectedChannelQuantity,
            "화면의 기대수량"
          );
          const observedChannelQuantity = nonNegativeSafeInteger(
            body.observedChannelQuantity,
            "화면의 쿠팡 재고수량"
          );
          const { repairCoupangInventoryQuantity } = await import(
            "@/quickhack_server/sales-channel/coupang/inventory-quantity-repair-service"
          );
          const result = await traceOperationSpan("SERVICE_WRITE", () =>
            repairCoupangInventoryQuantity({
              verificationStateId,
              observedDesiredVersion,
              observedMismatchSince,
              observedExpectedChannelQuantity,
              observedChannelQuantity,
              requestedByUserId: authorization.user!.userId,
            })
          );

          return NextResponse.json({ ok: true, ...result });
        }

        const { recheckSalesChannelInventoryVerification } = await import(
          "@/quickhack_server/sales-channel/sales-channel-sync-check-service"
        );
        const result = await traceOperationSpan("SERVICE_WRITE", () =>
          recheckSalesChannelInventoryVerification({ verificationStateId })
        );

        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}
