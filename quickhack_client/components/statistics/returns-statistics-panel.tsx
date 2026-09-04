"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
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
  useReturnStatisticsPresentation,
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

function formatGroupSummary(groups: StatisticsGroup[], locale: string) {
  if (groups.length === 0) {
    return "-";
  }

  return groups
    .slice(0, 3)
    .map((group) => `${group.label} ${formatNumber(group.count, locale)}`)
    .join(" · ");
}

function SourceCoverage({ data }: { data: ReturnStatisticsData }) {
  const t = useTranslations("statistics.returns");
  const { formatDate: formatReturnStatisticsDate, formatRate: formatReturnRate } = useReturnStatisticsPresentation();
  const warnings = [
    data.source.unlinkedReceiptCount > 0
      ? t("coverage.unlinkedReceipt", { count: data.source.unlinkedReceiptCount })
      : null,
    data.source.ambiguousReceiptCount > 0
      ? t("coverage.ambiguousReceipt", { count: data.source.ambiguousReceiptCount })
      : null,
    data.source.missingOrInvalidExternalTimestampCount > 0
      ? t("coverage.missingTime", { count: data.source.missingOrInvalidExternalTimestampCount })
      : null,
    data.source.claimBeforeSaleCount > 0
      ? t("coverage.claimBeforeSale", { count: data.source.claimBeforeSaleCount })
      : null,
    data.source.claimAfterThirtyDaysCount > 0
      ? t("coverage.claimAfter30", { count: data.source.claimAfterThirtyDaysCount })
      : null,
    data.source.negativeDurationCount > 0
      ? t("coverage.invalidTime", { count: data.source.negativeDurationCount })
      : null,
    data.source.unmatchedWithdrawalCount > 0
      ? t("coverage.unmatchedWithdrawal", { count: data.source.unmatchedWithdrawalCount })
      : null,
  ].filter((value): value is string => Boolean(value));
  const linkRate = formatReturnRate(data.overview.receiptLinkRate);

  return (
    <Section
      title={t("coverage.title")}
      description={t("coverage.subtitle")}
    >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <StatisticsCalculationScope calculation={data.calculation} />
        <StatisticsCoverageItem
          label={t("coverage.eventStart")}
          value={formatReturnStatisticsDate(
            data.source.eventRecordingStartedAt
          )}
          description={t("coverage.eventCount", { count: data.source.claimEventCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.lastObserved")}
          value={formatReturnStatisticsDate(data.source.lastClaimEventAt)}
          description={t("coverage.observed", { returns: data.source.observedReturnReceiptCount, cancellations: data.source.observedCancellationReceiptCount, exchanges: data.source.observedExchangeCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.linkRate")}
          value={linkRate.value}
          description={t("coverage.linkDescription", { detail: linkRate.detail, confirmed: data.source.confirmedAllocationLinkCount, unique: data.source.uniqueExternalKeyLinkCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.linkedSales")}
          value={t("overview.count", { count: data.source.linkedSaleRecordCount })}
          description={t("coverage.linkedSalesDescription", { count: data.source.cohortSalesCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.priceCoverage")}
          value={`${data.source.salesPriceCoveragePercent}%`}
          description={t("coverage.priceCount", { available: data.source.salesPriceAvailableCount, total: data.source.cohortSalesCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.costCoverage")}
          value={`${data.source.purchasePriceCoveragePercent}%`}
          description={t("coverage.priceCount", { available: data.source.purchasePriceAvailableCount, total: data.source.cohortSalesCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.confirmedInspection")}
          value={t("coverage.deviceCount", {
            count: data.source.confirmedInspectionPgCount,
          })}
          description={t("coverage.inspectionDescription", { count: data.inspectionOutcome.linkedReturnPgCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.generatedAt")}
          value={formatReturnStatisticsDate(data.generatedAt)}
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

function CoreSummary({ data }: { data: ReturnStatisticsData }) {
  const t = useTranslations("statistics.returns");
  const { formatAmount: formatReturnAmount, formatDelta: formatReturnDelta, formatRate: formatReturnRate } = useReturnStatisticsPresentation();
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
        label={t("summary.requestRate")}
        value={requestRate.value}
        description={requestRate.detail}
        tone="primary"
      />
      <SummaryTile
        icon={CalendarClock}
        label={t("summary.previous")}
        value={delta.value}
        description={t("summary.previousDescription", { detail: delta.detail, value: previousRate.value })}
        tone="sky"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label={t("summary.associatedSales")}
        value={salesAmount.value}
        description={salesAmount.detail}
        tone="warning"
      />
      <SummaryTile
        icon={AlertTriangle}
        label={t("summary.vendorFault")}
        value={vendorFault.value}
        description={vendorFault.detail}
        tone="purple"
      />
      <SummaryTile
        icon={PackageCheck}
        label={t("summary.recovery")}
        value={recovery.value}
        description={recovery.detail}
        tone="success"
      />
    </div>
  );
}

function CustomerReturnOverview({ data }: { data: ReturnStatisticsData }) {
  const { formatAmount: formatReturnAmount, formatMonth: formatReturnStatisticsMonth, formatRate: formatReturnRate } = useReturnStatisticsPresentation();
  const t = useTranslations("statistics.returns");
  const locale = useLocale();
  const overview = data.overview;
  const linkRate = formatReturnRate(overview.receiptLinkRate);
  const withdrawalShare = formatReturnRate(overview.withdrawalShare);

  const rows = data.occurrenceTrend.map((row) => [
    formatReturnStatisticsMonth(row.receiptMonth),
    formatNumber(row.receiptCount, locale),
    formatNumber(row.returnQuantity, locale),
    formatNumber(row.linkedSaleRecordCount, locale),
    formatNumber(row.completedReceiptCount, locale),
    formatNumber(row.withdrawnReceiptCount, locale),
    <PresentationValue
      key={`${row.receiptMonth}-amount`}
      metric={formatReturnAmount(row.associatedSalesAmount)}
    />,
  ]);

  return (
    <Section
      title={t("overview.title")}
      description={t("overview.subtitle")}
    >
      <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
        <StatisticsCoverageItem
          label={t("overview.receipts")}
          value={t("overview.count", { count: overview.receiptCount })}
          description={t("overview.quantityValue", { count: overview.returnQuantity })}
        />
        <StatisticsCoverageItem
          label={t("overview.connected")}
          value={t("overview.count", { count: overview.linkedReceiptCount })}
          description={linkRate.value}
        />
        <StatisticsCoverageItem
          label={t("overview.connectedSales")}
          value={t("overview.count", { count: overview.linkedSaleRecordCount })}
        />
        <StatisticsCoverageItem
          label={t("overview.completed")}
          value={t("overview.count", { count: overview.completedReceiptCount })}
        />
        <StatisticsCoverageItem
          label={t("overview.withdrawn")}
          value={t("overview.count", { count: overview.withdrawnReceiptCount })}
          description={withdrawalShare.value}
        />
        <StatisticsCoverageItem
          label={t("overview.linkRate")}
          value={linkRate.value}
          description={linkRate.detail}
        />
      </div>
      <CompactTable
        columns={[
          t("overview.month"),
          { label: t("overview.receipts"), align: "right" },
          { label: t("overview.quantity"), align: "right" },
          { label: t("overview.linkedSales"), align: "right" },
          { label: t("overview.completed"), align: "right" },
          { label: t("overview.withdrawn"), align: "right" },
          { label: t("overview.amount"), align: "right", wrap: true },
        ]}
        rows={rows}
        gridTemplateColumns="150px repeat(5, 90px) minmax(190px, 1fr)"
        minWidth={880}
      />
    </Section>
  );
}

function CohortTrend({ data }: { data: ReturnStatisticsData }) {
  const { formatMonth: formatReturnStatisticsMonth, formatRate: formatReturnRate } = useReturnStatisticsPresentation();
  const t = useTranslations("statistics.returns");
  const locale = useLocale();
  const series = [
    {
      key: "day7",
      label: t("cohort.days7"),
      points: data.cohortTrend.map((row) => ({
        label: formatReturnStatisticsMonth(row.saleMonth),
        value: row.day7.value,
      })),
    },
    {
      key: "day14",
      label: t("cohort.days14"),
      points: data.cohortTrend.map((row) => ({
        label: formatReturnStatisticsMonth(row.saleMonth),
        value: row.day14.value,
      })),
    },
    {
      key: "day30",
      label: t("cohort.days30"),
      points: data.cohortTrend.map((row) => ({
        label: formatReturnStatisticsMonth(row.saleMonth),
        value: row.day30.value,
      })),
    },
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(440px,0.75fr)]">
      <MultiLineTrendChart
        title={t("cohort.title")}
        series={series}
      />
      <Section
        title={t("cohort.sample")}
        description={t("cohort.subtitle")}
      >
        <CompactTable
          columns={[
            t("cohort.month"),
            { label: t("cohort.sales"), align: "right" },
            { label: t("cohort.days7"), align: "right", wrap: true },
            { label: t("cohort.days14"), align: "right", wrap: true },
            { label: t("cohort.days30"), align: "right", wrap: true },
          ]}
          rows={data.cohortTrend.map((row) => [
            formatReturnStatisticsMonth(row.saleMonth),
            formatNumber(row.saleCount, locale),
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
  const { formatAmount: formatReturnAmount, formatDelta: formatReturnDelta, formatRate: formatReturnRate } = useReturnStatisticsPresentation();
  const t = useTranslations("statistics.returns");
  const locale = useLocale();
  return (
    <Section
      title={t("product.title")}
      description={t("product.subtitle")}
    >
      <CompactTable
        columns={[
          { label: t("product.model"), wrap: true }, t("product.storage"), t("product.saleGrade"),
          { label: t("product.matureSales"), align: "right" }, { label: t("product.returnSales"), align: "right" },
          { label: t("product.rate30"), align: "right", wrap: true }, { label: t("product.delta"), align: "right", wrap: true },
          { label: t("product.amount"), align: "right", wrap: true }, { label: t("product.sellerFault"), align: "right", wrap: true },
          { label: t("product.recovery"), align: "right", wrap: true },
        ]}
        rows={data.productRows.map((row) => [
          row.model,
          row.storage,
          row.saleGrade,
          formatNumber(row.matureSalesCount, locale),
          formatNumber(row.returnSaleRecordCount, locale),
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
  const t = useTranslations("statistics.returns");
  const locale = useLocale();
  const returnTotal = data.overview.receiptCount;

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title={t("inspection.reason")}>
          <BarList groups={data.reasons} total={returnTotal} />
        </Section>
        <Section title={t("inspection.fault")}>
          <BarList groups={data.faults} total={returnTotal} />
        </Section>
      </div>
      <Section
        title={t("inspection.matrixTitle")}
        description={t("inspection.matrixDescription")}
      >
        <CompactTable
          columns={[
            { label: t("inspection.reason"), wrap: true }, { label: t("overview.receipts"), align: "right" },
            { label: t("inspection.inspectedPg"), align: "right" }, { label: t("inspection.resellable"), align: "right" },
            { label: t("inspection.nonSellable"), align: "right" }, { label: t("inspection.hold"), align: "right" },
            { label: t("inspection.appearanceDefect"), wrap: true }, { label: t("inspection.functionDefect"), wrap: true },
          ]}
          rows={data.reasonInspectionMatrix.map((row) => [
            row.reason,
            formatNumber(row.receiptCount, locale),
            formatNumber(row.confirmedInspectionPgCount, locale),
            formatNumber(row.recoveredCount, locale),
            formatNumber(row.nonSellableCount, locale),
            formatNumber(row.holdCount, locale),
            formatGroupSummary(row.appearanceDefects, locale),
            formatGroupSummary(row.functionDefects, locale),
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
  const { formatAmount: formatReturnAmount, formatRate: formatReturnRate } = useReturnStatisticsPresentation();
  const t = useTranslations("statistics.returns");
  const outcome = data.inspectionOutcome;
  const recovery = formatReturnRate(outcome.recoveryRate);
  const amounts = [
    [t("economics.associatedSales"), data.economicImpact.associatedSalesAmount],
    [t("economics.associatedCost"), data.economicImpact.associatedPurchaseCost],
    [t("economics.recoveredCost"), data.economicImpact.recoveredAssetCost],
    [
      t("economics.nonSellableCost"),
      data.economicImpact.nonSellableOrHoldAssetCost,
    ],
  ] as const;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section
        title={t("inspection.title")}
        description={t("inspection.description")}
      >
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          <StatisticsCoverageItem
            label={t("inspection.linkedPg")}
            value={t("inspection.unit", { count: outcome.linkedReturnPgCount })}
          />
          <StatisticsCoverageItem
            label={t("inspection.confirmed")}
            value={t("inspection.unit", { count: outcome.confirmedInspectionPgCount })}
          />
          <StatisticsCoverageItem
            label={t("inspection.resellable")}
            value={t("inspection.unit", { count: outcome.recoveredCount })}
            description={recovery.value}
          />
          <StatisticsCoverageItem
            label={t("inspection.nonSellable")}
            value={t("inspection.unit", { count: outcome.nonSellableCount })}
          />
          <StatisticsCoverageItem
            label={t("inspection.hold")}
            value={t("inspection.unit", { count: outcome.holdCount })}
          />
          <StatisticsCoverageItem
            label={t("inspection.recovery")}
            value={recovery.value}
            description={recovery.detail}
          />
        </div>
      </Section>
      <Section
        title={t("economics.title")}
        description={t("economics.description")}
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
  const { formatDuration: formatReturnDuration } = useReturnStatisticsPresentation();
  const t = useTranslations("statistics.returns");
  const items = [
    [t("leadTime.receiptToObservation"), data.leadTimes.externalReceiptToObservation],
    [t("leadTime.observationToApproval"), data.leadTimes.observationToApprovalRequest],
    [t("leadTime.observationToFinal"), data.leadTimes.observationToLocalFinalization],
  ] as const;

  return (
    <Section
      title={t("leadTime.title")}
      description={t("leadTime.description")}
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
  const { formatMonth: formatReturnStatisticsMonth } = useReturnStatisticsPresentation();
  const t = useTranslations("statistics.returns");
  const locale = useLocale();
  const cancellation = data.preShipmentCancellations;

  return (
    <Section
      title={t("cancellation.title")}
      description={t("cancellation.description")}
    >
      <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-2">
          <StatisticsCoverageItem
            label={t("cancellation.count")}
            value={t("overview.count", { count: cancellation.receiptCount })}
          />
          <StatisticsCoverageItem
            label={t("cancellation.quantity")}
            value={t("cancellation.unit", { count: cancellation.cancellationQuantity })}
          />
        </div>
        <div className="grid gap-3">
          <div className="text-xs font-semibold">{t("cancellation.month")}</div>
          <CompactTable
            columns={[
              t("overview.month"), { label: t("overview.receipts"), align: "right" }, { label: t("overview.quantity"), align: "right" },
            ]}
            rows={cancellation.occurrenceTrend.map((row) => [
              formatReturnStatisticsMonth(row.receiptMonth),
              formatNumber(row.receiptCount, locale),
              formatNumber(row.cancellationQuantity, locale),
            ])}
            gridTemplateColumns="1fr 80px 80px"
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
          <div>
            <div className="mb-2 text-xs font-semibold">{t("cancellation.reasons")}</div>
            <BarList
              groups={cancellation.reasons}
              total={cancellation.receiptCount}
            />
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold">{t("cancellation.products")}</div>
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
  const { formatDuration: formatReturnDuration, formatMonth: formatReturnStatisticsMonth } = useReturnStatisticsPresentation();
  const t = useTranslations("statistics.returns");
  const locale = useLocale();
  const exchange = data.exchanges;
  const duration = formatReturnDuration(exchange.terminalLeadTime);

  return (
    <Section
      title={t("exchange.title")}
      description={t("exchange.description")}
    >
      <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-2">
          <StatisticsCoverageItem
            label={t("exchange.receipts")}
            value={t("overview.count", { count: exchange.receiptCount })}
          />
          <StatisticsCoverageItem
            label={t("exchange.duration")}
            value={duration.value}
            description={duration.detail}
          />
          <CompactTable
            columns={[
              t("overview.month"), { label: t("overview.receipts"), align: "right" },
            ]}
            rows={exchange.occurrenceTrend.map((row) => [
              formatReturnStatisticsMonth(row.label),
              formatNumber(row.value, locale),
            ])}
            gridTemplateColumns="1fr 80px"
          />
        </div>
        <div className="grid gap-4">
          <div>
            <div className="mb-2 text-xs font-semibold">{t("exchange.reasons")}</div>
            <BarList groups={exchange.reasons} total={exchange.receiptCount} />
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold">{t("exchange.fault")}</div>
            <BarList groups={exchange.faults} total={exchange.receiptCount} />
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold">{t("exchange.results")}</div>
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
  const t = useTranslations("statistics.returns");
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
              legacyApiMessage(payload, t("fallback.loadFailed"))
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
    <div aria-busy={isLoading} className="grid gap-4">
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
