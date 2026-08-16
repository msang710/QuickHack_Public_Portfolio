"use client";

import * as React from "react";
import {
  AlertTriangle,
  BadgeDollarSign,
  CalendarClock,
  PackageCheck,
  Percent,
  RefreshCw,
} from "lucide-react";
import {
  BarList,
  CompactTable,
  EmptyDataState,
  formatNumber,
  MultiLineTrendChart,
  StatisticsCoverageItem,
  SummaryTile,
} from "@/quickhack_client/components/statistics/statistics-visuals";
import { StatisticsCalculationScope } from "@/quickhack_client/components/statistics/statistics-calculation-scope";
import {
  formatReturnAmount,
  formatReturnDelta,
  formatReturnDuration,
  formatReturnRate,
  formatReturnStatisticsDate,
  formatReturnStatisticsMonth,
  type ReturnMetricPresentation,
} from "@/quickhack_client/components/statistics/return-statistics-presentation";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { FormSection as Section } from "@/quickhack_client/components/ui/form-layout";
import type {
  ReturnStatisticsApiResponse,
  ReturnStatisticsData,
  StatisticsGroup,
} from "@/quickhack_shared/statistics/statistics";
import {
  buildStatisticsPeriodRequestQuery,
  type StatisticsPeriodSelection,
} from "@/quickhack_shared/statistics/statistics-period";

function PresentationValue({
  metric,
}: {
  metric: ReturnMetricPresentation;
}) {
  return (
    <div>
      <div className="font-semibold tabular-nums">{metric.value}</div>
      <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">
        {metric.detail}
      </div>
    </div>
  );
}

function formatGroupSummary(groups: StatisticsGroup[]) {
  if (groups.length === 0) {
    return "-";
  }

  return groups
    .slice(0, 3)
    .map((group) => `${group.label} ${formatNumber(group.count)}`)
    .join(" · ");
}

function SourceCoverage({ data }: { data: ReturnStatisticsData }) {
  const warnings = [
    data.source.unlinkedReceiptCount > 0
      ? `판매 이력이 연결되지 않은 반품 접수 ${formatNumber(
          data.source.unlinkedReceiptCount
        )}건`
      : null,
    data.source.ambiguousReceiptCount > 0
      ? `연결 후보가 중복된 반품 접수 ${formatNumber(
          data.source.ambiguousReceiptCount
        )}건`
      : null,
    data.source.missingOrInvalidExternalTimestampCount > 0
      ? `외부 접수 시각이 없거나 잘못된 건 ${formatNumber(
          data.source.missingOrInvalidExternalTimestampCount
        )}건`
      : null,
    data.source.claimBeforeSaleCount > 0
      ? `판매일보다 먼저 기록된 반품 연결 ${formatNumber(
          data.source.claimBeforeSaleCount
        )}건`
      : null,
    data.source.claimAfterThirtyDaysCount > 0
      ? `판매 후 30일을 초과한 반품 연결 ${formatNumber(
          data.source.claimAfterThirtyDaysCount
        )}건`
      : null,
    data.source.negativeDurationCount > 0
      ? `시간 순서 이상으로 소요 시간에서 제외한 건 ${formatNumber(
          data.source.negativeDurationCount
        )}건`
      : null,
    data.source.unmatchedWithdrawalCount > 0
      ? `판매 이력과 연결되지 않은 철회 기록 ${formatNumber(
          data.source.unmatchedWithdrawalCount
        )}건`
      : null,
  ].filter((value): value is string => Boolean(value));
  const linkRate = formatReturnRate(data.overview.receiptLinkRate);

  return (
    <Section
      title="데이터 기준과 신뢰도"
      description="반품 통계를 해석하기 전에 수집 기간과 연결·가격·검수 범위를 확인하세요."
    >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <StatisticsCalculationScope calculation={data.calculation} />
        <StatisticsCoverageItem
          label="이벤트 기록 시작"
          value={formatReturnStatisticsDate(
            data.source.eventRecordingStartedAt
          )}
          description={`조회 이벤트 ${formatNumber(
            data.source.claimEventCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="마지막 반품 관찰"
          value={formatReturnStatisticsDate(data.source.lastClaimEventAt)}
          description={`반품 ${formatNumber(
            data.source.observedReturnReceiptCount
          )} · 취소 ${formatNumber(
            data.source.observedCancellationReceiptCount
          )} · 교환 ${formatNumber(data.source.observedExchangeCount)}`}
        />
        <StatisticsCoverageItem
          label="반품 접수 연결률"
          value={linkRate.value}
          description={`${linkRate.detail} · 확정 ${formatNumber(
            data.source.confirmedAllocationLinkCount
          )} · 고유 키 ${formatNumber(
            data.source.uniqueExternalKeyLinkCount
          )}`}
        />
        <StatisticsCoverageItem
          label="연결된 판매 이력"
          value={`${formatNumber(
            data.source.linkedSaleRecordCount
          )}건`}
          description={`판매 cohort ${formatNumber(
            data.source.cohortSalesCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="판매가 확인 범위"
          value={`${data.source.salesPriceCoveragePercent}%`}
          description={`${formatNumber(
            data.source.salesPriceAvailableCount
          )} / ${formatNumber(data.source.cohortSalesCount)}건`}
        />
        <StatisticsCoverageItem
          label="매입 원가 확인 범위"
          value={`${data.source.purchasePriceCoveragePercent}%`}
          description={`${formatNumber(
            data.source.purchasePriceAvailableCount
          )} / ${formatNumber(data.source.cohortSalesCount)}건`}
        />
        <StatisticsCoverageItem
          label="확정 검수 연결"
          value={`${formatNumber(
            data.source.confirmedInspectionPgCount
          )}대`}
          description={`반품 연결 PG ${formatNumber(
            data.inspectionOutcome.linkedReturnPgCount
          )}대`}
        />
        <StatisticsCoverageItem
          label="생성 시각"
          value={formatReturnStatisticsDate(data.generatedAt)}
          description="선택 기간 전체"
        />
      </div>

      {warnings.length > 0 ? (
        <FeedbackBanner tone="warning" size="xs">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="font-semibold">
                통계에서 확인이 필요한 데이터가 있습니다.
              </div>
              <div className="mt-1">{warnings.join(" · ")}</div>
            </div>
          </div>
        </FeedbackBanner>
      ) : (
        <FeedbackBanner tone="success" size="xs">
          조회 범위에서 별도로 확인할 연결·시간 이상이 없습니다.
        </FeedbackBanner>
      )}
    </Section>
  );
}

function CoreSummary({ data }: { data: ReturnStatisticsData }) {
  const requestRate = formatReturnRate(data.summary.requestRate30Day, {
    maturityPending: true,
  });
  const previousRate = formatReturnRate(
    data.summary.previousRequestRate30Day,
    { maturityPending: true }
  );
  const delta = formatReturnDelta(
    data.summary.previousCohortDeltaPercentagePoints
  );
  const salesAmount = formatReturnAmount(
    data.summary.associatedSalesAmount
  );
  const vendorFault = formatReturnRate(data.summary.vendorFaultShare);
  const recovery = formatReturnRate(data.summary.resaleRecoveryRate);

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <SummaryTile
        icon={Percent}
        label="30일 고객 반품 요청률"
        value={requestRate.value}
        description={requestRate.detail}
        tone="primary"
      />
      <SummaryTile
        icon={CalendarClock}
        label="직전 cohort 대비"
        value={delta.value}
        description={`${delta.detail} · 직전 ${previousRate.value}`}
        tone="sky"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label="반품 연관 판매액"
        value={salesAmount.value}
        description={salesAmount.detail}
        tone="warning"
      />
      <SummaryTile
        icon={AlertTriangle}
        label="판매자 귀책 비중"
        value={vendorFault.value}
        description={vendorFault.detail}
        tone="purple"
      />
      <SummaryTile
        icon={PackageCheck}
        label="재판매 가능 회복률"
        value={recovery.value}
        description={recovery.detail}
        tone="success"
      />
    </div>
  );
}

function CustomerReturnOverview({ data }: { data: ReturnStatisticsData }) {
  const overview = data.overview;
  const linkRate = formatReturnRate(overview.receiptLinkRate);
  const withdrawalShare = formatReturnRate(overview.withdrawalShare);

  const rows = data.occurrenceTrend.map((row) => [
    formatReturnStatisticsMonth(row.receiptMonth),
    formatNumber(row.receiptCount),
    formatNumber(row.returnQuantity),
    formatNumber(row.linkedSaleRecordCount),
    formatNumber(row.completedReceiptCount),
    formatNumber(row.withdrawnReceiptCount),
    <PresentationValue
      key={`${row.receiptMonth}-amount`}
      metric={formatReturnAmount(row.associatedSalesAmount)}
    />,
  ]);

  return (
    <Section
      title="고객 반품 발생 개요"
      description="판매 후 고객 반품 접수의 규모와 월별 발생 흐름입니다."
    >
      <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
        <StatisticsCoverageItem
          label="반품 접수"
          value={`${formatNumber(overview.receiptCount)}건`}
          description={`수량 ${formatNumber(overview.returnQuantity)}개`}
        />
        <StatisticsCoverageItem
          label="연결된 접수"
          value={`${formatNumber(overview.linkedReceiptCount)}건`}
          description={linkRate.value}
        />
        <StatisticsCoverageItem
          label="연결된 판매 이력"
          value={`${formatNumber(overview.linkedSaleRecordCount)}건`}
        />
        <StatisticsCoverageItem
          label="반품 완료"
          value={`${formatNumber(overview.completedReceiptCount)}건`}
        />
        <StatisticsCoverageItem
          label="철회"
          value={`${formatNumber(overview.withdrawnReceiptCount)}건`}
          description={withdrawalShare.value}
        />
        <StatisticsCoverageItem
          label="접수 연결률"
          value={linkRate.value}
          description={linkRate.detail}
        />
      </div>
      <CompactTable
        columns={[
          "접수 월",
          { label: "접수", align: "right" },
          { label: "수량", align: "right" },
          { label: "연결 판매", align: "right" },
          { label: "완료", align: "right" },
          { label: "철회", align: "right" },
          { label: "연관 판매액", align: "right", wrap: true },
        ]}
        rows={rows}
        gridTemplateColumns="150px repeat(5, 90px) minmax(190px, 1fr)"
        minWidth={880}
      />
    </Section>
  );
}

function CohortTrend({ data }: { data: ReturnStatisticsData }) {
  const series = [
    {
      key: "day7",
      label: "7일",
      points: data.cohortTrend.map((row) => ({
        label: formatReturnStatisticsMonth(row.saleMonth),
        value: row.day7.value,
      })),
    },
    {
      key: "day14",
      label: "14일",
      points: data.cohortTrend.map((row) => ({
        label: formatReturnStatisticsMonth(row.saleMonth),
        value: row.day14.value,
      })),
    },
    {
      key: "day30",
      label: "30일",
      points: data.cohortTrend.map((row) => ({
        label: formatReturnStatisticsMonth(row.saleMonth),
        value: row.day30.value,
      })),
    },
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(440px,0.75fr)]">
      <MultiLineTrendChart
        title="판매 cohort 고객 반품 요청률"
        series={series}
      />
      <Section
        title="cohort 표본"
        description="각 기간별 분자와 성숙한 판매 이력 분모를 함께 표시합니다."
      >
        <CompactTable
          columns={[
            "판매 월",
            { label: "판매", align: "right" },
            { label: "7일", align: "right", wrap: true },
            { label: "14일", align: "right", wrap: true },
            { label: "30일", align: "right", wrap: true },
          ]}
          rows={data.cohortTrend.map((row) => [
            formatReturnStatisticsMonth(row.saleMonth),
            formatNumber(row.saleCount),
            <PresentationValue
              key={`${row.saleMonth}-7`}
              metric={formatReturnRate(row.day7, {
                maturityPending: true,
              })}
            />,
            <PresentationValue
              key={`${row.saleMonth}-14`}
              metric={formatReturnRate(row.day14, {
                maturityPending: true,
              })}
            />,
            <PresentationValue
              key={`${row.saleMonth}-30`}
              metric={formatReturnRate(row.day30, {
                maturityPending: true,
              })}
            />,
          ])}
          gridTemplateColumns="150px 80px repeat(3, minmax(150px, 1fr))"
          minWidth={760}
        />
      </Section>
    </div>
  );
}

function ProductComparison({ data }: { data: ReturnStatisticsData }) {
  return (
    <Section
      title="상품별 반품 비교"
      description="현재 성숙 cohort의 상품 조합별 반품 요청률과 금액·귀책·회복 지표를 비교합니다."
    >
      <CompactTable
        columns={[
          { label: "모델", wrap: true },
          "용량",
          "등급",
          { label: "성숙 판매", align: "right" },
          { label: "반품 판매", align: "right" },
          { label: "30일 요청률", align: "right", wrap: true },
          { label: "직전 대비", align: "right", wrap: true },
          { label: "연관 판매액", align: "right", wrap: true },
          { label: "판매자 귀책", align: "right", wrap: true },
          { label: "재판매 회복", align: "right", wrap: true },
        ]}
        rows={data.productRows.map((row) => [
          row.model,
          row.storage,
          row.saleGrade,
          formatNumber(row.matureSalesCount),
          formatNumber(row.returnSaleRecordCount),
          <PresentationValue
            key={`${row.key}-rate`}
            metric={formatReturnRate(row.requestRate30Day, {
              maturityPending: true,
            })}
          />,
          <PresentationValue
            key={`${row.key}-delta`}
            metric={formatReturnDelta(
              row.previousCohortDeltaPercentagePoints
            )}
          />,
          <PresentationValue
            key={`${row.key}-amount`}
            metric={formatReturnAmount(row.associatedSalesAmount)}
          />,
          <PresentationValue
            key={`${row.key}-fault`}
            metric={formatReturnRate(row.vendorFaultShare)}
          />,
          <PresentationValue
            key={`${row.key}-recovery`}
            metric={formatReturnRate(row.resaleRecoveryRate)}
          />,
        ])}
        gridTemplateColumns="minmax(180px,1.3fr) 90px 70px 90px 90px repeat(5, minmax(160px, 1fr))"
        minWidth={1420}
        wrapCells
      />
    </Section>
  );
}

function ReasonsAndInspection({ data }: { data: ReturnStatisticsData }) {
  const returnTotal = data.overview.receiptCount;

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="반품 사유">
          <BarList groups={data.reasons} total={returnTotal} />
        </Section>
        <Section title="귀책 구분">
          <BarList groups={data.faults} total={returnTotal} />
        </Section>
      </div>
      <Section
        title="사유별 검수 결과"
        description="반품 사유와 실제 검수 결과를 연결할 수 있는 범위만 표시합니다."
      >
        <CompactTable
          columns={[
            { label: "반품 사유", wrap: true },
            { label: "접수", align: "right" },
            { label: "검수 PG", align: "right" },
            { label: "재판매 가능", align: "right" },
            { label: "판매 불가", align: "right" },
            { label: "보류", align: "right" },
            { label: "외관 결함", wrap: true },
            { label: "기능 결함", wrap: true },
          ]}
          rows={data.reasonInspectionMatrix.map((row) => [
            row.reason,
            formatNumber(row.receiptCount),
            formatNumber(row.confirmedInspectionPgCount),
            formatNumber(row.recoveredCount),
            formatNumber(row.nonSellableCount),
            formatNumber(row.holdCount),
            formatGroupSummary(row.appearanceDefects),
            formatGroupSummary(row.functionDefects),
          ])}
          gridTemplateColumns="minmax(220px,1.4fr) repeat(5, 90px) minmax(220px,1fr) minmax(220px,1fr)"
          minWidth={1180}
          wrapCells
        />
      </Section>
    </div>
  );
}

function InspectionAndEconomics({ data }: { data: ReturnStatisticsData }) {
  const outcome = data.inspectionOutcome;
  const recovery = formatReturnRate(outcome.recoveryRate);
  const amounts = [
    ["반품 연관 판매액", data.economicImpact.associatedSalesAmount],
    ["연결 판매의 매입 원가", data.economicImpact.associatedPurchaseCost],
    ["재판매 가능 자산 원가", data.economicImpact.recoveredAssetCost],
    [
      "판매 불가·보류 자산 원가",
      data.economicImpact.nonSellableOrHoldAssetCost,
    ],
  ] as const;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section
        title="반품 검수 결과"
        description="확정 검수와 연결된 PG만 재판매 가능 여부에 포함합니다."
      >
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          <StatisticsCoverageItem
            label="연결 반품 PG"
            value={`${formatNumber(outcome.linkedReturnPgCount)}대`}
          />
          <StatisticsCoverageItem
            label="확정 검수"
            value={`${formatNumber(outcome.confirmedInspectionPgCount)}대`}
          />
          <StatisticsCoverageItem
            label="재판매 가능"
            value={`${formatNumber(outcome.recoveredCount)}대`}
            description={recovery.value}
          />
          <StatisticsCoverageItem
            label="판매 불가"
            value={`${formatNumber(outcome.nonSellableCount)}대`}
          />
          <StatisticsCoverageItem
            label="보류"
            value={`${formatNumber(outcome.holdCount)}대`}
          />
          <StatisticsCoverageItem
            label="재판매 가능 회복률"
            value={recovery.value}
            description={recovery.detail}
          />
        </div>
      </Section>
      <Section
        title="반품 연관 금액"
        description="가격이 확인된 연결 판매 이력만 합산하며, 가격이 없으면 0원이 아니라 ‘-’로 표시합니다."
      >
        <div className="grid gap-2 md:grid-cols-2">
          {amounts.map(([label, amount]) => {
            const presentation = formatReturnAmount(amount);
            return (
              <StatisticsCoverageItem
                key={label}
                label={label}
                value={presentation.value}
                description={presentation.detail}
              />
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function LeadTimes({ data }: { data: ReturnStatisticsData }) {
  const items = [
    [
      "외부 접수 → 최초 관찰",
      data.leadTimes.externalReceiptToObservation,
    ],
    [
      "최초 관찰 → 승인 요청",
      data.leadTimes.observationToApprovalRequest,
    ],
    [
      "최초 관찰 → 내부 확정",
      data.leadTimes.observationToLocalFinalization,
    ],
  ] as const;

  return (
    <Section
      title="처리 소요 시간"
      description="중앙값을 대표값으로 표시하고 P90·표본·제외 이상치를 함께 제공합니다."
    >
      <div className="grid gap-2 md:grid-cols-3">
        {items.map(([label, duration]) => {
          const presentation = formatReturnDuration(duration);
          return (
            <StatisticsCoverageItem
              key={label}
              label={label}
              value={presentation.value}
              description={presentation.detail}
            />
          );
        })}
      </div>
    </Section>
  );
}

function CancellationStatistics({ data }: { data: ReturnStatisticsData }) {
  const cancellation = data.preShipmentCancellations;

  return (
    <Section
      title="출고 전 취소"
      description="판매 후 고객 반품과 섞지 않고 별도 모집단으로 표시합니다."
    >
      <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-2">
          <StatisticsCoverageItem
            label="취소 접수"
            value={`${formatNumber(cancellation.receiptCount)}건`}
          />
          <StatisticsCoverageItem
            label="취소 수량"
            value={`${formatNumber(cancellation.cancellationQuantity)}개`}
          />
        </div>
        <div className="grid gap-3">
          <div className="text-xs font-semibold">월별 발생</div>
          <CompactTable
            columns={[
              "접수 월",
              { label: "접수", align: "right" },
              { label: "수량", align: "right" },
            ]}
            rows={cancellation.occurrenceTrend.map((row) => [
              formatReturnStatisticsMonth(row.receiptMonth),
              formatNumber(row.receiptCount),
              formatNumber(row.cancellationQuantity),
            ])}
            gridTemplateColumns="1fr 80px 80px"
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
          <div>
            <div className="mb-2 text-xs font-semibold">취소 사유</div>
            <BarList
              groups={cancellation.reasons}
              total={cancellation.receiptCount}
            />
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold">취소 상품</div>
            <BarList
              groups={cancellation.products}
              total={cancellation.receiptCount}
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

function ExchangeStatistics({ data }: { data: ReturnStatisticsData }) {
  const exchange = data.exchanges;
  const duration = formatReturnDuration(exchange.terminalLeadTime);

  return (
    <Section
      title="교환"
      description="교환 접수·결과와 완료까지의 시간을 별도 모집단으로 표시합니다."
    >
      <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-2">
          <StatisticsCoverageItem
            label="교환 접수"
            value={`${formatNumber(exchange.receiptCount)}건`}
          />
          <StatisticsCoverageItem
            label="종결 소요 시간"
            value={duration.value}
            description={duration.detail}
          />
          <CompactTable
            columns={[
              "접수 월",
              { label: "접수", align: "right" },
            ]}
            rows={exchange.occurrenceTrend.map((row) => [
              formatReturnStatisticsMonth(row.label),
              formatNumber(row.value),
            ])}
            gridTemplateColumns="1fr 80px"
          />
        </div>
        <div className="grid gap-4">
          <div>
            <div className="mb-2 text-xs font-semibold">교환 사유</div>
            <BarList groups={exchange.reasons} total={exchange.receiptCount} />
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold">귀책 구분</div>
            <BarList groups={exchange.faults} total={exchange.receiptCount} />
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold">교환 결과</div>
          <BarList groups={exchange.results} total={exchange.receiptCount} />
        </div>
      </div>
    </Section>
  );
}

export function ReturnsStatisticsPanel({
  periodSelection,
}: {
  periodSelection: StatisticsPeriodSelection;
}) {
  const requestKey =
    buildStatisticsPeriodRequestQuery(periodSelection);
  const [requestState, setRequestState] = React.useState<{
    requestKey: string | null;
    data: ReturnStatisticsData | null;
    errorMessage: string;
    isLoading: boolean;
  }>({
    requestKey: null,
    data: null,
    errorMessage: "",
    isLoading: true,
  });
  const [retryRevision, setRetryRevision] = React.useState(0);
  const requestSequence = React.useRef(0);

  React.useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestSequence.current;

    const timerId = window.setTimeout(() => {
      setRequestState((current) => ({
        requestKey,
        data:
          current.requestKey === requestKey ? current.data : null,
        errorMessage: "",
        isLoading: true,
      }));

      fetch(
        `/api/statistics/returns${
          requestKey ? `?${requestKey}` : ""
        }`,
        {
          cache: "no-store",
          signal: controller.signal,
        }
      )
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as
            | ReturnStatisticsApiResponse
            | null;

          if (!response.ok || !payload?.ok || !payload.data) {
            throw new Error(
              payload?.message || "반품 통계를 불러오지 못했습니다."
            );
          }

          if (
            controller.signal.aborted ||
            requestId !== requestSequence.current
          ) {
            return;
          }

          setRequestState({
            requestKey,
            data: payload.data,
            errorMessage: "",
            isLoading: false,
          });
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            requestId !== requestSequence.current
          ) {
            return;
          }

          setRequestState((current) => ({
            requestKey,
            data:
              current.requestKey === requestKey
                ? current.data
                : null,
            errorMessage:
              error instanceof Error ? error.message : String(error),
            isLoading: false,
          }));
        });
    }, 0);

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [requestKey, retryRevision]);

  const visibleData =
    requestState.requestKey === requestKey ? requestState.data : null;
  const errorMessage =
    requestState.requestKey === requestKey
      ? requestState.errorMessage
      : "";
  const isLoading =
    requestState.requestKey !== requestKey || requestState.isLoading;

  if (!visibleData && isLoading) {
    return (
      <div aria-busy="true" className="grid gap-3">
        <FeedbackBanner tone="info" size="xs">
          반품 통계를 불러오는 중입니다.
        </FeedbackBanner>
        <EmptyDataState message="반품 데이터를 집계하고 있습니다." />
      </div>
    );
  }

  if (!visibleData && errorMessage) {
    return (
      <FeedbackBanner tone="danger">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">
              반품 통계를 불러오지 못했습니다.
            </div>
            <div className="mt-1 text-xs">{errorMessage}</div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRetryRevision((value) => value + 1)}
          >
            <RefreshCw />
            다시 시도
          </Button>
        </div>
      </FeedbackBanner>
    );
  }

  if (!visibleData) {
    return null;
  }

  return (
    <div aria-busy={isLoading} className="grid gap-4">
      {isLoading ? (
        <FeedbackBanner tone="info" size="xs">
          같은 조건으로 통계를 다시 확인하고 있습니다. 현재 결과는 계속
          표시합니다.
        </FeedbackBanner>
      ) : null}
      {errorMessage ? (
        <FeedbackBanner tone="danger" size="xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{errorMessage}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRetryRevision((value) => value + 1)}
            >
              <RefreshCw />
              다시 시도
            </Button>
          </div>
        </FeedbackBanner>
      ) : null}

      <SourceCoverage data={visibleData} />
      <CoreSummary data={visibleData} />
      <CustomerReturnOverview data={visibleData} />
      <CohortTrend data={visibleData} />
      <ProductComparison data={visibleData} />
      <ReasonsAndInspection data={visibleData} />
      <InspectionAndEconomics data={visibleData} />
      <LeadTimes data={visibleData} />
      <CancellationStatistics data={visibleData} />
      <ExchangeStatistics data={visibleData} />
    </div>
  );
}
