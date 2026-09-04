// QuickHack note: 실물 도착 전 입고 예정 차수와 예정 기종/수량을 관리하는 서버 API입니다.
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
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";
import {
  createMutationReceipt,
  settleOptionalMutationRefresh,
  stableMutationOperationId,
} from "@/quickhack_server/api/mutation-receipt";

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

function parseId(value: unknown) {
  const normalized = String(value ?? "").trim();

  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const id = Number.parseInt(normalized, 10);

  return id > 0 ? id : null;
}

async function requireStaff(request: NextRequest) {
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
    };
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return {
      response: apiFailureResponse({
        status: 403,
        code: "PERMISSION_DENIED",

      }),
    };
  }

  return { user };
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inbound/batches", {
      method: "GET",
      contentType: null,
    });
  }

  return runOperationTrace(
    {
      operationName: "inbound.batch.read",
      source: "HTTP",
      route: "/api/inbound/batches",
      method: "GET",
    },
    async () => {
      const authResult = await requireStaff(request);

      if ("response" in authResult) {
        return authResult.response;
      }
      setOperationTraceUserId(authResult.user.userId);

      try {
        const [{ prisma }, { listInboundBatchPlanRows }] = await Promise.all([
          import("@/quickhack_server/core/prisma"),
          import(
            "@/quickhack_server/inbound/inbound-batch-plan-query-service"
          ),
        ]);
        const batches = await traceOperationSpan("SERVICE_READ", () =>
          listInboundBatchPlanRows(prisma)
        );
        setOperationTraceTargetCount(batches.length);

        return NextResponse.json({ ok: true, batches });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inbound/batches", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inbound.batch.create",
      source: "HTTP",
      route: "/api/inbound/batches",
      method: "POST",
      targetCount: 1,
    },
    async () => {

  const authResult = await requireStaff(request);

  if ("response" in authResult) {
    return authResult.response;
  }
  setOperationTraceUserId(authResult.user.userId);

  const body = parseJsonObject(bodyText);

  if (!body) {
    return apiFailureResponse({
      status: 400,
      code: "INVALID_REQUEST_BODY",

    });
  }

  try {
    const [
      { prisma },
      { createInboundBatch },
      { listInboundBatchPlanRows },
    ] =
      await Promise.all([
        import("@/quickhack_server/core/prisma"),
        import("@/quickhack_server/inbound/inbound-batch-service"),
        import(
          "@/quickhack_server/inbound/inbound-batch-plan-query-service"
        ),
      ]);
    const batch = await traceOperationSpan("SERVICE_WRITE", () =>
      createInboundBatch(prisma, body, authResult.user)
    );
    const receipt = createMutationReceipt(batch, {
      operationId: stableMutationOperationId("inbound-batch-create", [
        batch.id,
        batch.revision,
      ]),
      committedAt: batch.updatedAt,
    });
    const refresh = await settleOptionalMutationRefresh(receipt, () =>
      traceOperationSpan("SERVICE_READ", () => listInboundBatchPlanRows(prisma))
    );

    return NextResponse.json({
      ok: true,
      resultCode: "INBOUND_BATCH_CREATED",
      messageArguments: { batchDate: batch.batchDate, batchNo: batch.batchNo },
      batch,
      ...(refresh.completed ? { batches: refresh.value } : {}),
      receipt: refresh.receipt,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}

export async function PATCH(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inbound/batches", {
      method: "PATCH",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inbound.batch.update",
      source: "HTTP",
      route: "/api/inbound/batches",
      method: "PATCH",
      targetCount: 1,
    },
    async () => {

  const authResult = await requireStaff(request);

  if ("response" in authResult) {
    return authResult.response;
  }
  setOperationTraceUserId(authResult.user.userId);

  const body = parseJsonObject(bodyText);
  const id = body ? parseId(body.id) : null;

  if (!body || id === null) {
    return apiFailureResponse({
      status: 400,
      code: "INBOUND_BATCH_INPUT_INVALID",

    });
  }

  try {
    const [
      { prisma },
      { updateInboundBatch },
      { listInboundBatchPlanRows },
    ] =
      await Promise.all([
        import("@/quickhack_server/core/prisma"),
        import("@/quickhack_server/inbound/inbound-batch-service"),
        import(
          "@/quickhack_server/inbound/inbound-batch-plan-query-service"
        ),
      ]);
    const batch = await traceOperationSpan("SERVICE_WRITE", () =>
      updateInboundBatch(prisma, id, body, authResult.user)
    );
    const receipt = createMutationReceipt(batch, {
      operationId: stableMutationOperationId("inbound-batch-update", [
        batch.id,
        batch.revision,
      ]),
      committedAt: batch.updatedAt,
    });
    const refresh = await settleOptionalMutationRefresh(receipt, () =>
      traceOperationSpan("SERVICE_READ", () => listInboundBatchPlanRows(prisma))
    );

    return NextResponse.json({
      ok: true,
      resultCode: "INBOUND_BATCH_UPDATED",
      messageArguments: { batchDate: batch.batchDate, batchNo: batch.batchNo },
      batch,
      ...(refresh.completed ? { batches: refresh.value } : {}),
      receipt: refresh.receipt,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}

export async function DELETE(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inbound/batches", {
      method: "DELETE",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inbound.batch.delete",
      source: "HTTP",
      route: "/api/inbound/batches",
      method: "DELETE",
      targetCount: 1,
    },
    async () => {

  const authResult = await requireStaff(request);

  if ("response" in authResult) {
    return authResult.response;
  }
  setOperationTraceUserId(authResult.user.userId);

  const body = parseJsonObject(bodyText);
  const id = body ? parseId(body.id) : null;

  if (!body || id === null) {
    return apiFailureResponse({
      status: 400,
      code: "INBOUND_BATCH_INPUT_INVALID",

    });
  }

  try {
    const [
      { prisma },
      { deleteInboundBatch },
      { listInboundBatchPlanRows },
    ] =
      await Promise.all([
        import("@/quickhack_server/core/prisma"),
        import("@/quickhack_server/inbound/inbound-batch-service"),
        import(
          "@/quickhack_server/inbound/inbound-batch-plan-query-service"
        ),
      ]);
    const batch = await traceOperationSpan("SERVICE_WRITE", () =>
      deleteInboundBatch(prisma, id, body, authResult.user)
    );
    const receipt = createMutationReceipt(batch, {
      operationId: stableMutationOperationId("inbound-batch-delete", [
        batch.id,
        batch.revision,
      ]),
      committedAt: batch.updatedAt,
    });
    const refresh = await settleOptionalMutationRefresh(receipt, () =>
      traceOperationSpan("SERVICE_READ", () => listInboundBatchPlanRows(prisma))
    );

    return NextResponse.json({
      ok: true,
      resultCode: "INBOUND_BATCH_DELETED",
      messageArguments: { batchDate: batch.batchDate, batchNo: batch.batchNo },
      batch,
      ...(refresh.completed ? { batches: refresh.value } : {}),
      receipt: refresh.receipt,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}
