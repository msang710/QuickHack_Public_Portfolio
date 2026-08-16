// QuickHack note: 저장된 사용자 조작 trace를 응답 성능 측정 메뉴에 제공하는 개발자 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  RESPONSE_PERFORMANCE_RANGE_VALUES,
  RESPONSE_PERFORMANCE_STATUS_VALUES,
  type ResponsePerformanceRange,
  type ResponsePerformanceStatusFilter,
} from "@/quickhack_shared/observability/response-performance";

export const runtime = "nodejs";

function badRequest(message: string) {
  return NextResponse.json({ ok: false, message }, { status: 400 });
}

function requestedRange(value: string | null): ResponsePerformanceRange | null {
  if (value === null || value === "") return "24h";

  return RESPONSE_PERFORMANCE_RANGE_VALUES.includes(
    value as ResponsePerformanceRange
  )
    ? (value as ResponsePerformanceRange)
    : null;
}

function requestedStatus(
  value: string | null
): ResponsePerformanceStatusFilter | null {
  if (value === null || value === "") return "ALL";

  return RESPONSE_PERFORMANCE_STATUS_VALUES.includes(
    value as ResponsePerformanceStatusFilter
  )
    ? (value as ResponsePerformanceStatusFilter)
    : null;
}

function requestedLogId(value: string | null) {
  if (value === null || value === "") return null;
  const parsed = Number.parseInt(value, 10);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/developer/response-performance${request.nextUrl.search}`,
      {
        method: "GET",
        contentType: null,
      }
    );
  }

  const [{ requireDeveloper }, performanceService] = await Promise.all([
    import("@/quickhack_server/api/developer/common"),
    import(
      "@/quickhack_server/observability/response-performance-service"
    ),
  ]);
  const auth = await requireDeveloper(request);

  if (!auth.ok) return auth.response;

  const logId = requestedLogId(request.nextUrl.searchParams.get("logId"));

  if (Number.isNaN(logId)) {
    return badRequest("성능 trace 로그 ID가 올바르지 않습니다.");
  }

  if (logId !== null) {
    const item = await performanceService.loadResponsePerformanceTraceDetail(
      logId
    );

    if (!item) {
      return NextResponse.json(
        { ok: false, message: "성능 trace를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true, mode: "DETAIL", item });
  }

  const range = requestedRange(request.nextUrl.searchParams.get("range"));
  const status = requestedStatus(request.nextUrl.searchParams.get("status"));

  if (!range) {
    return badRequest("조회 기간이 올바르지 않습니다.");
  }

  if (!status) {
    return badRequest("조회 상태가 올바르지 않습니다.");
  }

  const operation = String(
    request.nextUrl.searchParams.get("operation") ?? ""
  ).trim();

  if (operation.length > 120) {
    return badRequest("조작 이름은 120자 이내여야 합니다.");
  }

  const report = await performanceService.loadResponsePerformanceReport({
    range,
    status,
    operation,
  });

  return NextResponse.json(report);
}
