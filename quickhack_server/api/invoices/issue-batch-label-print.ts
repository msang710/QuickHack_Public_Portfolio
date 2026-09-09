import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { AUTH_COOKIE_NAME } from "@/quickhack_shared/auth/auth-constants";
import {
  markOperationTraceFailed,
  runOperationTrace,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ issueBatchId?: string }>;
};

function parseJsonObject(text: string) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function authorize(request: NextRequest) {
  const { getAuthSessionFromRequest, toAuthUser } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const session = await getAuthSessionFromRequest(request);
  if (!session) {
    return {
      response: NextResponse.json(
        { ok: false, code: "AUTH_REQUIRED" },
        { status: 401 }
      ),
      user: null,
    };
  }
  const user = toAuthUser(session.users);
  if (!canAccessRole(user.role, "STAFF")) {
    return {
      response: NextResponse.json(
        { ok: false, code: "FORBIDDEN" },
        { status: 403 }
      ),
      user: null,
    };
  }
  setOperationTraceUserId(user.userId);
  return {
    response: null,
    user,
    sessionId: String(session.session_id),
    previewTokenSecret: request.cookies.get(AUTH_COOKIE_NAME)?.value ?? "",
  };
}

function errorResponse(error: unknown) {
  if (
    error instanceof Error &&
    error.name === "LogenLabelPrintError" &&
    "code" in error &&
    "status" in error
  ) {
    const rawStatus = Number(error.status);
    const status = rawStatus === 400 || rawStatus === 403 || rawStatus === 404
      ? rawStatus
      : 409;
    return apiFailureResponse({
      status,
      code: String(error.code),
      extra: {
        blockers:
          "blockers" in error && Array.isArray(error.blockers)
            ? error.blockers
            : [],
      },
      cause: error,
    });
  }
  return apiErrorResponse(error);
}

function proxyPath(issueBatchId: string) {
  return `/api/invoices/issue-batches/${encodeURIComponent(
    issueBatchId
  )}/label-print`;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const issueBatchId = String(params.issueBatchId ?? "").trim();
  if (isClientRuntime()) {
    return proxyToServer(request, proxyPath(issueBatchId), {
      method: "GET",
      contentType: null,
    });
  }
  return runOperationTrace(
    {
      operationName: "carrier.label-print.read",
      source: "HTTP",
      route: "/api/invoices/issue-batches/[issueBatchId]/label-print",
      method: "GET",
      targetCount: 1,
    },
    async () => {
      const auth = await authorize(request);
      if (auth.response) return auth.response;
      const service = await import(
        "@/quickhack_server/shipment/carrier-integration/logen/label-print-service"
      );
      try {
        const result = await traceOperationSpan("SERVICE_READ", () =>
          service.getLogenLabelPrintView({ issueBatchId })
        );
        const { issueOutputPreviewToken } = await import(
          "@/quickhack_server/shipment/output-preview-token"
        );
        const previewToken = issueOutputPreviewToken(
          {
            userId: auth.user!.userId,
            sessionId: auth.sessionId!,
            issueBatchId: result.issueBatchId,
            shipmentListPrintBatchId: result.shipmentListPrintBatchId,
            revision: result.batchRevision,
            payloadHash: result.previewPayloadHash,
            expiresAt: Date.now() + 5 * 60_000,
          },
          auth.previewTokenSecret!
        );
        setOperationTraceTargetCount(result.items.length);
        return NextResponse.json({ ok: true, labelPrint: result, previewToken });
      } catch (error) {
        return errorResponse(error);
      }
    }
  );
}

export async function POST(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const issueBatchId = String(params.issueBatchId ?? "").trim();
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, proxyPath(issueBatchId), {
      method: "POST",
      body: bodyText,
    });
  }
  return runOperationTrace(
    {
      operationName: "carrier.label-print.start",
      source: "HTTP",
      route: "/api/invoices/issue-batches/[issueBatchId]/label-print",
      method: "POST",
    },
    async () => {
      const auth = await authorize(request);
      if (auth.response || !auth.user) return auth.response;
      const body = parseJsonObject(bodyText);
      if (!body) {
        return NextResponse.json(
          { ok: false, code: "INVALID_BODY" },
          { status: 400 }
        );
      }
      const service = await import(
        "@/quickhack_server/shipment/carrier-integration/logen/label-print-service"
      );
      try {
        const result = await traceOperationSpan("SERVICE_WRITE", () =>
          service.startLogenLabelPrint({
            issueBatchId,
            printerName: body.printerName,
            userId: auth.user.userId,
            sessionId: auth.sessionId!,
            previewToken: String(body.previewToken ?? ""),
            previewTokenSecret: auth.previewTokenSecret!,
          })
        );
        setOperationTraceTargetCount(result.labels.length);
        return NextResponse.json({ ok: true, labelPrint: result });
      } catch (error) {
        return errorResponse(error);
      }
    }
  );
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const issueBatchId = String(params.issueBatchId ?? "").trim();
  const bodyText = await request.text();
  if (isClientRuntime()) {
    return proxyToServer(request, proxyPath(issueBatchId), {
      method: "PATCH",
      body: bodyText,
    });
  }
  return runOperationTrace(
    {
      operationName: "carrier.label-print.update",
      source: "HTTP",
      route: "/api/invoices/issue-batches/[issueBatchId]/label-print",
      method: "PATCH",
    },
    async () => {
      const auth = await authorize(request);
      if (auth.response || !auth.user) return auth.response;
      const body = parseJsonObject(bodyText);
      if (!body) {
        return NextResponse.json(
          { ok: false, code: "INVALID_BODY" },
          { status: 400 }
        );
      }
      const service = await import(
        "@/quickhack_server/shipment/carrier-integration/logen/label-print-service"
      );
      const action = String(body.action ?? "").trim().toUpperCase();
      try {
        const result = await traceOperationSpan("SERVICE_WRITE", () => {
          if (
            action === "RESOLVE_PRINTED" ||
            action === "RESOLVE_NOT_PRINTED"
          ) {
            if (!canAccessRole(auth.user.role, "MANAGER")) {
              throw new service.LogenLabelPrintError(
                "LABEL_PRINT_RESOLUTION_FORBIDDEN",
                "Manager permission is required to resolve an unknown print result.",
                403
              );
            }
            return service.resolveUnknownLogenLabelPrint({
              issueBatchId,
              printed: action === "RESOLVE_PRINTED",
              expectedPrintAttemptCount: body.expectedPrintAttemptCount,
              userId: auth.user.userId,
            });
          }
          const common = {
            issueBatchId,
            requestKey: body.requestKey,
            payloadHash: body.payloadHash,
            expectedPrintAttemptCount: body.expectedPrintAttemptCount,
            userId: auth.user.userId,
          };
          if (action === "SPOOLED") {
            return service.recordLogenLabelPrintSpooled(common);
          }
          if (action === "CONFIRM") {
            return service.confirmLogenLabelPrint({
              ...common,
              failedIssueItemIds: body.failedIssueItemIds,
            });
          }
          if (action === "FAILED" || action === "UNKNOWN") {
            return service.failLogenLabelPrint({
              ...common,
              uncertain: action === "UNKNOWN",
              errorCode: body.errorCode,
              errorMessage: body.errorMessage,
            });
          }
          throw new service.LogenLabelPrintError(
            "INVALID_LABEL_PRINT_ACTION",
            "Unsupported label print action.",
            400
          );
        });
        let replacementProgress: unknown = null;
        let replacementProgressError: string | null = null;
        if (action === "CONFIRM" || action === "RESOLVE_PRINTED") {
          try {
            const replacementService = await import(
              "@/quickhack_server/shipment/carrier-integration/coupang-invoice-replacement-service"
            );
            replacementProgress = await traceOperationSpan(
              "REPLACEMENT_PROGRESS",
              () =>
                replacementService.getCarrierInvoiceReplacementForIssueBatch(
                  { issueBatchId }
                )
            );
          } catch (error) {
            markOperationTraceFailed(
              error,
              "INVOICE_REPLACEMENT_PROGRESS_FAILED"
            );
            replacementProgressError =
              "송장 교체 진행 상태를 확인하지 못했습니다.";
          }
        }
        setOperationTraceTargetCount(result.items.length);
        return NextResponse.json({
          ok: true,
          labelPrint: result,
          replacementProgress,
          replacementProgressError,
        });
      } catch (error) {
        return errorResponse(error);
      }
    }
  );
}
