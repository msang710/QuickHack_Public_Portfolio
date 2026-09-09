"use client";

import { useTranslations } from "next-intl";
import { useStatisticsMetricPresentation, type StatisticsMetricPresentation } from "@/quickhack_client/components/statistics/statistics-metric-presentation";
import type { ReturnAmountMetric, ReturnDurationMetric, ReturnRateMetric } from "@/quickhack_shared/statistics/statistics";

export type ReturnMetricPresentation = StatisticsMetricPresentation;

export function useReturnStatisticsPresentation() {
  const t = useTranslations("statistics.returns.presentation");
  const base = useStatisticsMetricPresentation();
  const formatDelta = (percentagePoints: number | null): ReturnMetricPresentation => {
    if (percentagePoints === null) {
      return { value: t("comparisonUnavailable"), detail: t("comparisonUnavailableDetail") };
    }
    return {
      value: `${percentagePoints > 0 ? "+" : ""}${base.formatPercent(percentagePoints)}%p`,
      detail: t("previousCohort"),
    };
  };
  return {
    formatAmount: (metric: ReturnAmountMetric) => base.formatAmount(metric),
    formatDate: base.formatDate,
    formatDelta,
    formatDuration: (metric: ReturnDurationMetric) => base.formatDuration(metric),
    formatMonth: base.formatMonth,
    formatRate: (metric: ReturnRateMetric, options: { maturityPending?: boolean } = {}) =>
      base.formatRate(metric, { unavailableValue: options.maturityPending ? t("aggregating") : "-" }),
  };
}
