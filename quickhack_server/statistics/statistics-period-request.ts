import type { StatisticsCalculationMetadata } from "@/quickhack_shared/statistics/statistics";
import {
  resolveClosedStatisticsPeriod,
  statisticsPeriodErrorCode as sharedStatisticsPeriodErrorCode,
  statisticsDateRangeDayCount,
  type StatisticsPeriodContext,
} from "@/quickhack_shared/statistics/statistics-period";

export const STATISTICS_SEARCH_UNSUPPORTED_CODE =
  "STATISTICS_SEARCH_UNSUPPORTED";

export function statisticsSearchUnsupportedMessage(
  searchParams: URLSearchParams
) {
  return searchParams.has("q")
    ? STATISTICS_SEARCH_UNSUPPORTED_CODE
    : null;
}

export function resolveStatisticsPeriodRequest(input: {
  now?: Date;
  fromDate?: unknown;
  toDate?: unknown;
}) {
  return resolveClosedStatisticsPeriod(input);
}

export function statisticsPeriodErrorCode(error: unknown) {
  return sharedStatisticsPeriodErrorCode(error);
}

export function liveStatisticsCalculationMetadata(
  period: StatisticsPeriodContext
): StatisticsCalculationMetadata {
  return {
    mode: "LIVE",
    period: {
      ...period.range,
      dayCount: period.dayCount,
    },
    comparisonPeriod: {
      ...period.previousRange,
      dayCount: statisticsDateRangeDayCount(period.previousRange),
    },
    dataCutoffDate: period.dataCutoffDate,
    isDefaultPeriod: period.isDefault,
  };
}
