"use client";

import { useTranslations } from "next-intl";
import { useStatisticsMetricPresentation, type StatisticsMetricPresentation } from "@/quickhack_client/components/statistics/statistics-metric-presentation";
import type { SalesAmountMetric, SalesGrossProfitMetric, SalesLeadTimeMetric, SalesRateMetric } from "@/quickhack_shared/statistics/statistics";

export type SalesMetricPresentation = StatisticsMetricPresentation;

export function useSalesStatisticsPresentation() {
  const t = useTranslations("statistics.sales.presentation");
  const base = useStatisticsMetricPresentation();
  const formatAveragePrice = (value: number | null, pricedCount: number, totalCount: number): SalesMetricPresentation => ({
    value: value === null ? "-" : base.formatCurrency(value),
    detail: t("priceCoverage", { priced: pricedCount, total: totalCount }),
  });
  const formatGrossProfit = (metric: SalesGrossProfitMetric): SalesMetricPresentation => {
    const margin = metric.marginPercent === null ? t("marginUnavailable") : t("margin", { value: base.formatPercent(metric.marginPercent) });
    return {
      value: metric.amount === null ? "-" : base.formatCurrency(metric.amount),
      detail: t("profitDetail", { margin, comparable: metric.comparableCount, total: metric.totalCount, coverage: metric.coveragePercent }),
    };
  };
  const formatLeadTime = (metric: SalesLeadTimeMetric): SalesMetricPresentation => {
    const anomaly = metric.excludedAnomalyCount > 0 ? t("anomaly", { count: metric.excludedAnomalyCount }) : "";
    return {
      value: metric.averageDays === null ? "-" : t("days", { days: metric.averageDays }),
      detail: t("leadDetail", { sample: metric.sampleCount, total: metric.totalCount, coverage: metric.coveragePercent, anomaly }),
    };
  };
  return {
    formatAmount: (metric: SalesAmountMetric) => base.formatAmount(metric),
    formatAveragePrice,
    formatDate: base.formatDate,
    formatGrossProfit,
    formatLeadTime,
    formatMonth: base.formatMonth,
    formatRate: (metric: SalesRateMetric) => base.formatRate(metric),
  };
}
