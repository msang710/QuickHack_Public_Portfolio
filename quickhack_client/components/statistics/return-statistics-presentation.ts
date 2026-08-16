import type {
  ReturnAmountMetric,
  ReturnDurationMetric,
  ReturnRateMetric,
} from "@/quickhack_shared/statistics/statistics";
import {
  formatStatisticsAmount,
  formatStatisticsDate,
  formatStatisticsDuration,
  formatStatisticsRate,
  formatStatisticsMonth,
  type StatisticsMetricPresentation,
} from "@/quickhack_client/components/statistics/statistics-metric-presentation";

export type ReturnMetricPresentation = StatisticsMetricPresentation;

const percentFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 1,
});

export function formatReturnRate(
  metric: ReturnRateMetric,
  options: { maturityPending?: boolean } = {}
): ReturnMetricPresentation {
  return formatStatisticsRate(metric, {
    unavailableValue: options.maturityPending ? "집계 중" : "-",
  });
}

export function formatReturnDelta(
  percentagePoints: number | null
): ReturnMetricPresentation {
  if (percentagePoints === null) {
    return {
      value: "비교 불가",
      detail: "현재와 직전 성숙 cohort가 모두 있어야 비교할 수 있습니다.",
    };
  }

  const prefix = percentagePoints > 0 ? "+" : "";
  return {
    value: `${prefix}${percentFormatter.format(percentagePoints)}%p`,
    detail: "직전 성숙 cohort 대비",
  };
}

export function formatReturnAmount(
  metric: ReturnAmountMetric
): ReturnMetricPresentation {
  return formatStatisticsAmount(metric);
}

export function formatReturnDuration(
  metric: ReturnDurationMetric
): ReturnMetricPresentation {
  return formatStatisticsDuration(metric);
}

export function formatReturnStatisticsDate(value: string | null) {
  return formatStatisticsDate(value);
}

export function formatReturnStatisticsMonth(value: string) {
  return formatStatisticsMonth(value);
}
