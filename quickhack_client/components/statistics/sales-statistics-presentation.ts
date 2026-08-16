import {
  formatStatisticsAmount,
  formatStatisticsCount,
  formatStatisticsCurrency,
  formatStatisticsDate,
  formatStatisticsMonth,
  formatStatisticsPercent,
  formatStatisticsRate,
  type StatisticsMetricPresentation,
} from "@/quickhack_client/components/statistics/statistics-metric-presentation";
import type {
  SalesAmountMetric,
  SalesGrossProfitMetric,
  SalesLeadTimeMetric,
  SalesRateMetric,
} from "@/quickhack_shared/statistics/statistics";

export type SalesMetricPresentation = StatisticsMetricPresentation;

export function formatSalesAmount(metric: SalesAmountMetric) {
  return formatStatisticsAmount(metric);
}

export function formatSalesRate(metric: SalesRateMetric) {
  return formatStatisticsRate(metric);
}

export function formatSalesAveragePrice(
  value: number | null,
  pricedCount: number,
  totalCount: number
): SalesMetricPresentation {
  return {
    value: value === null ? "-" : formatStatisticsCurrency(value),
    detail: `가격 확인 ${formatStatisticsCount(
      pricedCount
    )} / ${formatStatisticsCount(totalCount)}건`,
  };
}

export function formatSalesGrossProfit(
  metric: SalesGrossProfitMetric
): SalesMetricPresentation {
  const margin =
    metric.marginPercent === null
      ? "이익률 -"
      : `이익률 ${formatStatisticsPercent(metric.marginPercent)}%`;

  return {
    value:
      metric.amount === null
        ? "-"
        : formatStatisticsCurrency(metric.amount),
    detail: `${margin} · 비교 ${formatStatisticsCount(
      metric.comparableCount
    )} / ${formatStatisticsCount(
      metric.totalCount
    )}건 · ${formatStatisticsPercent(metric.coveragePercent)}%`,
  };
}

export function formatSalesLeadTime(
  metric: SalesLeadTimeMetric
): SalesMetricPresentation {
  const anomaly =
    metric.excludedAnomalyCount > 0
      ? ` · 이상 ${formatStatisticsCount(
          metric.excludedAnomalyCount
        )}건 제외`
      : "";

  return {
    value:
      metric.averageDays === null
        ? "-"
        : `${formatStatisticsPercent(metric.averageDays)}일`,
    detail: `표본 ${formatStatisticsCount(
      metric.sampleCount
    )} / ${formatStatisticsCount(
      metric.totalCount
    )}건 · ${formatStatisticsPercent(metric.coveragePercent)}%${anomaly}`,
  };
}

export function formatSalesStatisticsDate(value: string) {
  return formatStatisticsDate(value);
}

export function formatSalesStatisticsMonth(value: string) {
  return formatStatisticsMonth(value);
}
