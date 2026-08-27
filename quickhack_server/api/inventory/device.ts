// QuickHack note: PG 번호 기준 기존 재고 수정과 수동 재고 추가/삭제를 처리하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import {
  SENSITIVE_ACTIONS,
  type SensitiveAction,
} from "@/quickhack_shared/auth/sensitive-auth";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import {
  runOperationTrace,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";
import { normalizePgNo } from "@/quickhack_shared/inventory/pg-no";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ pgNo?: string }>;
};

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

async function getPgNo(context: RouteContext) {
  const params = await context.params;
  return normalizePgNo(params.pgNo);
}

async function requireSensitiveManager(
  request: NextRequest,
  permissionLabel: string,
  sensitiveAction: SensitiveAction
) {
  const {
    getAuthSessionFromRequest,
    isSensitiveSessionVerified,
    toAuthUser,
  } = await import("@/quickhack_server/auth/auth-service");
  const session = await getAuthSessionFromRequest(request);

  if (!session) {
    return {
      response: apiFailureResponse({
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
        message: "로그인이 필요합니다.",
      }),
    };
  }

  const user = toAuthUser(session.users);

  if (!canAccessRole(user.role, "MANAGER")) {
    return {
      response: apiFailureResponse({
        status: 403,
        code: "PERMISSION_DENIED",
        message: `${permissionLabel} 권한이 없습니다.`,
      }),
    };
  }

  if (!isSensitiveSessionVerified(session, sensitiveAction)) {
    return {
      response: apiFailureResponse({
        status: 403,
        code: "SENSITIVE_AUTH_REQUIRED",
        message: `${permissionLabel} 작업은 2차 인증이 필요합니다.`,
        extra: {
          sensitiveAuthRequired: true,
          sensitiveAction,
        },
      }),
    };
  }

  return { user };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const pgNo = await getPgNo(context);

  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/inventory/devices/${encodeURIComponent(pgNo)}`,
      { method: "GET", contentType: null }
    );
  }

  return runOperationTrace(
    {
      operationName: "inventory.device-detail.read",
      source: "HTTP",
      route: "/api/inventory/devices/[pgNo]",
      method: "GET",
      targetCount: 1,
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
          message: "로그인이 필요합니다.",
        });
      }
      if (!canAccessRole(user.role, "VIEWER")) {
        return apiFailureResponse({
          status: 403,
          code: "PERMISSION_DENIED",
          message: "기기 상세 조회 권한이 없습니다.",
        });
      }
      if (!pgNo) {
        return apiFailureResponse({
          status: 400,
          code: "PG_NO_REQUIRED",
          message: "PG 번호가 필요합니다.",
        });
      }
      setOperationTraceUserId(user.userId);

      try {
        const { getDeviceDetailByPgNo } = await import(
          "@/quickhack_server/inventory/devices-service"
        );
        const data = await traceOperationSpan("SERVICE_READ", () =>
          getDeviceDetailByPgNo(pgNo)
        );
        if (!data) {
          return apiFailureResponse({
            status: 404,
            code: "DEVICE_NOT_FOUND",
            message: "기기를 찾을 수 없습니다.",
          });
        }
        return NextResponse.json({ ok: true, data });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inventory/devices", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inventory.device.create",
      source: "HTTP",
      route: "/api/inventory/devices",
      method: "POST",
      targetCount: 1,
    },
    async () => {

  const authResult = await requireSensitiveManager(
    request,
    "재고 추가",
    SENSITIVE_ACTIONS.inventoryManage
  );

  if ("response" in authResult) {
    return authResult.response;
  }
  setOperationTraceUserId(authResult.user.userId);

  const body = parseJsonObject(bodyText);

  if (!body) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_REQUEST_BODY",
      message: "요청 본문이 올바르지 않습니다.",
    });
  }

  try {
    const [{ prisma }, { createManualInventoryRecord }] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/inventory/inventory-management-service"),
    ]);

    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      createManualInventoryRecord(prisma, body, authResult.user)
    );

    return NextResponse.json({
      ok: true,
      message: "재고를 추가했습니다.",
      result,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const pgNo = await getPgNo(context);
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, `/api/inventory/devices/${encodeURIComponent(pgNo)}`, {
      method: "PATCH",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inventory.device.update",
      source: "HTTP",
      route: "/api/inventory/devices/[pgNo]",
      method: "PATCH",
      targetCount: 1,
    },
    async () => {

  const authResult = await requireSensitiveManager(
    request,
    "기존 재고 수정",
    SENSITIVE_ACTIONS.inventoryEdit
  );

  if ("response" in authResult) {
    return authResult.response;
  }
  setOperationTraceUserId(authResult.user.userId);

  const body = parseJsonObject(bodyText);

  if (!body) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_REQUEST_BODY",
      message: "요청 본문이 올바르지 않습니다.",
    });
  }

  try {
    const [{ prisma }, { updateExistingInventoryRecord }] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/inventory/inventory-correction-command-service"),
    ]);

    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      updateExistingInventoryRecord(prisma, pgNo, body, authResult.user)
    );

    return NextResponse.json({
      ok: true,
      message: "기존 재고 수정 내역을 저장했습니다.",
      result,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const pgNo = await getPgNo(context);
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, `/api/inventory/devices/${encodeURIComponent(pgNo)}`, {
      method: "DELETE",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inventory.device.delete",
      source: "HTTP",
      route: "/api/inventory/devices/[pgNo]",
      method: "DELETE",
      targetCount: 1,
    },
    async () => {

  const authResult = await requireSensitiveManager(
    request,
    "재고 삭제",
    SENSITIVE_ACTIONS.inventoryManage
  );

  if ("response" in authResult) {
    return authResult.response;
  }
  setOperationTraceUserId(authResult.user.userId);

  const body = parseJsonObject(bodyText);

  if (!body) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_REQUEST_BODY",
      message: "요청 본문이 올바르지 않습니다.",
    });
  }

  try {
    const [{ prisma }, { deleteManualInventoryRecord }] = await Promise.all([
      import("@/quickhack_server/core/prisma"),
      import("@/quickhack_server/inventory/inventory-management-service"),
    ]);

    const result = await traceOperationSpan("SERVICE_WRITE", () =>
      deleteManualInventoryRecord(prisma, pgNo, body, authResult.user)
    );

    return NextResponse.json({
      ok: true,
      message: "재고를 삭제했습니다.",
      result,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}
