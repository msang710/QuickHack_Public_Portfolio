"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
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
  usePurchaseStatisticsPresentation,
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
  const t = useTranslations("statistics.purchase");
  const { formatDate } = usePurchaseStatisticsPresentation();
  const missingPolicyCount =
    data.source.purchaseCount - data.source.pricePolicyEvidenceCount;
  const warnings = [
    data.source.missingPurchasePriceCount > 0
      ? t("coverage.missingPrice", { count: data.source.missingPurchasePriceCount })
      : null,
    data.source.missingSupplierOutcomeCount > 0
      ? t("coverage.missingSupplier", { count: data.source.missingSupplierOutcomeCount })
      : null,
    data.source.missingInspectionOutcomeCount > 0
      ? t("coverage.missingInspection", { count: data.source.missingInspectionOutcomeCount })
      : null,
    data.source.missingPurchaseGradeOutcomeCount > 0
      ? t("coverage.missingGrade", { count: data.source.missingPurchaseGradeOutcomeCount })
      : null,
    missingPolicyCount > 0
      ? t("coverage.missingPolicy", { count: missingPolicyCount })
      : null,
    data.source.missingPurchaseInboundSaleCount > 0
      ? t("coverage.missingInboundSale", { count: data.source.missingPurchaseInboundSaleCount })
      : null,
    data.source.missingSupplierSnapshotSaleCount > 0
      ? t("coverage.missingSupplierSnapshot", { count: data.source.missingSupplierSnapshotSaleCount })
      : null,
    data.source.invalidTimestampCount > 0
      ? t("coverage.invalidTimestamp", { count: data.source.invalidTimestampCount })
      : null,
    data.source.negativeDurationCount > 0
      ? t("coverage.negativeDuration", { count: data.source.negativeDurationCount })
      : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <Section
      title={t("coverage.title")}
      description={t("coverage.subtitle")}
    >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <StatisticsCalculationScope calculation={data.calculation} />
        <StatisticsCoverageItem
          label={t("coverage.terminalInbound")}
          value={t("count", { count: data.source.terminalInboundCount })}
          description={t("coverage.terminalDescription", { purchases: data.source.purchaseCount, returns: data.source.supplierReturnCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.priceCoverage")}
          value={`${data.summary.purchaseAmount.coveragePercent}%`}
          description={t("coverage.countRatio", { available: data.source.pricedPurchaseCount, total: data.source.purchaseCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.supplierCoverage")}
          value={t("count", { count: data.source.namedSupplierOutcomeCount })}
          description={t("coverage.supplierDescription", { total: data.source.terminalInboundCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.inspectionLinkRate")}
          value={`${data.source.inspectionLinkCoveragePercent}%`}
          description={t("coverage.countRatio", { available: data.source.linkedInspectionOutcomeCount, total: data.source.terminalInboundCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.gradeCoverage")}
          value={t("count", { count: data.source.knownPurchaseGradeOutcomeCount })}
          description={t("coverage.gradeDescription", { missing: data.source.missingPurchaseGradeOutcomeCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.policyEvidence")}
          value={`${data.source.pricePolicyCoveragePercent}%`}
          description={t("coverage.policyDescription", { modes: data.source.pricePolicyEvidenceCount, references: data.source.priceReferenceEvidenceCount })}
        />
        <StatisticsCoverageItem
          label={t("coverage.salesLinkRate")}
          value={`${data.source.salesLinkCoveragePercent}%`}
          description={t("coverage.salesLinkDescription", { percent: data.source.supplierSnapshotCoveragePercent })}
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

function PurchaseCoreSummary({ data }: { data: PurchaseStatisticsData }) {
  const t = useTranslations("statistics.purchase");
  const locale = useLocale();
  const { formatAmount: formatPurchaseAmount, formatAveragePrice: formatPurchaseAveragePrice, formatRate: formatPurchaseRate } = usePurchaseStatisticsPresentation();
  const purchaseAmount = formatPurchaseAmount(data.summary.purchaseAmount);
  const supplierReturnRate = formatPurchaseRate(
    data.summary.supplierReturnRate
  );

  return (
    <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
      <SummaryTile
        icon={PackageCheck}
        label={t("summary.purchaseCount")}
        value={formatNumber(data.summary.purchaseCount, locale)}
        description={t("summary.purchaseBasis")}
        tone="success"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label={t("summary.amount")}
        value={purchaseAmount.value}
        description={purchaseAmount.detail}
        tone="warning"
      />
      <SummaryTile
        icon={BadgeDollarSign}
        label={t("summary.averagePrice")}
        value={formatPurchaseAveragePrice(
          data.summary.averagePurchasePrice
        )}
        description={t("summary.priceConfirmed", { count: data.summary.purchaseAmount.pricedCount })}
        tone="sky"
      />
      <SummaryTile
        icon={Building2}
        label={t("summary.suppliers")}
        value={formatNumber(data.summary.supplierCount, locale)}
        description={t("summary.supplierDescription")}
        tone="purple"
      />
      <SummaryTile
        icon={Percent}
        label={t("summary.supplierReturnRate")}
        value={supplierReturnRate.value}
        description={supplierReturnRate.detail}
        tone="primary"
      />
    </div>
  );
}

function PurchaseMonthlyTrend({ data }: { data: PurchaseStatisticsData }) {
  const t = useTranslations("statistics.purchase");
  const { formatAveragePrice: formatPurchaseAveragePrice, formatMonth: formatPurchaseStatisticsMonth } = usePurchaseStatisticsPresentation();
  const rows = data.monthlyTrend.map((row) => [
    formatPurchaseStatisticsMonth(row.month),
    t("count", { count: row.purchaseCount }),
    formatPurchaseAveragePrice(row.purchaseAmount),
    t("count", { count: row.pricedPurchaseCount }),
    t("count", { count: row.missingPurchasePriceCount }),
    t("count", { count: row.supplierReturnCount }),
    t("count", { count: row.inspectionDefectOutcomeCount }),
  ]);

  return (
    <div className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(520px,0.85fr)]">
      <MultiLineTrendChart
        title={t("monthly.title")}
        description={t("monthly.subtitle")}
        valueFormatter={(value) => t("count", { count: value })}
        series={[
          {
            key: "purchase",
            label: t("monthly.purchase"),
            points: data.monthlyTrend.map((row) => ({
              label: formatPurchaseStatisticsMonth(row.month),
              value: row.purchaseCount,
            })),
          },
          {
            key: "supplier-return",
            label: t("monthly.supplierReturn"),
            points: data.monthlyTrend.map((row) => ({
              label: formatPurchaseStatisticsMonth(row.month),
              value: row.supplierReturnCount,
            })),
          },
          {
            key: "inspection-defect",
            label: t("monthly.inspectionDefect"),
            points: data.monthlyTrend.map((row) => ({
              label: formatPurchaseStatisticsMonth(row.month),
              value: row.inspectionDefectOutcomeCount,
            })),
          },
        ]}
      />
      <Section
        title={t("monthly.amountTitle")}
        description={t("monthly.amountSubtitle")}
      >
        <CompactTable
          columns={[
            t("monthly.month"),
            { label: t("monthly.count"), align: "right" },
            { label: t("monthly.amount"), align: "right" },
            { label: t("monthly.priceConfirmed"), align: "right" },
            { label: t("monthly.priceMissing"), align: "right" },
            { label: t("monthly.supplierReturn"), align: "right" },
            { label: t("monthly.defect"), align: "right" },
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
  const t = useTranslations("statistics.purchase");
  const { formatAmount: formatPurchaseAmount, formatAveragePrice: formatPurchaseAveragePrice, formatRate: formatPurchaseRate } = usePurchaseStatisticsPresentation();
  const rows = data.productRows.map((row) => [
    row.model,
    row.storage,
    row.purchaseGrade,
    t("count", { count: row.purchaseCount }),
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
      title={t("product.title")}
      description={t("product.subtitle")}
    >
      <CompactTable
        columns={[
          t("product.model"), t("product.storage"), t("product.grade"),
          { label: t("product.purchase"), align: "right" },
          { label: t("product.amount"), align: "right" },
          { label: t("product.average"), align: "right" },
          { label: t("product.supplierReturnRate"), align: "right", wrap: true },
          { label: t("product.defectRate"), align: "right", wrap: true },
          { label: t("product.conversion30"), align: "right", wrap: true },
          { label: t("product.conversion60"), align: "right", wrap: true },
          { label: t("product.conversion90"), align: "right", wrap: true },
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
  const t = useTranslations("statistics.purchase");
  const { formatAmount: formatPurchaseAmount, formatAveragePrice: formatPurchaseAveragePrice, formatRate: formatPurchaseRate } = usePurchaseStatisticsPresentation();
  const rows = data.supplierRows.map((row) => [
    row.supplierName,
    t("count", { count: row.terminalOutcomeCount }),
    t("count", { count: row.purchaseCount }),
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
      title={t("supplier.title")}
      description={t("supplier.subtitle")}
    >
      <CompactTable
        columns={[
          t("supplier.supplier"),
          { label: t("supplier.terminal"), align: "right" },
          { label: t("supplier.purchase"), align: "right" },
          { label: t("supplier.amount"), align: "right" },
          { label: t("supplier.average"), align: "right" },
          { label: t("supplier.supplierReturnRate"), align: "right", wrap: true },
          { label: t("supplier.defectRate"), align: "right", wrap: true },
          { label: t("supplier.customerReturnRate"), align: "right", wrap: true },
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
  const t = useTranslations("statistics.purchase");
  const locale = useLocale();
  const { formatAdjustmentAmount: formatPurchaseAdjustmentAmount, formatAdjustmentPercent: formatPurchaseAdjustmentPercent, formatAmount: formatPurchaseAmount, formatAveragePrice: formatPurchaseAveragePrice } = usePurchaseStatisticsPresentation();
  const pricePolicyLabels = {
    RATE: t("pricePolicy.rate"),
    OVERRIDE: t("pricePolicy.override"),
    MANUAL: t("pricePolicy.manual"),
    UNKNOWN: t("pricePolicy.unknown"),
  } satisfies Record<PurchaseStatisticsData["pricePolicyRows"][number]["entryMode"], string>;
  const rows = data.pricePolicyRows.map((row) => [
    pricePolicyLabels[row.entryMode],
    t("count", { count: row.purchaseCount }),
    <PresentationValue
      key={`${row.entryMode}-amount`}
      metric={formatPurchaseAmount(row.purchaseAmount)}
    />,
    formatPurchaseAveragePrice(row.averagePurchasePrice),
    `${t("count", { count: row.referenceAvailableCount })} / ${row.referenceCoveragePercent}%`,
    <div key={`${row.entryMode}-adjustment`}>
      <div className="font-semibold tabular-nums">
        {formatPurchaseAdjustmentAmount(row.averageAdjustmentAmount)}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {formatPurchaseAdjustmentPercent(row.averageAdjustmentPercent)}
      </div>
    </div>,
    `${formatNumber(row.increasedCount, locale)} / ${formatNumber(
      row.unchangedCount,
      locale
    )} / ${formatNumber(row.decreasedCount, locale)}`,
  ]);

  return (
    <Section
      title={t("pricePolicy.title")}
      description={t("pricePolicy.subtitle")}
    >
      <CompactTable
        columns={[
          t("pricePolicy.mode"),
          { label: t("pricePolicy.purchase"), align: "right" },
          { label: t("pricePolicy.amount"), align: "right" },
          { label: t("pricePolicy.average"), align: "right" },
          { label: t("pricePolicy.reference"), align: "right", wrap: true },
          { label: t("pricePolicy.adjustment"), align: "right", wrap: true },
          { label: t("pricePolicy.direction"), align: "right", wrap: true },
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
  const t = useTranslations("statistics.purchase");
  const { formatRate: formatPurchaseRate } = usePurchaseStatisticsPresentation();
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
        title={t("inspection.title")}
        description={t("inspection.subtitle")}
      >
        <div className="grid gap-3">
          <SummaryTile
            icon={ClipboardCheck}
            label={t("inspection.defectRate")}
            value={defectRate.value}
            description={defectRate.detail}
            tone="warning"
          />
          <StatisticsCoverageItem
            label={t("inspection.sample")}
            value={t("count", { count: data.inspectionQuality.inspectedOutcomeCount })}
            description={t("inspection.sampleDescription", { count: data.inspectionQuality.defectOutcomeCount })}
          />
        </div>
      </Section>
      <Section
        title={t("inspection.appearance")}
        description={t("inspection.appearanceDescription")}
      >
        <BarList
          groups={data.inspectionQuality.appearanceDefects}
          total={appearanceTotal}
        />
      </Section>
      <Section
        title={t("inspection.function")}
        description={t("inspection.functionDescription")}
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
  const t = useTranslations("statistics.purchase");
  const { formatDuration: formatPurchaseDuration } = usePurchaseStatisticsPresentation();
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
      title={t("leadTime.title")}
      description={t("leadTime.subtitle")}
    >
      <div className="grid gap-2 md:grid-cols-3">
        <StatisticsCoverageItem
          label={t("leadTime.receivedToInspection")}
          value={receivedToInspection.value}
          description={receivedToInspection.detail}
        />
        <StatisticsCoverageItem
          label={t("leadTime.inspectionToOutcome")}
          value={inspectionToOutcome.value}
          description={inspectionToOutcome.detail}
        />
        <StatisticsCoverageItem
          label={t("leadTime.receivedToOutcome")}
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
  const t = useTranslations("statistics.purchase");
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
