// QuickHack note: 매칭 완료 출고 목록 출력 시각을 기록하고 오늘 출력 목록을 조회하는 API입니다.
import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
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

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/shipment-list-print", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.print-history.read",
      source: "HTTP",
      route: "/api/coupang/shipment-list-print",
      method: "GET",
    },
    async () => {

  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, message: "출고 목록 조회 권한이 없습니다." },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);
  const {
    listShipmentPrintBatches,
    listTodayShipmentPrintItems,
  } = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );
  const mode = request.nextUrl.searchParams.get("mode");
  setOperationTraceField(
    "shipment.print_mode",
    mode === "batches" ? "batches" : "today"
  );
  const result = await traceOperationSpan("SERVICE_READ", async () =>
    mode === "batches"
      ? await listShipmentPrintBatches({
          tabKey: request.nextUrl.searchParams.get("tabKey"),
          limit: request.nextUrl.searchParams.get("limit"),
          focusBatchId: request.nextUrl.searchParams.get("focusBatchId"),
        })
      : await listTodayShipmentPrintItems()
  );
  const resultWithCollections = result as {
    items?: unknown[];
    batches?: unknown[];
  };
  setOperationTraceTargetCount(
    resultWithCollections.items?.length ?? resultWithCollections.batches?.length ?? 0
  );

  return NextResponse.json({
    ok: true,
    ...result,
  });
    }
  );
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/shipment-list-print", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.print-batch.create",
      source: "HTTP",
      route: "/api/coupang/shipment-list-print",
      method: "POST",
    },
    async () => {

  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, message: "출고 목록 출력 권한이 없습니다." },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, message: "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }
  setOperationTraceTargetCount(
    Array.isArray(body.allocationIds) ? body.allocationIds.length : 0
  );

  const shipmentService = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );

  try {
    const { recordShipmentListPrint } = shipmentService;
    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      recordShipmentListPrint({
        allocationIds: body.allocationIds,
        tabKey: body.tabKey,
        userId: user.userId,
      })
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (shipmentService.isShipmentReturnConflictError(error)) {
      return apiFailureResponse({
        status: 409,
        code: error.code,
        message: error.message,
        extra: { conflicts: error.conflicts },
        cause: error,
      });
    }

    return apiErrorResponse(error);
  }
    }
  );
}

export async function PATCH(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/coupang/shipment-list-print", {
      method: "PATCH",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "shipment.print-batch.update",
      source: "HTTP",
      route: "/api/coupang/shipment-list-print",
      method: "PATCH",
      targetCount: 1,
    },
    async () => {

  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, message: "출고 목록 출력 권한이 없습니다." },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, message: "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  const shipmentService = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );

  try {
    const {
      cancelShipmentListPrintBatch,
      confirmShipmentListPrintBatch,
      markShipmentListPrintDialogClosed,
    } = shipmentService;
    const action = String(body.action ?? "").trim();
    setOperationTraceField("shipment.action", action);
    const result = await traceOperationSpan("SERVICE_WRITE", async () =>
      action === "dialogClosed"
        ? markShipmentListPrintDialogClosed({ batchId: body.batchId })
        : action === "confirm"
          ? confirmShipmentListPrintBatch({
              batchId: body.batchId,
              userId: user.userId,
            })
          : action === "cancel"
            ? cancelShipmentListPrintBatch({
                batchId: body.batchId,
                userId: user.userId,
              })
            : null
    );

    if (!result) {
      return NextResponse.json(
        { ok: false, message: "지원하지 않는 출력 차수 작업입니다." },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true, batch: result });
  } catch (error) {
    if (shipmentService.isShipmentReturnConflictError(error)) {
      return apiFailureResponse({
        status: 409,
        code: error.code,
        message: error.message,
        extra: { conflicts: error.conflicts },
        cause: error,
      });
    }

    return apiErrorResponse(error);
  }
    }
  );
}
