"use client";

import { useTranslations } from "next-intl";
import { StatisticsCoverageItem } from "@/quickhack_client/components/statistics/statistics-visuals";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import type { StatisticsCalculationMetadata } from "@/quickhack_shared/statistics/statistics";

type CalculationScopeTranslator = ReturnType<typeof useTranslations<"statistics.calculationScope">>;

function calculationMethod(calculation: StatisticsCalculationMetadata, t: CalculationScopeTranslator) {
  const delivery = calculation.delivery;

  if (delivery?.status === "LIVE_FALLBACK") {
    return {
      value: t("method.liveFallback"),
      description: t("method.automaticFallback"),
    };
  }
  if (delivery?.status === "LIVE_CUSTOM_PERIOD") {
    return {
      value: t("method.live"),
      description: t("method.customPeriod"),
    };
  }
  if (delivery?.status === "SNAPSHOT_DELAYED") {
    return {
      value: t("method.snapshot"),
      description: t("method.delayed", { days: delivery.snapshotCutoffLagDays }),
    };
  }
  if (delivery?.status === "SNAPSHOT_CURRENT") {
    return {
      value: t("method.snapshot"),
      description: t("method.current"),
    };
  }

  return {
    value:
      calculation.mode === "LIVE"
        ? t("method.live")
        : t("method.snapshot"),
    description: calculation.isDefaultPeriod ? t("method.defaultPeriod") : t("method.custom"),
  };
}

function fallbackDescription(
  calculation: StatisticsCalculationMetadata,
  t: CalculationScopeTranslator
) {
  const delivery = calculation.delivery;

  if (delivery?.status !== "LIVE_FALLBACK") {
    return null;
  }

  switch (delivery.fallbackReason) {
    case "NOT_FOUND":
      return t("fallback.notFound");
    case "TOO_OLD":
      return t("fallback.tooOld");
    case "INVALID":
      return t("fallback.invalid");
  }
}

export function StatisticsCalculationScope({
  calculation,
}: {
  calculation: StatisticsCalculationMetadata;
}) {
  const t = useTranslations("statistics.calculationScope");
  const method = calculationMethod(calculation, t);
  const fallbackMessage = fallbackDescription(calculation, t);
  const delayedDelivery =
    calculation.delivery?.status === "SNAPSHOT_DELAYED"
      ? calculation.delivery
      : null;

  return (
    <>
      {delayedDelivery ? (
        <FeedbackBanner
          tone="warning"
          size="xs"
          className="md:col-span-2 xl:col-span-4"
        >
          {t("delayed", { days: delayedDelivery.snapshotCutoffLagDays, date: delayedDelivery.snapshotCutoffDate })}
        </FeedbackBanner>
      ) : null}
      {fallbackMessage ? (
        <FeedbackBanner
          tone="info"
          size="xs"
          className="md:col-span-2 xl:col-span-4"
        >
          {fallbackMessage}
        </FeedbackBanner>
      ) : null}
      <StatisticsCoverageItem
        label={t("labels.method")}
        value={method.value}
        description={method.description}
      />
      <StatisticsCoverageItem
        label={t("labels.period")}
        value={`${calculation.period.fromDate} ~ ${calculation.period.toDate}`}
        description={t("days", { days: calculation.period.dayCount })}
      />
      <StatisticsCoverageItem
        label={t("labels.comparison")}
        value={`${calculation.comparisonPeriod.fromDate} ~ ${calculation.comparisonPeriod.toDate}`}
        description={t("comparisonDays", { days: calculation.comparisonPeriod.dayCount })}
      />
      <StatisticsCoverageItem
        label={t("labels.cutoff")}
        value={calculation.dataCutoffDate}
        description={
          delayedDelivery
            ? t("cutoffDelayed")
            : t("cutoffCurrent")
        }
      />
    </>
  );
}
