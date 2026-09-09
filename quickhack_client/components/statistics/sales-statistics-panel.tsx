"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
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
  useSalesStatisticsPresentation,
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
  SALES_STATISTICS_PRICE_BANDS,
  SALES_STATISTICS_UNKNOWN,
} from "@/quickhack_shared/statistics/statistics";
import {
  buildStatisticsPeriodRequestQuery,
  type StatisticsPeriodSelection,
} from "@/quickhack_shared/statistics/statistics-period";

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
  const t = useTranslations("statistics.sales");
  const { formatDate } = useSalesStatisticsPresentation();
  const warnings = [
    data.source.excludedStatusCount > 0
      ? t("coverage.excludedStatus", { count: data.source.excludedStatusCount })
      : null,
    data.source.invalidSoldAtCount > 0
      ? t("coverage.invalidSoldAt", { count: data.source.invalidSoldAtCount })
      : null,
    data.source.futureSoldAtCount > 0
      ? t("coverage.futureSoldAt", { count: data.source.futureSoldAtCount })
      : null,
    data.source.eligibleSaleRecordCount -
        data.source.pricedSaleCount >
      0
      ? t("coverage.missingSalesPrice", { count: data.source.eligibleSaleRecordCount - data.source.pricedSaleCount })
      : null,
    data.source.eligibleSaleRecordCount -
        data.source.purchasePricedSaleCount >
      0
      ? t("coverage.missingPurchasePrice", { count: data.source.eligibleSaleRecordCount - data.source.purchasePricedSaleCount })
      : null,
    data.source.missingPurchaseAgreedAtCount > 0
      ? t("coverage.missingPurchaseAt", { count: data.source.missingPurchaseAgreedAtCount })
      : null,
    data.source.invalidLeadTimeCount > 0
      ? t("coverage.invalidLead", { count: data.source.invalidLeadTimeCount })
      : null,
  ].filter((warning): warning is string => warning !== null);

  return (
    <Section
      title={t("coverage.title")}
      description={t("coverage.subtitle")}
    >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <StatisticsCalculationScope calculation={data.calculation} />
        <StatisticsCoverageItem
          label={t("coverage.ledger")}
          value={t("count", { count: data.source.eligibleSaleRecordCount })}
          description={t("coverage.ledgerDescription", { count: data.source.loadedSaleRecordCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.status")}
          value={t("coverage.statusValue", { count: data.source.soldSaleRecordCount })}
          description={t("coverage.statusDescription", { count: data.source.returnedSaleRecordCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.salesPrice")}
          value={`${data.source.salesPriceCoveragePercent}%`}
          description={t("coverage.ratio", { available: data.source.pricedSaleCount, total: data.source.eligibleSaleRecordCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.purchasePrice")}
          value={`${data.source.purchasePriceCoveragePercent}%`}
          description={t("coverage.ratio", { available: data.source.purchasePricedSaleCount, total: data.source.eligibleSaleRecordCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.profit")}
          value={`${data.source.profitCoveragePercent}%`}
          description={t("coverage.ratio", { available: data.source.comparableProfitCount, total: data.source.eligibleSaleRecordCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.leadSample")}
          value={t("count", { count: data.source.leadTimeSampleCount })}
          description={t("coverage.leadDescription", { missing: data.source.missingPurchaseAgreedAtCount, invalid: data.source.invalidLeadTimeCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.soldAtExcluded")}
          value={t("count", { count: data.source.invalidSoldAtCount + data.source.futureSoldAtCount })}
          description={t("coverage.soldAtDescription", { invalid: data.source.invalidSoldAtCount, future: data.source.futureSoldAtCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.generatedAt")}
          value={formatDate(data.generatedAt)}
          description={t("coverage.periodAll")}
        />
      </div>

      {warnings.length > 0 ? (
        <FeedbackBanner tone="warning" size="xs">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="font-semibold">
                {t("coverage.warning")}
              </div>
              <div className="mt-1">{warnings.join(" · ")}</div>
            </div>
          </div>
        </FeedbackBanner>
      ) : (
        <FeedbackBanner tone="success" size="xs">
          {t("coverage.success")}
        </FeedbackBanner>
      )}
    </Section>
  );
}

function SalesCoreSummary({ data }: { data: SalesStatisticsData }) {
  const t = useTranslations("statistics.sales");
  const locale = useLocale();
  const {
    formatAmount: formatSalesAmount,
    formatAveragePrice: formatSalesAveragePrice,
    formatGrossProfit: formatSalesGrossProfit,
    formatLeadTime: formatSalesLeadTime,
  } = useSalesStatisticsPresentation();
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
        label={t("summary.sales")}
        value={formatNumber(data.summary.saleCount, locale)}
        description={t("summary.salesDescription")}
        tone="success"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label={t("summary.amount")}
        value={salesAmount.value}
        description={salesAmount.detail}
        tone="warning"
      />
      <SummaryTile
        icon={CircleDollarSign}
        label={t("summary.averagePrice")}
        value={averagePrice.value}
        description={averagePrice.detail}
        tone="sky"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label={t("summary.purchaseCost")}
        value={purchaseCost.value}
        description={purchaseCost.detail}
        tone="purple"
      />
      <SummaryTile
        icon={Percent}
        label={t("summary.grossProfit")}
        value={grossProfit.value}
        description={grossProfit.detail}
        tone="primary"
      />
      <SummaryTile
        icon={TimerReset}
        label={t("summary.leadTime")}
        value={leadTime.value}
        description={leadTime.detail}
        tone="sky"
      />
    </div>
  );
}

function SalesMonthlyTrend({ data }: { data: SalesStatisticsData }) {
  const t = useTranslations("statistics.sales");
  const {
    formatAmount: formatSalesAmount,
    formatAveragePrice: formatSalesAveragePrice,
    formatGrossProfit: formatSalesGrossProfit,
    formatMonth: formatSalesStatisticsMonth,
  } = useSalesStatisticsPresentation();
  const rows = data.monthlyTrend.map((row) => [
    formatSalesStatisticsMonth(row.month),
    t("count", { count: row.saleCount }),
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
        title={t("monthly.chart")}
        points={data.monthlyTrend.map((row) => ({
          label: row.month,
          value: row.saleCount,
        }))}
        maxAxisLabels={8}
      />
      <Section
        title={t("monthly.title")}
        description={t("monthly.subtitle")}
      >
        <CompactTable
          columns={[
            t("monthly.month"),
            { label: t("monthly.sales"), align: "right" },
            { label: t("monthly.amount"), align: "right" },
            { label: t("monthly.average"), align: "right" },
            { label: t("monthly.grossProfit"), align: "right" },
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
  const t = useTranslations("statistics.sales");
  const {
    formatAmount: formatSalesAmount,
    formatGrossProfit: formatSalesGrossProfit,
    formatLeadTime: formatSalesLeadTime,
    formatRate: formatSalesRate,
  } = useSalesStatisticsPresentation();
  const rows = data.productRows.map((row) => [
    salesDimensionValueLabel(row.skuCode, t),
    salesDimensionValueLabel(row.model, t),
    salesDimensionValueLabel(row.storage, t),
    salesDimensionValueLabel(row.color, t),
    row.saleGrade === SALES_STATISTICS_UNKNOWN.grade
      ? salesDimensionValueLabel(row.saleGrade, t)
      : <SaleGradeBadge key={`${row.key}-grade`} value={row.saleGrade} />,
    salesDimensionValueLabel(row.warrantyGroup, t),
    t("count", { count: row.saleCount }),
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
    t("count", { count: row.longTermSaleCount }),
  ]);

  return (
    <Section
      title={t("product.title")}
      description={t("product.subtitle")}
    >
      <CompactTable
        columns={[
          "SKU",
          t("product.model"), t("product.storage"), t("product.color"), t("product.grade"), t("product.warranty"),
          { label: t("product.sales"), align: "right" },
          { label: t("product.share"), align: "right" },
          { label: t("product.amount"), align: "right" },
          { label: t("product.grossProfit"), align: "right" },
          { label: t("product.lead"), align: "right" },
          { label: t("product.days90"), align: "right" },
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
  const t = useTranslations("statistics.sales");
  const {
    formatAmount: formatSalesAmount,
    formatGrossProfit: formatSalesGrossProfit,
    formatRate: formatSalesRate,
  } = useSalesStatisticsPresentation();
  const dimensionLabels: Record<SalesDimensionKey, string> = {
    MODEL: t("dimension.model"), STORAGE: t("dimension.storage"),
    COLOR: t("dimension.color"), SALE_GRADE: t("dimension.grade"),
    WARRANTY_GROUP: t("dimension.warranty"), CHANNEL: t("dimension.channel"),
  };
  const [dimension, setDimension] =
    React.useState<SalesDimensionKey>("MODEL");
  const rows = data.dimensionRows.filter(
    (row) => row.dimension === dimension
  );
  const groups: StatisticsGroup[] = rows.map((row) => ({
    label: salesDimensionValueLabel(row.label, t),
    count: row.saleCount,
  }));

  return (
    <Section
      title={t("composition.title")}
      description={t("composition.subtitle")}
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
            { label: t("composition.sales"), align: "right" },
            { label: t("composition.share"), align: "right" },
            { label: t("composition.amount"), align: "right" },
            { label: t("composition.grossProfit"), align: "right" },
          ]}
          rows={rows.map((row) => [
            salesDimensionValueLabel(row.label, t),
            t("count", { count: row.saleCount }),
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
  const t = useTranslations("statistics.sales");
  const locale = useLocale();
  return (
    <Section
      title={t("priceGrade.title")}
      description={t("priceGrade.subtitle")}
    >
      <CompactTable
        columns={[
          t("priceGrade.priceBand"),
          ...data.priceGradeColumns.map((grade) => ({
            label: salesDimensionValueLabel(grade, t),
            align: "right" as const,
          })),
          { label: t("priceGrade.total"), align: "right" },
        ]}
        rows={data.priceGradeRows.map((row) => [
          salesPriceBandLabel(row.priceBand, t),
          ...data.priceGradeColumns.map((grade) =>
            formatNumber(row.gradeCounts[grade] ?? 0, locale)
          ),
          formatNumber(row.totalCount, locale),
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
  const t = useTranslations("statistics.sales");
  const bucketLabel = (key: typeof data.summary.leadTime.buckets[number]["key"]) => {
    if (key === "DAYS_0_29") return t("leadDistribution.days0_29");
    if (key === "DAYS_30_59") return t("leadDistribution.days30_59");
    if (key === "DAYS_60_89") return t("leadDistribution.days60_89");
    return t("leadDistribution.days90Plus");
  };
  const groups = data.summary.leadTime.buckets.map((bucket) => ({
    label: bucketLabel(bucket.key),
    count: bucket.count,
  }));

  return (
    <Section
      title={t("leadDistribution.title")}
      description={t("leadDistribution.subtitle")}
    >
      <BarList
        groups={groups}
        total={data.summary.leadTime.sampleCount}
      />
    </Section>
  );
}

function SalesChannelPerformance({ data }: { data: SalesStatisticsData }) {
  const t = useTranslations("statistics.sales");
  const {
    formatAmount: formatSalesAmount,
    formatAveragePrice: formatSalesAveragePrice,
    formatGrossProfit: formatSalesGrossProfit,
    formatLeadTime: formatSalesLeadTime,
    formatRate: formatSalesRate,
  } = useSalesStatisticsPresentation();
  return (
    <Section
      title={t("channel.title")}
      description={t("channel.subtitle")}
    >
      <CompactTable
        columns={[
          t("channel.channel"),
          { label: t("channel.sales"), align: "right" },
          { label: t("channel.share"), align: "right" },
          { label: t("channel.amount"), align: "right" },
          { label: t("channel.average"), align: "right" },
          { label: t("channel.grossProfit"), align: "right" },
          { label: t("channel.lead"), align: "right" },
        ]}
        rows={data.channelRows.map((row) => [
          row.channel,
          t("count", { count: row.saleCount }),
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
  const t = useTranslations("statistics.sales");
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
              legacyApiMessage(payload, t("loading.error"))
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
  }, [requestKey, retryRevision, t]);

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
          {t("loading.initial")}
        </FeedbackBanner>
        <EmptyDataState message={t("loading.aggregating")} />
      </div>
    );
  }

  if (!visibleData && errorMessage) {
    return (
      <FeedbackBanner tone="danger">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">
              {t("loading.error")}
            </div>
            <div className="mt-1 text-xs">{errorMessage}</div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRetryRevision((value) => value + 1)}
          >
            <RefreshCw />
            {t("loading.retry")}
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
          {t("loading.refresh")}
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
              {t("loading.retry")}
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
type SalesStatisticsTranslator = ReturnType<typeof useTranslations<"statistics.sales">>;

function salesDimensionValueLabel(value: string, t: SalesStatisticsTranslator) {
  const entries: Record<string, string> = {
    [SALES_STATISTICS_UNKNOWN.sku]: "unknown.sku",
    [SALES_STATISTICS_UNKNOWN.model]: "unknown.model",
    [SALES_STATISTICS_UNKNOWN.storage]: "unknown.storage",
    [SALES_STATISTICS_UNKNOWN.color]: "unknown.color",
    [SALES_STATISTICS_UNKNOWN.grade]: "unknown.grade",
    [SALES_STATISTICS_UNKNOWN.warranty]: "unknown.warranty",
    [SALES_STATISTICS_UNKNOWN.channel]: "unknown.channel",
  };
  return entries[value] ? t(entries[value] as never) : value;
}

function salesPriceBandLabel(value: string, t: SalesStatisticsTranslator) {
  if (!(SALES_STATISTICS_PRICE_BANDS as readonly string[]).includes(value)) return value;
  return t(`priceBand.${value}` as never);
}
