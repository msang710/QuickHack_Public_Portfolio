"use client";

import { useLocale, useTranslations } from "next-intl";
import type { StatisticsUnavailableReason } from "@/quickhack_shared/statistics/statistics";

export type StatisticsMetricPresentation = { value: string; detail: string };
export type StatisticsRateMetricLike = StatisticsUnavailableReason & { value: number | null; numerator: number; denominator: number };
export type StatisticsAmountMetricLike = { amount: number | null; pricedCount: number; totalCount: number; coveragePercent: number };
export type StatisticsDurationMetricLike = { sampleCount: number; medianHours: number | null; p90Hours: number | null; excludedAnomalyCount: number };

export function useStatisticsMetricPresentation() {
  const locale = useLocale();
  const t = useTranslations("statistics.metric");
  const intlLocale = locale;
  const percent = new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 });
  const number = new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 0 });
  const currency = new Intl.NumberFormat(intlLocale, { currency: "KRW", maximumFractionDigits: 0, style: "currency" });
  const dateTime = new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" });
  const formatCount = (value: number) => number.format(value);
  const formatPercent = (value: number) => percent.format(value);
  const formatCurrency = (value: number) => currency.format(value);
  const formatUnavailableReason = (metric: StatisticsUnavailableReason, fallback: string) => {
    if (metric.unavailableReasonCode) {
      const translateReason = t as unknown as (
        key: string,
        values?: Record<string, number>
      ) => string;
      return translateReason(`unavailableReason.${metric.unavailableReasonCode}`, {
        days: metric.unavailableReasonDays ?? 0,
      });
    }
    return metric.unavailableReason ?? fallback;
  };
  const formatRate = (metric: StatisticsRateMetricLike, options: { unavailableValue?: string } = {}): StatisticsMetricPresentation =>
    metric.value === null
      ? { value: options.unavailableValue ?? "-", detail: formatUnavailableReason(metric, t("sample", { count: metric.denominator })) }
      : { value: `${formatPercent(metric.value)}%`, detail: t("ratio", { numerator: metric.numerator, denominator: metric.denominator }) };
  const formatAmount = (metric: StatisticsAmountMetricLike): StatisticsMetricPresentation =>
    metric.amount === null || metric.pricedCount === 0
      ? { value: "-", detail: t("priceCoverage", { priced: metric.pricedCount, total: metric.totalCount }) }
      : { value: formatCurrency(metric.amount), detail: t("priceCoveragePercent", { priced: metric.pricedCount, total: metric.totalCount, coverage: metric.coveragePercent }) };
  const formatDuration = (metric: StatisticsDurationMetricLike): StatisticsMetricPresentation => {
    if (metric.sampleCount === 0 || metric.medianHours === null) {
      return { value: "-", detail: metric.excludedAnomalyCount > 0 ? t("noSampleAnomaly", { count: metric.excludedAnomalyCount }) : t("noSample") };
    }
    const p90 = metric.p90Hours === null ? t("p90Unavailable") : t("p90", { hours: metric.p90Hours });
    const anomaly = metric.excludedAnomalyCount > 0 ? t("anomaly", { count: metric.excludedAnomalyCount }) : "";
    return { value: t("hours", { hours: metric.medianHours }), detail: `${p90} · ${t("sample", { count: metric.sampleCount })}${anomaly}` };
  };
  const formatDate = (value: string | null) => {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : dateTime.format(date);
  };
  const formatMonth = (value: string) => {
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    return match ? t("month", { year: Number(match[1]), month: Number(match[2]) }) : value;
  };
  return { formatAmount, formatCount, formatCurrency, formatDate, formatDuration, formatMonth, formatPercent, formatRate, formatUnavailableReason };
}
