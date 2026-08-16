import {
  formatStatisticsAmount,
  formatStatisticsCurrency,
  formatStatisticsDate,
  formatStatisticsDuration,
  formatStatisticsMonth,
  formatStatisticsPercent,
  formatStatisticsRate,
  type StatisticsMetricPresentation,
} from "@/quickhack_client/components/statistics/statistics-metric-presentation";
import type {
  PurchaseAmountMetric,
  PurchaseDurationMetric,
  PurchasePricePolicyRow,
  PurchaseRateMetric,
} from "@/quickhack_shared/statistics/statistics";

export type PurchaseMetricPresentation = StatisticsMetricPresentation;

const pricePolicyLabels: Record<
  PurchasePricePolicyRow["entryMode"],
  string
> = {
  RATE: "기준가 적용",
  OVERRIDE: "기준가 조정",
  MANUAL: "수동 입력",
  UNKNOWN: "과거 미기록",
};

export function formatPurchaseRate(
  metric: PurchaseRateMetric,
  options: { maturityPending?: boolean } = {}
) {
  return formatStatisticsRate(metric, {
    unavailableValue: options.maturityPending ? "관찰 중" : "-",
  });
}

export function formatPurchaseAmount(metric: PurchaseAmountMetric) {
  return formatStatisticsAmount(metric);
}

export function formatPurchaseDuration(metric: PurchaseDurationMetric) {
  return formatStatisticsDuration(metric);
}

export function formatPurchaseAveragePrice(value: number | null) {
  return value === null ? "-" : formatStatisticsCurrency(value);
}

export function formatPurchaseAdjustmentAmount(value: number | null) {
  if (value === null) {
    return "-";
  }

  if (value === 0) {
    return formatStatisticsCurrency(0);
  }

  const absolute = formatStatisticsCurrency(Math.abs(value));
  return value > 0 ? `+${absolute}` : `-${absolute}`;
}

export function formatPurchaseAdjustmentPercent(value: number | null) {
  if (value === null) {
    return "-";
  }

  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatStatisticsPercent(value)}%`;
}

export function purchasePricePolicyLabel(
  entryMode: PurchasePricePolicyRow["entryMode"]
) {
  return pricePolicyLabels[entryMode];
}

export function formatPurchaseStatisticsDate(value: string | null) {
  return formatStatisticsDate(value);
}

export function formatPurchaseStatisticsMonth(value: string) {
  return formatStatisticsMonth(value);
}
