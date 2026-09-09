// QuickHack API: closed-period inventory statistics for LEADER users.
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
import {
  resolveStatisticsPeriodRequest,
  statisticsPeriodErrorCode,
  statisticsSearchUnsupportedMessage,
} from "@/quickhack_server/statistics/statistics-period-request";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);

  if (isClientRuntime()) {
    return proxyToServer(
      request,
      `/api/statistics/inventory${requestUrl.search}`,
      {
        method: "GET",
        contentType: null,
      }
    );
  }

  return runOperationTrace(
    {
      operationName: "statistics.inventory.read",
      source: "HTTP",
      route: "/api/statistics/inventory",
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
          import("@/quickhack_server/statistics/inventory-statistics-service"),
          import("@/quickhack_server/statistics/statistics-read-dispatcher"),
        ]);
      const user = await getAuthUserFromRequest(request);

      if (!user) {
        return NextResponse.json(
          { ok: false, code: "AUTH_REQUIRED" },
          { status: 401 }
        );
      }

      if (!canAccessRole(user.role, "LEADER")) {
        return NextResponse.json(
          { ok: false, code: "FORBIDDEN" },
          { status: 403 }
        );
      }

      setOperationTraceUserId(user.userId);

      const unsupportedSearchCode =
        statisticsSearchUnsupportedMessage(requestUrl.searchParams);

      if (unsupportedSearchCode) {
        return NextResponse.json(
          { ok: false, code: unsupportedSearchCode },
          { status: 400 }
        );
      }

      const hasPreset = requestUrl.searchParams.has("period");
      const hasExactRange =
        requestUrl.searchParams.has("fromDate") ||
        requestUrl.searchParams.has("toDate");

      if (hasPreset && hasExactRange) {
        return NextResponse.json(
          {
            ok: false,
            code: "STATISTICS_PERIOD_CONFLICT",
          },
          { status: 400 }
        );
      }

      let statisticsOptions:
        | {
            period: ReturnType<
              typeof statisticsService.normalizeInventoryStatisticsPeriod
            >;
          }
        | {
            periodContext: ReturnType<
              typeof resolveStatisticsPeriodRequest
            >;
          };

      if (hasPreset) {
        try {
          statisticsOptions = {
            period:
              statisticsService.normalizeInventoryStatisticsPeriod(
                requestUrl.searchParams.get("period") ?? ""
              ),
          };
        } catch (error) {
          if (
            error instanceof statisticsService.InventoryStatisticsPeriodError
          ) {
            return apiFailureResponse({
              status: 400,
              code: "INVALID_INVENTORY_STATISTICS_PERIOD",
              cause: error,
            });
          }
          throw error;
        }
      } else {
        try {
          statisticsOptions = {
            periodContext: resolveStatisticsPeriodRequest({
              fromDate: requestUrl.searchParams.get("fromDate"),
              toDate: requestUrl.searchParams.get("toDate"),
            }),
          };
        } catch (error) {
          const code = statisticsPeriodErrorCode(error);

          if (code) {
            return NextResponse.json(
              { ok: false, code },
              { status: 400 }
            );
          }
          throw error;
        }
      }

      if ("period" in statisticsOptions) {
        setOperationTraceField(
          "statistics.inventory_period",
          statisticsOptions.period
        );
      } else {
        setOperationTraceField("statistics.inventory_period", "custom");
      }
      const { prisma } = await import("@/quickhack_server/core/prisma");

      try {
        const dispatch = await traceOperationSpan("SERVICE_READ", () =>
          statisticsDispatcher.dispatchStatisticsRead(prisma, {
            domain: "INVENTORY",
            period:
              "periodContext" in statisticsOptions
                ? statisticsOptions.periodContext
                : null,
            calculateLive: () =>
              statisticsService.getInventoryStatisticsData(
                prisma,
                statisticsOptions
              ),
          })
        );
        const data = dispatch.data;

        for (const [name, value] of Object.entries(
          statisticsDispatcher.statisticsReadDispatchTraceFields(dispatch)
        )) {
          setOperationTraceField(name, value);
        }

        setOperationTraceTargetCount(data.source.inventoryRowCount);
        setOperationTraceField(
          "statistics.inventory_availability",
          data.integrity.availability
        );
        setOperationTraceField(
          "statistics.inventory_rows",
          data.source.inventoryRowCount
        );
        setOperationTraceField(
          "statistics.balance_quantity",
          data.source.balanceQuantity
        );
        setOperationTraceField(
          "statistics.sku_status_mismatch_count",
          data.source.skuStatusMismatchCount
        );
        setOperationTraceField(
          "statistics.unknown_status_count",
          data.source.unknownInventoryStatusCount +
            data.source.unknownBalanceStatusCount
        );
        setOperationTraceField(
          "statistics.unclassified_inventory_count",
          data.source.unclassifiedInventoryRowCount
        );
        setOperationTraceField(
          "statistics.inventory_period_availability",
          data.period.integrity.availability
        );
        setOperationTraceField(
          "statistics.inventory_period_operation_count",
          data.period.source.operationCount
        );
        setOperationTraceField(
          "statistics.inventory_period_sale_count",
          data.period.source.saleRecordCount
        );
        setOperationTraceField(
          "statistics.inventory_period_unclassified_sale_count",
          data.period.source.unclassifiedSaleRecordCount
        );
        setOperationTraceField(
          "statistics.inventory_cutoff_excluded_movements",
          data.source.cutoffExcludedMovementCount
        );
        setOperationTraceField(
          "statistics.inventory_cutoff_excluded_sales",
          data.source.cutoffExcludedSaleRecordCount
        );
        setOperationTraceField(
          "statistics.inventory_as_of_price_excluded",
          data.source.asOfPriceExcludedCount
        );
        setOperationTraceField(
          "statistics.inventory_as_of_reconstruction_issues",
          data.source.asOfReconstructionIssueCount
        );
        setOperationTraceField(
          "statistics.period_from_date",
          data.calculation.period.fromDate
        );
        setOperationTraceField(
          "statistics.period_to_date",
          data.calculation.period.toDate
        );
        setOperationTraceField(
          "statistics.data_cutoff_date",
          data.calculation.dataCutoffDate
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
