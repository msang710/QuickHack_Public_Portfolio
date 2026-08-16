"use client";

import { StatisticsCoverageItem } from "@/quickhack_client/components/statistics/statistics-visuals";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import type { StatisticsCalculationMetadata } from "@/quickhack_shared/statistics/statistics";

function calculationMethod(calculation: StatisticsCalculationMetadata) {
  const delivery = calculation.delivery;

  if (delivery?.status === "LIVE_FALLBACK") {
    return {
      value: "실시간 대체 계산",
      description: "저장 통계 자동 대체",
    };
  }
  if (delivery?.status === "LIVE_CUSTOM_PERIOD") {
    return {
      value: "실시간 계산",
      description: "직접 지정 기간",
    };
  }
  if (delivery?.status === "SNAPSHOT_DELAYED") {
    return {
      value: "저장된 일별 통계",
      description: `기본 기준보다 ${delivery.snapshotCutoffLagDays.toLocaleString(
        "ko-KR"
      )}일 지연`,
    };
  }
  if (delivery?.status === "SNAPSHOT_CURRENT") {
    return {
      value: "저장된 일별 통계",
      description: "기본 90일 · 최신 저장본",
    };
  }

  return {
    value:
      calculation.mode === "LIVE"
        ? "실시간 계산"
        : "저장된 일별 통계",
    description: calculation.isDefaultPeriod ? "기본 90일" : "직접 지정",
  };
}

function fallbackDescription(
  calculation: StatisticsCalculationMetadata
) {
  const delivery = calculation.delivery;

  if (delivery?.status !== "LIVE_FALLBACK") {
    return null;
  }

  switch (delivery.fallbackReason) {
    case "NOT_FOUND":
      return "저장 통계가 아직 없어 현재 원장을 실시간으로 계산했습니다.";
    case "TOO_OLD":
      return "저장 통계가 2일 이상 오래되어 현재 원장을 실시간으로 계산했습니다.";
    case "INVALID":
      return "저장 통계를 안전하게 확인할 수 없어 현재 원장을 실시간으로 계산했습니다.";
  }
}

export function StatisticsCalculationScope({
  calculation,
}: {
  calculation: StatisticsCalculationMetadata;
}) {
  const method = calculationMethod(calculation);
  const fallbackMessage = fallbackDescription(calculation);
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
          저장 통계가 현재 기본 기준보다{" "}
          {delayedDelivery.snapshotCutoffLagDays.toLocaleString("ko-KR")}일
          이전입니다. 실제 데이터 마감은{" "}
          {delayedDelivery.snapshotCutoffDate}입니다.
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
        label="계산 방식"
        value={method.value}
        description={method.description}
      />
      <StatisticsCoverageItem
        label="집계 기간"
        value={`${calculation.period.fromDate} ~ ${calculation.period.toDate}`}
        description={`${calculation.period.dayCount.toLocaleString(
          "ko-KR"
        )}일`}
      />
      <StatisticsCoverageItem
        label="비교 기간"
        value={`${calculation.comparisonPeriod.fromDate} ~ ${calculation.comparisonPeriod.toDate}`}
        description={`${calculation.comparisonPeriod.dayCount.toLocaleString(
          "ko-KR"
        )}일 · 동일 길이`}
      />
      <StatisticsCoverageItem
        label="데이터 마감"
        value={calculation.dataCutoffDate}
        description={
          delayedDelivery
            ? "현재 기본 기준보다 이전"
            : "한국 시간 기준 어제까지"
        }
      />
    </>
  );
}
