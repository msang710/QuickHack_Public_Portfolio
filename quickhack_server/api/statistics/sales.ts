// QuickHack API: confirmed sales-ledger statistics for LEADER users.
import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  resolveStatisticsPeriodRequest,
  statisticsPeriodErrorMessage,
  statisticsSearchUnsupportedMessage,
} from "@/quickhack_server/statistics/statistics-period-request";
import {
  runOperationTrace,
  setOperationTraceField,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);

  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/statistics/sales${requestUrl.search}`,
      {
        method: "GET",
        contentType: null,
      }
    );
  }

  return runOperationTrace(
    {
      operationName: "statistics.sales.read",
      source: "HTTP",
      route: "/api/statistics/sales",
      method: "GET",
    },
    async () => {
      const [
        { getAuthUserFromRequest },
        statisticsService,
        statisticsDispatcher,
      ] =
        await Promise.all([
          import("@/quickhack_server/auth/auth-service"),
          import("@/quickhack_server/statistics/sales-statistics-service"),
          import("@/quickhack_server/statistics/statistics-read-dispatcher"),
        ]);
      const user = await getAuthUserFromRequest(request);

      if (!user) {
        return NextResponse.json(
          { ok: false, message: "로그인이 필요합니다." },
          { status: 401 }
        );
      }

      if (!canAccessRole(user.role, "LEADER")) {
        return NextResponse.json(
          { ok: false, message: "판매 통계 조회 권한이 없습니다." },
          { status: 403 }
        );
      }

      setOperationTraceUserId(user.userId);

      const unsupportedSearchMessage =
        statisticsSearchUnsupportedMessage(requestUrl.searchParams);

      if (unsupportedSearchMessage) {
        return NextResponse.json(
          { ok: false, message: unsupportedSearchMessage },
          { status: 400 }
        );
      }

      let period;

      try {
        period = resolveStatisticsPeriodRequest({
          fromDate: requestUrl.searchParams.get("fromDate"),
          toDate: requestUrl.searchParams.get("toDate"),
        });
      } catch (error) {
        const message = statisticsPeriodErrorMessage(error);

        if (message) {
          return apiFailureResponse({
            status: 400,
            code: "INVALID_STATISTICS_PERIOD",
            message,
            cause: error,
          });
        }
        throw error;
      }

      setOperationTraceField(
        "statistics.period_from_date",
        period.range.fromDate
      );
      setOperationTraceField(
        "statistics.period_to_date",
        period.range.toDate
      );
      setOperationTraceField(
        "statistics.data_cutoff_date",
        period.dataCutoffDate
      );

      const { prisma } = await import("@/quickhack_server/core/prisma");

      try {
        const dispatch = await traceOperationSpan("SERVICE_READ", () =>
          statisticsDispatcher.dispatchStatisticsRead(prisma, {
            domain: "SALES",
            period,
            calculateLive: () =>
              statisticsService.getSalesStatisticsData(prisma, {
                period,
              }),
          })
        );
        const data = dispatch.data;

        for (const [name, value] of Object.entries(
          statisticsDispatcher.statisticsReadDispatchTraceFields(dispatch)
        )) {
          setOperationTraceField(name, value);
        }

        setOperationTraceTargetCount(data.source.eligibleSaleRecordCount);
        setOperationTraceField(
          "statistics.sale_count",
          data.source.eligibleSaleRecordCount
        );
        setOperationTraceField(
          "statistics.sales_price_coverage_percent",
          data.source.salesPriceCoveragePercent
        );
        setOperationTraceField(
          "statistics.purchase_price_coverage_percent",
          data.source.purchasePriceCoveragePercent
        );
        setOperationTraceField(
          "statistics.profit_coverage_percent",
          data.source.profitCoveragePercent
        );
        setOperationTraceField(
          "statistics.invalid_timestamp_count",
          data.source.invalidSoldAtCount + data.source.futureSoldAtCount
        );

        return NextResponse.json({
          ok: true,
          data,
        });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
  );
}
