"use client";

import * as React from "react";
import {
  AlertTriangle,
  BadgeDollarSign,
  Building2,
  ClipboardCheck,
  PackageCheck,
  Percent,
  RefreshCw,
} from "lucide-react";
import {
  formatPurchaseAdjustmentAmount,
  formatPurchaseAdjustmentPercent,
  formatPurchaseAmount,
  formatPurchaseAveragePrice,
  formatPurchaseDuration,
  formatPurchaseRate,
  formatPurchaseStatisticsDate,
  formatPurchaseStatisticsMonth,
  purchasePricePolicyLabel,
  type PurchaseMetricPresentation,
} from "@/quickhack_client/components/statistics/purchase-statistics-presentation";
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
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { FormSection as Section } from "@/quickhack_client/components/ui/form-layout";
import type {
  PurchaseStatisticsApiResponse,
  PurchaseStatisticsData,
  StatisticsGroup,
} from "@/quickhack_shared/statistics/statistics";
import {
  buildStatisticsPeriodRequestQuery,
  type StatisticsPeriodSelection,
} from "@/quickhack_shared/statistics/statistics-period";

function PresentationValue({
  metric,
}: {
  metric: PurchaseMetricPresentation;
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

function groupTotal(groups: StatisticsGroup[]) {
  return groups.reduce((sum, group) => sum + group.count, 0);
}

function PurchaseSourceCoverage({
  data,
}: {
  data: PurchaseStatisticsData;
}) {
  const missingPolicyCount =
    data.source.purchaseCount - data.source.pricePolicyEvidenceCount;
  const warnings = [
    data.source.missingPurchasePriceCount > 0
      ? `매입가가 기록되지 않은 확정 매입 ${formatNumber(
          data.source.missingPurchasePriceCount
        )}건`
      : null,
    data.source.missingSupplierOutcomeCount > 0
      ? `매입처가 기록되지 않은 종결 회차 ${formatNumber(
          data.source.missingSupplierOutcomeCount
        )}건`
      : null,
    data.source.missingInspectionOutcomeCount > 0
      ? `입고 검수가 연결되지 않은 종결 회차 ${formatNumber(
          data.source.missingInspectionOutcomeCount
        )}건`
      : null,
    data.source.missingPurchaseGradeOutcomeCount > 0
      ? `매입 등급을 확인할 수 없는 종결 회차 ${formatNumber(
          data.source.missingPurchaseGradeOutcomeCount
        )}건`
      : null,
    missingPolicyCount > 0
      ? `가격 입력 방식을 확인할 수 없는 확정 매입 ${formatNumber(
          missingPolicyCount
        )}건`
      : null,
    data.source.missingPurchaseInboundSaleCount > 0
      ? `원매입 회차가 연결되지 않은 판매 ${formatNumber(
          data.source.missingPurchaseInboundSaleCount
        )}건`
      : null,
    data.source.missingSupplierSnapshotSaleCount > 0
      ? `판매 당시 원매입처가 기록되지 않은 판매 ${formatNumber(
          data.source.missingSupplierSnapshotSaleCount
        )}건`
      : null,
    data.source.invalidTimestampCount > 0
      ? `날짜를 해석할 수 없는 기록 ${formatNumber(
          data.source.invalidTimestampCount
        )}건`
      : null,
    data.source.negativeDurationCount > 0
      ? `시간 순서 이상으로 기간 계산에서 제외한 기록 ${formatNumber(
          data.source.negativeDurationCount
        )}건`
      : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <Section
      title="데이터 기준과 신뢰도"
      description="매입 통계를 해석하기 전에 가격·검수·판매 연결 범위를 확인하세요."
    >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <StatisticsCalculationScope calculation={data.calculation} />
        <StatisticsCoverageItem
          label="종결 입고 회차"
          value={`${formatNumber(data.source.terminalInboundCount)}건`}
          description={`확정 매입 ${formatNumber(
            data.source.purchaseCount
          )} · 매입처 반품 ${formatNumber(
            data.source.supplierReturnCount
          )}`}
        />
        <StatisticsCoverageItem
          label="매입가 확인 범위"
          value={`${data.summary.purchaseAmount.coveragePercent}%`}
          description={`${formatNumber(
            data.source.pricedPurchaseCount
          )} / ${formatNumber(data.source.purchaseCount)}건`}
        />
        <StatisticsCoverageItem
          label="매입처 확인 범위"
          value={`${formatNumber(
            data.source.namedSupplierOutcomeCount
          )}건`}
          description={`종결 회차 ${formatNumber(
            data.source.terminalInboundCount
          )}건 중`}
        />
        <StatisticsCoverageItem
          label="입고 검수 연결률"
          value={`${data.source.inspectionLinkCoveragePercent}%`}
          description={`${formatNumber(
            data.source.linkedInspectionOutcomeCount
          )} / ${formatNumber(data.source.terminalInboundCount)}건`}
        />
        <StatisticsCoverageItem
          label="매입 등급 확인"
          value={`${formatNumber(
            data.source.knownPurchaseGradeOutcomeCount
          )}건`}
          description={`미확인 ${formatNumber(
            data.source.missingPurchaseGradeOutcomeCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="가격 정책 증거"
          value={`${data.source.pricePolicyCoveragePercent}%`}
          description={`입력 방식 ${formatNumber(
            data.source.pricePolicyEvidenceCount
          )} · 기준가 ${formatNumber(
            data.source.priceReferenceEvidenceCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="판매 원매입 연결률"
          value={`${data.source.salesLinkCoveragePercent}%`}
          description={`원매입처 snapshot ${data.source.supplierSnapshotCoveragePercent}%`}
        />
        <StatisticsCoverageItem
          label="생성 시각"
          value={formatPurchaseStatisticsDate(data.generatedAt)}
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
          조회 범위에서 별도로 확인할 누락·시간 이상이 없습니다.
        </FeedbackBanner>
      )}
    </Section>
  );
}

function PurchaseCoreSummary({ data }: { data: PurchaseStatisticsData }) {
  const purchaseAmount = formatPurchaseAmount(data.summary.purchaseAmount);
  const supplierReturnRate = formatPurchaseRate(
    data.summary.supplierReturnRate
  );

  return (
    <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
      <SummaryTile
        icon={PackageCheck}
        label="확정 매입 회차"
        value={formatNumber(data.summary.purchaseCount)}
        description="매입 확정 기준"
        tone="success"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label="매입금액"
        value={purchaseAmount.value}
        description={purchaseAmount.detail}
        tone="warning"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label="평균 매입가"
        value={formatPurchaseAveragePrice(
          data.summary.averagePurchasePrice
        )}
        description={`가격 확인 ${formatNumber(
          data.summary.purchaseAmount.pricedCount
        )}건`}
        tone="sky"
      />
      <SummaryTile
        icon={Building2}
        label="매입처"
        value={formatNumber(data.summary.supplierCount)}
        description="종결 회차의 고유 매입처"
        tone="purple"
      />
      <SummaryTile
        icon={Percent}
        label="매입처 반품률"
        value={supplierReturnRate.value}
        description={supplierReturnRate.detail}
        tone="primary"
      />
    </div>
  );
}

function PurchaseMonthlyTrend({ data }: { data: PurchaseStatisticsData }) {
  const rows = data.monthlyTrend.map((row) => [
    formatPurchaseStatisticsMonth(row.month),
    `${formatNumber(row.purchaseCount)}건`,
    formatPurchaseAveragePrice(row.purchaseAmount),
    `${formatNumber(row.pricedPurchaseCount)}건`,
    `${formatNumber(row.missingPurchasePriceCount)}건`,
    `${formatNumber(row.supplierReturnCount)}건`,
    `${formatNumber(row.inspectionDefectOutcomeCount)}건`,
  ]);

  return (
    <div className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(520px,0.85fr)]">
      <MultiLineTrendChart
        title="월별 매입 결과 추이"
        description="확정 매입은 매입 확정일, 매입처 반품은 최초 반품 전환일 기준입니다."
        valueFormatter={(value) => `${formatNumber(value)}건`}
        series={[
          {
            key: "purchase",
            label: "확정 매입",
            points: data.monthlyTrend.map((row) => ({
              label: formatPurchaseStatisticsMonth(row.month),
              value: row.purchaseCount,
            })),
          },
          {
            key: "supplier-return",
            label: "매입처 반품",
            points: data.monthlyTrend.map((row) => ({
              label: formatPurchaseStatisticsMonth(row.month),
              value: row.supplierReturnCount,
            })),
          },
          {
            key: "inspection-defect",
            label: "검수 불량 결과",
            points: data.monthlyTrend.map((row) => ({
              label: formatPurchaseStatisticsMonth(row.month),
              value: row.inspectionDefectOutcomeCount,
            })),
          },
        ]}
      />
      <Section
        title="월별 매입 금액"
        description="가격 미입력 건을 0원으로 포함하지 않습니다."
      >
        <CompactTable
          columns={[
            "월",
            { label: "매입", align: "right" },
            { label: "매입액", align: "right" },
            { label: "가격 확인", align: "right" },
            { label: "가격 미입력", align: "right" },
            { label: "매입처 반품", align: "right" },
            { label: "검수 불량", align: "right" },
          ]}
          rows={rows}
          minWidth={760}
          gridTemplateColumns="1.25fr repeat(6, minmax(88px, 0.85fr))"
        />
      </Section>
    </div>
  );
}

function PurchaseProductPerformance({
  data,
}: {
  data: PurchaseStatisticsData;
}) {
  const rows = data.productRows.map((row) => [
    row.model,
    row.storage,
    row.purchaseGrade,
    `${formatNumber(row.purchaseCount)}건`,
    <PresentationValue
      key={`${row.key}-amount`}
      metric={formatPurchaseAmount(row.purchaseAmount)}
    />,
    formatPurchaseAveragePrice(row.averagePurchasePrice),
    <PresentationValue
      key={`${row.key}-supplier-return`}
      metric={formatPurchaseRate(row.supplierReturnRate)}
    />,
    <PresentationValue
      key={`${row.key}-defect`}
      metric={formatPurchaseRate(row.inspectionDefectRate)}
    />,
    <PresentationValue
      key={`${row.key}-30`}
      metric={formatPurchaseRate(row.saleConversion30Day, {
        maturityPending: true,
      })}
    />,
    <PresentationValue
      key={`${row.key}-60`}
      metric={formatPurchaseRate(row.saleConversion60Day, {
        maturityPending: true,
      })}
    />,
    <PresentationValue
      key={`${row.key}-90`}
      metric={formatPurchaseRate(row.saleConversion90Day, {
        maturityPending: true,
      })}
    />,
  ]);

  return (
    <Section
      title="상품별 매입 cohort 성과"
      description="기종·용량·매입등급별 확정 매입과 성숙 cohort의 판매 전환을 비교합니다."
    >
      <CompactTable
        columns={[
          "기종",
          "용량",
          "매입등급",
          { label: "확정 매입", align: "right" },
          { label: "매입액", align: "right" },
          { label: "평균가", align: "right" },
          { label: "매입처 반품률", align: "right", wrap: true },
          { label: "검수 불량률", align: "right", wrap: true },
          { label: "30일 판매전환", align: "right", wrap: true },
          { label: "60일 판매전환", align: "right", wrap: true },
          { label: "90일 판매전환", align: "right", wrap: true },
        ]}
        rows={rows}
        minWidth={1480}
        maxHeight={560}
        gridTemplateColumns="1.55fr 0.75fr 0.75fr 0.8fr 1.1fr 1fr repeat(5, minmax(125px, 1fr))"
        wrapCells
      />
    </Section>
  );
}

function PurchaseSupplierPerformance({
  data,
}: {
  data: PurchaseStatisticsData;
}) {
  const rows = data.supplierRows.map((row) => [
    row.supplierName,
    `${formatNumber(row.terminalOutcomeCount)}건`,
    `${formatNumber(row.purchaseCount)}건`,
    <PresentationValue
      key={`${row.supplierName}-amount`}
      metric={formatPurchaseAmount(row.purchaseAmount)}
    />,
    formatPurchaseAveragePrice(row.averagePurchasePrice),
    <PresentationValue
      key={`${row.supplierName}-supplier-return`}
      metric={formatPurchaseRate(row.supplierReturnRate)}
    />,
    <PresentationValue
      key={`${row.supplierName}-defect`}
      metric={formatPurchaseRate(row.inspectionDefectRate)}
    />,
    <PresentationValue
      key={`${row.supplierName}-customer-return`}
      metric={formatPurchaseRate(
        row.customerReturnConfirmationRate
      )}
    />,
  ]);

  return (
    <Section
      title="매입처 성과"
      description="매입처 반품과 판매 후 고객 반품 확정을 서로 다른 결과로 비교합니다."
    >
      <CompactTable
        columns={[
          "매입처",
          { label: "종결 회차", align: "right" },
          { label: "확정 매입", align: "right" },
          { label: "매입액", align: "right" },
          { label: "평균가", align: "right" },
          { label: "매입처 반품률", align: "right", wrap: true },
          { label: "검수 불량률", align: "right", wrap: true },
          { label: "고객 반품 확정률", align: "right", wrap: true },
        ]}
        rows={rows}
        minWidth={1180}
        gridTemplateColumns="1.4fr 0.8fr 0.8fr 1.15fr 1fr repeat(3, minmax(135px, 1fr))"
        wrapCells
      />
    </Section>
  );
}

function PurchasePricePolicyPerformance({
  data,
}: {
  data: PurchaseStatisticsData;
}) {
  const rows = data.pricePolicyRows.map((row) => [
    purchasePricePolicyLabel(row.entryMode),
    `${formatNumber(row.purchaseCount)}건`,
    <PresentationValue
      key={`${row.entryMode}-amount`}
      metric={formatPurchaseAmount(row.purchaseAmount)}
    />,
    formatPurchaseAveragePrice(row.averagePurchasePrice),
    `${formatNumber(row.referenceAvailableCount)}건 / ${
      row.referenceCoveragePercent
    }%`,
    <div key={`${row.entryMode}-adjustment`}>
      <div className="font-semibold tabular-nums">
        {formatPurchaseAdjustmentAmount(row.averageAdjustmentAmount)}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {formatPurchaseAdjustmentPercent(row.averageAdjustmentPercent)}
      </div>
    </div>,
    `${formatNumber(row.increasedCount)} / ${formatNumber(
      row.unchangedCount
    )} / ${formatNumber(row.decreasedCount)}`,
  ]);

  return (
    <Section
      title="가격 정책 결과"
      description="매입 확정 당시 저장한 기준가와 실제 확정가의 관계를 비교합니다."
    >
      <CompactTable
        columns={[
          "입력 방식",
          { label: "매입", align: "right" },
          { label: "매입액", align: "right" },
          { label: "평균가", align: "right" },
          { label: "기준가 확인", align: "right", wrap: true },
          { label: "평균 조정", align: "right", wrap: true },
          { label: "상승 / 동일 / 하락", align: "right", wrap: true },
        ]}
        rows={rows}
        minWidth={980}
        gridTemplateColumns="1.1fr 0.65fr 1.25fr 1fr 1fr 1fr 1.2fr"
        wrapCells
      />
    </Section>
  );
}

function PurchaseInspectionQuality({
  data,
}: {
  data: PurchaseStatisticsData;
}) {
  const defectRate = formatPurchaseRate(
    data.inspectionQuality.defectRate
  );
  const appearanceTotal = groupTotal(
    data.inspectionQuality.appearanceDefects
  );
  const functionTotal = groupTotal(
    data.inspectionQuality.functionDefects
  );

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Section
        title="입고 검수 품질"
        description="정확한 입고 회차에 연결된 검수만 집계합니다."
      >
        <div className="grid gap-3">
          <SummaryTile
            icon={ClipboardCheck}
            label="검수 불량률"
            value={defectRate.value}
            description={defectRate.detail}
            tone="warning"
          />
          <StatisticsCoverageItem
            label="검수 연결 표본"
            value={`${formatNumber(
              data.inspectionQuality.inspectedOutcomeCount
            )}건`}
            description={`실제 하자 ${formatNumber(
              data.inspectionQuality.defectOutcomeCount
            )}건`}
          />
        </div>
      </Section>
      <Section
        title="외관 하자 항목"
        description="한 회차에 여러 하자 항목이 기록될 수 있습니다."
      >
        <BarList
          groups={data.inspectionQuality.appearanceDefects}
          total={appearanceTotal}
        />
      </Section>
      <Section
        title="기능 하자 항목"
        description="항목 비중은 검수 기기 비중과 다를 수 있습니다."
      >
        <BarList
          groups={data.inspectionQuality.functionDefects}
          total={functionTotal}
        />
      </Section>
    </div>
  );
}

function PurchaseLeadTimes({ data }: { data: PurchaseStatisticsData }) {
  const receivedToInspection = formatPurchaseDuration(
    data.leadTimes.receivedToLastInspection
  );
  const inspectionToOutcome = formatPurchaseDuration(
    data.leadTimes.lastInspectionToTerminalOutcome
  );
  const receivedToOutcome = formatPurchaseDuration(
    data.leadTimes.receivedToTerminalOutcome
  );

  return (
    <Section
      title="매입 처리시간"
      description="중앙값을 주 값으로, P90과 제외 이상치를 함께 표시합니다."
    >
      <div className="grid gap-2 md:grid-cols-3">
        <StatisticsCoverageItem
          label="입고 → 마지막 검수"
          value={receivedToInspection.value}
          description={receivedToInspection.detail}
        />
        <StatisticsCoverageItem
          label="마지막 검수 → 종결"
          value={inspectionToOutcome.value}
          description={inspectionToOutcome.detail}
        />
        <StatisticsCoverageItem
          label="입고 → 종결"
          value={receivedToOutcome.value}
          description={receivedToOutcome.detail}
        />
      </div>
    </Section>
  );
}

export function PurchaseStatisticsPanel({
  periodSelection,
}: {
  periodSelection: StatisticsPeriodSelection;
}) {
  const requestKey =
    buildStatisticsPeriodRequestQuery(periodSelection);
  const [requestState, setRequestState] = React.useState<{
    requestKey: string | null;
    data: PurchaseStatisticsData | null;
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
        `/api/statistics/purchases${
          requestKey ? `?${requestKey}` : ""
        }`,
        {
          cache: "no-store",
          signal: controller.signal,
        }
      )
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as
            | PurchaseStatisticsApiResponse
            | null;

          if (!response.ok || !payload?.ok || !payload.data) {
            throw new Error(
              payload?.message || "매입 통계를 불러오지 못했습니다."
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
          매입 통계를 불러오는 중입니다.
        </FeedbackBanner>
        <EmptyDataState message="매입 데이터를 집계하고 있습니다." />
      </div>
    );
  }

  if (!visibleData && errorMessage) {
    return (
      <FeedbackBanner tone="danger">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">
              매입 통계를 불러오지 못했습니다.
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
    <div aria-busy={isLoading} className="grid min-w-0 gap-4">
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

      <PurchaseSourceCoverage data={visibleData} />
      <PurchaseCoreSummary data={visibleData} />
      <PurchaseMonthlyTrend data={visibleData} />
      <PurchaseProductPerformance data={visibleData} />
      <PurchaseSupplierPerformance data={visibleData} />
      <PurchasePricePolicyPerformance data={visibleData} />
      <PurchaseInspectionQuality data={visibleData} />
      <PurchaseLeadTimes data={visibleData} />
    </div>
  );
}
