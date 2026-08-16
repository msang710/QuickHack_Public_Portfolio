"use client";

import * as React from "react";
import {
  AlertTriangle,
  BadgeDollarSign,
  CircleDollarSign,
  Percent,
  RefreshCw,
  Store,
  TimerReset,
} from "lucide-react";
import {
  formatSalesAmount,
  formatSalesAveragePrice,
  formatSalesGrossProfit,
  formatSalesLeadTime,
  formatSalesRate,
  formatSalesStatisticsDate,
  formatSalesStatisticsMonth,
  type SalesMetricPresentation,
} from "@/quickhack_client/components/statistics/sales-statistics-presentation";
import {
  BarList,
  CompactTable,
  EmptyDataState,
  formatNumber,
  LineTrendChart,
  StatisticsCoverageItem,
  SummaryTile,
} from "@/quickhack_client/components/statistics/statistics-visuals";
import { StatisticsCalculationScope } from "@/quickhack_client/components/statistics/statistics-calculation-scope";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { FormSection as Section } from "@/quickhack_client/components/ui/form-layout";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import type {
  SalesDimensionKey,
  SalesStatisticsApiResponse,
  SalesStatisticsData,
  StatisticsGroup,
} from "@/quickhack_shared/statistics/statistics";
import {
  buildStatisticsPeriodRequestQuery,
  type StatisticsPeriodSelection,
} from "@/quickhack_shared/statistics/statistics-period";

const dimensionLabels: Record<SalesDimensionKey, string> = {
  MODEL: "기종",
  STORAGE: "용량",
  COLOR: "색상",
  SALE_GRADE: "판매 등급",
  WARRANTY_GROUP: "보증 그룹",
  CHANNEL: "판매 채널",
};

function PresentationValue({
  metric,
}: {
  metric: SalesMetricPresentation;
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

function SalesSourceCoverage({ data }: { data: SalesStatisticsData }) {
  const warnings = [
    data.source.excludedStatusCount > 0
      ? `판매 종결 상태가 아닌 원장 ${formatNumber(
          data.source.excludedStatusCount
        )}건 제외`
      : null,
    data.source.invalidSoldAtCount > 0
      ? `판매 시각을 해석할 수 없는 원장 ${formatNumber(
          data.source.invalidSoldAtCount
        )}건 제외`
      : null,
    data.source.futureSoldAtCount > 0
      ? `미래 판매 시각 원장 ${formatNumber(
          data.source.futureSoldAtCount
        )}건 제외`
      : null,
    data.source.eligibleSaleRecordCount -
        data.source.pricedSaleCount >
      0
      ? `판매가 미기록 ${formatNumber(
          data.source.eligibleSaleRecordCount -
            data.source.pricedSaleCount
        )}건`
      : null,
    data.source.eligibleSaleRecordCount -
        data.source.purchasePricedSaleCount >
      0
      ? `매입가 미기록 ${formatNumber(
          data.source.eligibleSaleRecordCount -
            data.source.purchasePricedSaleCount
        )}건`
      : null,
    data.source.missingPurchaseAgreedAtCount > 0
      ? `매입 확정 시각 미기록 ${formatNumber(
          data.source.missingPurchaseAgreedAtCount
        )}건`
      : null,
    data.source.invalidLeadTimeCount > 0
      ? `판매 소요기간 이상 ${formatNumber(
          data.source.invalidLeadTimeCount
        )}건 제외`
      : null,
  ].filter((warning): warning is string => warning !== null);

  return (
    <Section
      title="집계 원천과 신뢰도"
      description="판매 통계를 해석하기 전에 원장 상태와 가격·원가·소요기간의 확인 범위를 확인하세요."
    >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <StatisticsCalculationScope calculation={data.calculation} />
        <StatisticsCoverageItem
          label="조회 원장"
          value={`${formatNumber(
            data.source.eligibleSaleRecordCount
          )}건`}
          description={`전체 원장 ${formatNumber(
            data.source.loadedSaleRecordCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="판매 상태"
          value={`판매 유지 ${formatNumber(
            data.source.soldSaleRecordCount
          )}건`}
          description={`반품 후 원판매 ${formatNumber(
            data.source.returnedSaleRecordCount
          )}건 포함`}
        />
        <StatisticsCoverageItem
          label="판매가 확인 범위"
          value={`${data.source.salesPriceCoveragePercent}%`}
          description={`${formatNumber(
            data.source.pricedSaleCount
          )} / ${formatNumber(
            data.source.eligibleSaleRecordCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="매입가 확인 범위"
          value={`${data.source.purchasePriceCoveragePercent}%`}
          description={`${formatNumber(
            data.source.purchasePricedSaleCount
          )} / ${formatNumber(
            data.source.eligibleSaleRecordCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="매출총이익 비교 범위"
          value={`${data.source.profitCoveragePercent}%`}
          description={`${formatNumber(
            data.source.comparableProfitCount
          )} / ${formatNumber(
            data.source.eligibleSaleRecordCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="판매 소요기간 표본"
          value={`${formatNumber(
            data.source.leadTimeSampleCount
          )}건`}
          description={`미기록 ${formatNumber(
            data.source.missingPurchaseAgreedAtCount
          )} · 이상 ${formatNumber(
            data.source.invalidLeadTimeCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="판매 시각 제외"
          value={`${formatNumber(
            data.source.invalidSoldAtCount +
              data.source.futureSoldAtCount
          )}건`}
          description={`형식 오류 ${formatNumber(
            data.source.invalidSoldAtCount
          )} · 미래 ${formatNumber(
            data.source.futureSoldAtCount
          )}건`}
        />
        <StatisticsCoverageItem
          label="생성 시각"
          value={formatSalesStatisticsDate(data.generatedAt)}
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

function SalesCoreSummary({ data }: { data: SalesStatisticsData }) {
  const salesAmount = formatSalesAmount(data.summary.salesAmount);
  const averagePrice = formatSalesAveragePrice(
    data.summary.averageSalesPrice,
    data.summary.salesAmount.pricedCount,
    data.summary.salesAmount.totalCount
  );
  const purchaseCost = formatSalesAmount(data.summary.purchaseCost);
  const grossProfit = formatSalesGrossProfit(data.summary.grossProfit);
  const leadTime = formatSalesLeadTime(data.summary.leadTime);

  return (
    <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <SummaryTile
        icon={Store}
        label="확정 판매"
        value={formatNumber(data.summary.saleCount)}
        description="판매 원장 PG 기준"
        tone="success"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label="판매금액"
        value={salesAmount.value}
        description={salesAmount.detail}
        tone="warning"
      />
      <SummaryTile
        icon={CircleDollarSign}
        label="평균 판매가"
        value={averagePrice.value}
        description={averagePrice.detail}
        tone="sky"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label="매입 원가"
        value={purchaseCost.value}
        description={purchaseCost.detail}
        tone="purple"
      />
      <SummaryTile
        icon={Percent}
        label="상품 매출총이익"
        value={grossProfit.value}
        description={grossProfit.detail}
        tone="primary"
      />
      <SummaryTile
        icon={TimerReset}
        label="평균 판매 소요"
        value={leadTime.value}
        description={leadTime.detail}
        tone="sky"
      />
    </div>
  );
}

function SalesMonthlyTrend({ data }: { data: SalesStatisticsData }) {
  const rows = data.monthlyTrend.map((row) => [
    formatSalesStatisticsMonth(row.month),
    `${formatNumber(row.saleCount)}건`,
    <PresentationValue
      key={`${row.month}-sales`}
      metric={formatSalesAmount(row.salesAmount)}
    />,
    <PresentationValue
      key={`${row.month}-average`}
      metric={formatSalesAveragePrice(
        row.averageSalesPrice,
        row.salesAmount.pricedCount,
        row.salesAmount.totalCount
      )}
    />,
    <PresentationValue
      key={`${row.month}-profit`}
      metric={formatSalesGrossProfit(row.grossProfit)}
    />,
  ]);

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <LineTrendChart
        title="월별 확정 판매량"
        points={data.monthlyTrend.map((row) => ({
          label: row.month,
          value: row.saleCount,
        }))}
        maxAxisLabels={8}
      />
      <Section
        title="월별 판매 성과"
        description="판매 원장의 원 판매일을 한국 표준시 월로 묶었습니다."
      >
        <CompactTable
          columns={[
            "월",
            { label: "판매", align: "right" },
            { label: "판매금액", align: "right" },
            { label: "평균 판매가", align: "right" },
            { label: "상품 매출총이익", align: "right" },
          ]}
          rows={rows}
          gridTemplateColumns="120px 90px minmax(180px,1fr) minmax(170px,1fr) minmax(210px,1.2fr)"
          minWidth={900}
          maxHeight={360}
        />
      </Section>
    </div>
  );
}

function SalesProductPerformance({ data }: { data: SalesStatisticsData }) {
  const rows = data.productRows.map((row) => [
    row.skuCode,
    row.model,
    row.storage,
    row.color,
    <SaleGradeBadge key={`${row.key}-grade`} value={row.saleGrade} />,
    row.warrantyGroup,
    `${formatNumber(row.saleCount)}건`,
    <PresentationValue
      key={`${row.key}-share`}
      metric={formatSalesRate(row.saleShare)}
    />,
    <PresentationValue
      key={`${row.key}-amount`}
      metric={formatSalesAmount(row.salesAmount)}
    />,
    <PresentationValue
      key={`${row.key}-profit`}
      metric={formatSalesGrossProfit(row.grossProfit)}
    />,
    <PresentationValue
      key={`${row.key}-lead`}
      metric={formatSalesLeadTime(row.leadTime)}
    />,
    `${formatNumber(row.longTermSaleCount)}건`,
  ]);

  return (
    <Section
      title="상품별 판매 성과"
      description="배송 완료 시점에 고정된 판매 원장 상품 속성별 비교입니다."
    >
      <CompactTable
        columns={[
          "SKU",
          "기종",
          "용량",
          "색상",
          "등급",
          "보증",
          { label: "판매", align: "right" },
          { label: "비중", align: "right" },
          { label: "판매금액", align: "right" },
          { label: "상품 매출총이익", align: "right" },
          { label: "판매 소요", align: "right" },
          { label: "90일+", align: "right" },
        ]}
        rows={rows}
        gridTemplateColumns="150px 130px 90px 110px 80px 110px 80px 130px minmax(180px,1fr) minmax(210px,1.2fr) minmax(180px,1fr) 80px"
        minWidth={1700}
        maxHeight={560}
      />
    </Section>
  );
}

function SalesComposition({ data }: { data: SalesStatisticsData }) {
  const [dimension, setDimension] =
    React.useState<SalesDimensionKey>("MODEL");
  const rows = data.dimensionRows.filter(
    (row) => row.dimension === dimension
  );
  const groups: StatisticsGroup[] = rows.map((row) => ({
    label: row.label,
    count: row.saleCount,
  }));

  return (
    <Section
      title="판매 구성"
      description="한 번에 하나의 상품 속성을 선택해 구성 비중과 금액을 비교합니다."
      action={
        <Select
          value={dimension}
          onValueChange={(value) =>
            setDimension(value as SalesDimensionKey)
          }
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(dimensionLabels).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(280px,0.7fr)_minmax(0,1.3fr)]">
        <BarList groups={groups} total={data.summary.saleCount} />
        <CompactTable
          columns={[
            dimensionLabels[dimension],
            { label: "판매", align: "right" },
            { label: "비중", align: "right" },
            { label: "판매금액", align: "right" },
            { label: "상품 매출총이익", align: "right" },
          ]}
          rows={rows.map((row) => [
            row.label,
            `${formatNumber(row.saleCount)}건`,
            <PresentationValue
              key={`${row.dimension}-${row.label}-share`}
              metric={formatSalesRate(row.saleShare)}
            />,
            <PresentationValue
              key={`${row.dimension}-${row.label}-amount`}
              metric={formatSalesAmount(row.salesAmount)}
            />,
            <PresentationValue
              key={`${row.dimension}-${row.label}-profit`}
              metric={formatSalesGrossProfit(row.grossProfit)}
            />,
          ])}
          gridTemplateColumns="minmax(130px,1fr) 90px 130px minmax(180px,1fr) minmax(210px,1.2fr)"
          minWidth={860}
          maxHeight={420}
        />
      </div>
    </Section>
  );
}

function SalesPriceGradeMatrix({ data }: { data: SalesStatisticsData }) {
  return (
    <Section
      title="가격대와 판매 등급"
      description="판매가 미기록 건은 가격 미확인 행에 남겨 커버리지 손실을 숨기지 않습니다."
    >
      <CompactTable
        columns={[
          "가격대",
          ...data.priceGradeColumns.map((grade) => ({
            label: grade,
            align: "right" as const,
          })),
          { label: "합계", align: "right" },
        ]}
        rows={data.priceGradeRows.map((row) => [
          row.priceBand,
          ...data.priceGradeColumns.map((grade) =>
            formatNumber(row.gradeCounts[grade] ?? 0)
          ),
          formatNumber(row.totalCount),
        ])}
        gridTemplateColumns={
          data.priceGradeColumns.length === 0
            ? "150px 90px"
            : `150px repeat(${data.priceGradeColumns.length}, minmax(80px, 1fr)) 90px`
        }
        minWidth={Math.max(560, 240 + data.priceGradeColumns.length * 80)}
      />
    </Section>
  );
}

function SalesLeadTimeDistribution({
  data,
}: {
  data: SalesStatisticsData;
}) {
  const groups = data.summary.leadTime.buckets.map((bucket) => ({
    label: bucket.label,
    count: bucket.count,
  }));

  return (
    <Section
      title="판매 소요기간 구성"
      description="매입 확정일부터 원 판매일까지 계산할 수 있는 표본만 구간별로 비교합니다."
    >
      <BarList
        groups={groups}
        total={data.summary.leadTime.sampleCount}
      />
    </Section>
  );
}

function SalesChannelPerformance({ data }: { data: SalesStatisticsData }) {
  return (
    <Section
      title="판매 채널 성과"
      description="채널별 판매 규모와 가격·원가가 모두 있는 상품의 매출총이익을 비교합니다."
    >
      <CompactTable
        columns={[
          "채널",
          { label: "판매", align: "right" },
          { label: "비중", align: "right" },
          { label: "판매금액", align: "right" },
          { label: "평균 판매가", align: "right" },
          { label: "상품 매출총이익", align: "right" },
          { label: "판매 소요", align: "right" },
        ]}
        rows={data.channelRows.map((row) => [
          row.channel,
          `${formatNumber(row.saleCount)}건`,
          <PresentationValue
            key={`${row.channel}-share`}
            metric={formatSalesRate(row.saleShare)}
          />,
          <PresentationValue
            key={`${row.channel}-amount`}
            metric={formatSalesAmount(row.salesAmount)}
          />,
          <PresentationValue
            key={`${row.channel}-average`}
            metric={formatSalesAveragePrice(
              row.averageSalesPrice,
              row.salesAmount.pricedCount,
              row.salesAmount.totalCount
            )}
          />,
          <PresentationValue
            key={`${row.channel}-profit`}
            metric={formatSalesGrossProfit(row.grossProfit)}
          />,
          <PresentationValue
            key={`${row.channel}-lead`}
            metric={formatSalesLeadTime(row.leadTime)}
          />,
        ])}
        gridTemplateColumns="130px 90px 130px minmax(180px,1fr) minmax(170px,1fr) minmax(210px,1.2fr) minmax(180px,1fr)"
        minWidth={1150}
      />
    </Section>
  );
}

export function SalesStatisticsPanel({
  periodSelection,
}: {
  periodSelection: StatisticsPeriodSelection;
}) {
  const requestKey =
    buildStatisticsPeriodRequestQuery(periodSelection);
  const [requestState, setRequestState] = React.useState<{
    requestKey: string | null;
    data: SalesStatisticsData | null;
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
        `/api/statistics/sales${
          requestKey ? `?${requestKey}` : ""
        }`,
        {
          cache: "no-store",
          signal: controller.signal,
        }
      )
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as
            | SalesStatisticsApiResponse
            | null;

          if (!response.ok || !payload?.ok || !payload.data) {
            throw new Error(
              payload?.message || "판매 통계를 불러오지 못했습니다."
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
          판매 통계를 불러오는 중입니다.
        </FeedbackBanner>
        <EmptyDataState message="판매 원장을 집계하고 있습니다." />
      </div>
    );
  }

  if (!visibleData && errorMessage) {
    return (
      <FeedbackBanner tone="danger">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">
              판매 통계를 불러오지 못했습니다.
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

      <SalesSourceCoverage data={visibleData} />
      <SalesCoreSummary data={visibleData} />
      <SalesMonthlyTrend data={visibleData} />
      <SalesProductPerformance data={visibleData} />
      <SalesComposition data={visibleData} />
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
        <SalesPriceGradeMatrix data={visibleData} />
        <SalesLeadTimeDistribution data={visibleData} />
      </div>
      <SalesChannelPerformance data={visibleData} />
    </div>
  );
}
