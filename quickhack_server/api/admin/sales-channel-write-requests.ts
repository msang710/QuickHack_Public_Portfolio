import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import { publicBadRequest } from "@/quickhack_server/core/public-error";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { SALES_CHANNEL_WRITE_MANUAL_VERIFICATION } from "@/quickhack_shared/sales-channel/write-requests";
import { presentSalesChannelWriteReviewResponse } from "@/quickhack_server/sales-channel/write/sales-channel-write-review-response";
import {
  runOperationTrace,
  setOperationTraceField,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";
import {
  createMutationReceipt,
  settleOptionalWorkerWake,
  stableMutationOperationId,
} from "@/quickhack_server/api/mutation-receipt";

export const runtime = "nodejs";

function positiveId(value: unknown, label: string) {
  const id = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw publicBadRequest(
      "INVALID_SALES_CHANNEL_WRITE_REQUEST",
      `${label}이 올바르지 않습니다.`
    );
  }

  return id;
}

function nonnegativeRevision(value: unknown) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw publicBadRequest(
      "INVALID_SALES_CHANNEL_WRITE_CONTROL_REVISION",
      "쓰기 차단 상태 revision이 올바르지 않습니다."
    );
  }
  return revision;
}

async function wakeDependentWorkers() {
  const { wakeWorkerManager } = await import(
    "@/quickhack_server/workers/manager"
  );
  wakeWorkerManager();
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/admin/sales-channel-write-requests${request.nextUrl.search}`,
      {
        method: "GET",
        contentType: null,
      }
    );
  }

  const [{ getAuthUserFromRequest }, { listSalesChannelWriteRequests }] =
    await Promise.all([
      import("@/quickhack_server/auth/auth-service"),
      import(
        "@/quickhack_server/sales-channel/write/sales-channel-write-review-service"
      ),
    ]);
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, message: "판매 채널 동기화 점검 권한이 없습니다." },
      { status: 403 }
    );
  }

  const url = new URL(request.url);
  const result = await listSalesChannelWriteRequests({
    status: url.searchParams.get("status"),
    channel: url.searchParams.get("channel"),
    requestType: url.searchParams.get("requestType"),
    search: url.searchParams.get("search"),
    limit: Number.parseInt(url.searchParams.get("limit") ?? "300", 10),
  });

  return NextResponse.json(presentSalesChannelWriteReviewResponse(result));
}

export async function PATCH(request: NextRequest) {
  if (isClientRuntime()) {
    const bodyText = await request.text();

    return proxyToServer(request, "/api/admin/sales-channel-write-requests", {
      method: "PATCH",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "sales-channel.write-review.action",
      source: "HTTP",
      route: "/api/admin/sales-channel-write-requests",
      method: "PATCH",
      targetCount: 1,
    },
    async () => {

  const [
    { getAuthUserFromRequest },
    {
      recordManualWriteDecision,
      recheckSalesChannelWriteRequest,
      retrySalesChannelLocalFinalization,
    },
    { resumeSalesChannelWriteControl },
  ] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import(
      "@/quickhack_server/sales-channel/write/sales-channel-write-review-service"
    ),
    import(
      "@/quickhack_server/sales-channel/write/sales-channel-write-service"
    ),
  ]);
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, message: "판매 채널 동기화 점검 권한이 없습니다." },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "").trim();
    setOperationTraceField(
      "write_review.action",
      ["resumeControl", "recheck", "retryLocal", "decision"].includes(action)
        ? action
        : "unknown"
    );

    if (action === "resumeControl") {
      if (!canAccessRole(user.role, "MANAGER")) {
        return NextResponse.json(
          { ok: false, message: "쓰기 일시 정지는 관리자만 해제할 수 있습니다." },
          { status: 403 }
        );
      }

      const result = await traceOperationSpan("SERVICE_WRITE", () =>
        resumeSalesChannelWriteControl({
          controlId: positiveId(body.controlId, "쓰기 제어 ID"),
          userId: user.userId,
          expectedRevision: nonnegativeRevision(body.expectedControlRevision),
        })
      );
      const authoritativeResult = {
        controlId: result.sales_channel_write_control_id,
        revision: result.revision,
        isPaused: result.is_paused === 1,
      };
      const receipt = createMutationReceipt(authoritativeResult, {
        operationId: stableMutationOperationId("sales-channel-resume", [
          result.sales_channel_write_control_id,
          result.revision,
        ]),
        committedAt: result.updated_at,
      });
      return NextResponse.json({
        ok: true,
        message: "외부 쓰기를 다시 열었습니다.",
        result: authoritativeResult,
        receipt,
      });
    }

    const requestId = positiveId(body.requestId, "쓰기 요청 ID");

    if (action === "recheck") {
      const result = await traceOperationSpan("SERVICE_WRITE", () =>
        recheckSalesChannelWriteRequest({
          requestId,
          userId: user.userId,
        })
      );
      const authoritativeResult = {
        requestId,
        confirmed: result.confirmed,
      };
      const receipt = createMutationReceipt(authoritativeResult, {
        operationId: stableMutationOperationId("sales-channel-recheck", [
          requestId,
          result.confirmed,
        ]),
      });
      const settledReceipt = result.confirmed
        ? await settleOptionalWorkerWake(receipt, wakeDependentWorkers)
        : receipt;
      return NextResponse.json({ ok: true, ...result, receipt: settledReceipt });
    }

    if (action === "retryLocal") {
      const result = await traceOperationSpan("SERVICE_WRITE", () =>
        retrySalesChannelLocalFinalization({
          requestId,
          userId: user.userId,
        })
      );
      const authoritativeResult = {
        requestId,
        requestStatus:
          result && typeof result === "object" && "request_status" in result
            ? String(result.request_status)
            : "COMPLETED",
      };
      const receipt = createMutationReceipt(authoritativeResult, {
        operationId: stableMutationOperationId("sales-channel-retry-local", [
          requestId,
          authoritativeResult.requestStatus,
        ]),
      });
      const settledReceipt = await settleOptionalWorkerWake(
        receipt,
        wakeDependentWorkers
      );
      return NextResponse.json({
        ok: true,
        message: "QuickHack 내부 확정을 완료했습니다.",
        result: authoritativeResult,
        receipt: settledReceipt,
      });
    }

    if (action === "decision") {
      const decision = String(body.decision ?? "").trim();
      const allowed = Object.values(SALES_CHANNEL_WRITE_MANUAL_VERIFICATION);

      if (!allowed.includes(decision as (typeof allowed)[number])) {
        throw publicBadRequest(
          "INVALID_SALES_CHANNEL_REVIEW_DECISION",
          "직접 확인 결과가 올바르지 않습니다."
        );
      }

      const result = await traceOperationSpan("SERVICE_WRITE", () =>
        recordManualWriteDecision({
          requestId,
          userId: user.userId,
          targetId: positiveId(body.targetId, "대상 그룹 대표 ID"),
          decision: decision as (typeof allowed)[number],
          note: body.note,
        })
      );
      const authoritativeResult = {
        requestId,
        requestStatus: result.request_status,
        manualVerificationStatus: result.manual_verification_status,
      };
      const receipt = createMutationReceipt(authoritativeResult, {
        operationId: stableMutationOperationId("sales-channel-decision", [
          requestId,
          decision,
          result.request_status,
        ]),
        committedAt: result.updated_at,
      });
      const settledReceipt =
        decision !== SALES_CHANNEL_WRITE_MANUAL_VERIFICATION.undecidable
          ? await settleOptionalWorkerWake(receipt, wakeDependentWorkers)
          : receipt;
      return NextResponse.json({
        ok: true,
        message: "직접 확인 결과를 저장했습니다.",
        result: authoritativeResult,
        receipt: settledReceipt,
      });
    }

    return NextResponse.json(
      { ok: false, message: "지원하지 않는 처리입니다." },
      { status: 400 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
    }
  );
}
