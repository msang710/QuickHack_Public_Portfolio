import type { StatisticsCalculationMetadata } from "@/quickhack_shared/statistics/statistics";
import {
  resolveClosedStatisticsPeriod,
  statisticsPeriodErrorMessage as sharedStatisticsPeriodErrorMessage,
  statisticsDateRangeDayCount,
  type StatisticsPeriodContext,
} from "@/quickhack_shared/statistics/statistics-period";

export const STATISTICS_SEARCH_UNSUPPORTED_MESSAGE =
  "통계 검색은 지원하지 않습니다. 기간을 적용하거나 각 통계의 항목별 분석표를 이용하세요.";

export function statisticsSearchUnsupportedMessage(
  searchParams: URLSearchParams
) {
  return searchParams.has("q")
    ? STATISTICS_SEARCH_UNSUPPORTED_MESSAGE
    : null;
}

export function resolveStatisticsPeriodRequest(input: {
  now?: Date;
  fromDate?: unknown;
  toDate?: unknown;
}) {
  return resolveClosedStatisticsPeriod(input);
}

export function statisticsPeriodErrorMessage(error: unknown) {
  return sharedStatisticsPeriodErrorMessage(error);
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
