"use client";

import { useTranslations } from "next-intl";
import { useStatisticsMetricPresentation, type StatisticsMetricPresentation } from "@/quickhack_client/components/statistics/statistics-metric-presentation";
import type { PurchaseAmountMetric, PurchaseDurationMetric, PurchaseRateMetric } from "@/quickhack_shared/statistics/statistics";

export type PurchaseMetricPresentation = StatisticsMetricPresentation;

export function usePurchaseStatisticsPresentation() {
  const t = useTranslations("statistics.purchase.presentation");
  const base = useStatisticsMetricPresentation();
  const formatAdjustmentAmount = (value: number | null) => {
    if (value === null) return "-";
    if (value === 0) return base.formatCurrency(0);
    const absolute = base.formatCurrency(Math.abs(value));
    return value > 0 ? `+${absolute}` : `-${absolute}`;
  };
  const formatAdjustmentPercent = (value: number | null) =>
    value === null ? "-" : `${value > 0 ? "+" : ""}${base.formatPercent(value)}%`;
  return {
    formatAdjustmentAmount,
    formatAdjustmentPercent,
    formatAmount: (metric: PurchaseAmountMetric) => base.formatAmount(metric),
    formatAveragePrice: (value: number | null) => value === null ? "-" : base.formatCurrency(value),
    formatDate: base.formatDate,
    formatDuration: (metric: PurchaseDurationMetric) => base.formatDuration(metric),
    formatMonth: base.formatMonth,
    formatRate: (metric: PurchaseRateMetric, options: { maturityPending?: boolean } = {}) =>
      base.formatRate(metric, { unavailableValue: options.maturityPending ? t("observing") : "-" }),
  };
}
