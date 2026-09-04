"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  CircleDollarSign,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  TimerReset,
  Trash2,
  TrendingUp,
  Warehouse,
} from "lucide-react";
import {
  inventorySkuLabel,
  useInventoryStatisticsPresentation,
} from "@/quickhack_client/components/statistics/inventory-statistics-presentation";
import { statusLabel as deviceStatusLabel } from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  CompactTable,
  EmptyDataState,
  MultiLineTrendChart,
  StatisticsCoverageItem,
  SummaryTile,
  groupPercent,
} from "@/quickhack_client/components/statistics/statistics-visuals";
import { StatisticsCalculationScope } from "@/quickhack_client/components/statistics/statistics-calculation-scope";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { FormSection as Section } from "@/quickhack_client/components/ui/form-layout";
import type {
  InventoryStatisticsApiResponse,
  InventoryStatisticsData,
  InventoryStatisticsStatusGroupKey,
} from "@/quickhack_shared/statistics/statistics";
import {
  buildStatisticsPeriodRequestQuery,
  type StatisticsPeriodSelection,
} from "@/quickhack_shared/statistics/statistics-period";

function quantityPercent(
  quantity: number | null,
  total: number | null,
  unavailable: string
) {
  if (quantity === null || total === null) {
    return unavailable;
  }

  return `${groupPercent(quantity, total)}%`;
}

function AsOfInventorySection({ data }: { data: InventoryStatisticsData }) {
  const t = useTranslations("statistics.inventory");
  const detailT = useTranslations("common.deviceDetail");
  const {
    formatPurchaseCost,
    formatQuantity,
    integrityMessage,
    statusLabel,
  } = useInventoryStatisticsPresentation();
  const message = integrityMessage(
    data.integrity.availability,
    "asOf"
  );
  const group = (key: InventoryStatisticsStatusGroupKey) =>
    data.asOf.groups.find((item) => item.key === key)?.quantity ?? null;
  const sellableQuantity = group("SELLABLE");
  const allocatedQuantity = group("ORDER_ALLOCATED");
  const restrictedQuantity = group("SALES_RESTRICTED");
  const longTermCost = formatPurchaseCost(
    data.aging.longTermPurchaseCost
  );

  return (
    <div className="grid gap-4">
      {message ? (
        <FeedbackBanner
          tone={
            data.integrity.availability === "EMPTY" ? "neutral" : "warning"
          }
          size="xs"
        >
          {message}
        </FeedbackBanner>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <SummaryTile
          icon={Boxes}
          label={t("asOf.total", { date: data.asOf.date })}
          value={formatQuantity(data.asOf.totalQuantity)}
          description={t("asOf.closing", { date: data.asOf.date })}
        />
        <SummaryTile
          icon={PackageCheck}
          label={t("asOf.sellable")}
          value={formatQuantity(sellableQuantity)}
          description={quantityPercent(
            sellableQuantity,
            data.asOf.totalQuantity,
            t("unavailable.confirm")
          )}
          tone="success"
        />
        <SummaryTile
          icon={ShoppingCart}
          label={t("asOf.allocated")}
          value={formatQuantity(allocatedQuantity)}
          description={quantityPercent(
            allocatedQuantity,
            data.asOf.totalQuantity,
            t("unavailable.confirm")
          )}
          tone="sky"
        />
        <SummaryTile
          icon={Warehouse}
          label={t("asOf.restricted")}
          value={formatQuantity(restrictedQuantity)}
          description={quantityPercent(
            restrictedQuantity,
            data.asOf.totalQuantity,
            t("unavailable.confirm")
          )}
          tone="warning"
        />
        <SummaryTile
          icon={TimerReset}
          label={t("asOf.longTerm")}
          value={formatQuantity(data.aging.longTermQuantity)}
          description={t("asOf.longTermDescription")}
          tone="purple"
        />
        <SummaryTile
          icon={CircleDollarSign}
          label={t("asOf.longTermCost")}
          value={longTermCost.value}
          description={longTermCost.detail}
          tone="warning"
        />
      </div>

      <Section
        title={t("asOf.composition", { date: data.asOf.date })}
        description={t("asOf.compositionDescription")}
      >
        <CompactTable
          columns={[
            t("asOf.group"),
            { label: t("asOf.included"), wrap: true },
            { label: t("asOf.quantity"), align: "right" },
            { label: t("asOf.ratio"), align: "right" },
          ]}
          gridTemplateColumns="minmax(180px,0.8fr) minmax(360px,2fr) minmax(100px,0.5fr) minmax(90px,0.45fr)"
          minWidth={780}
          rows={data.asOf.groups.map((item) => [
            statusLabel(item.key),
            item.statuses
              .map((status) => deviceStatusLabel(status.status, detailT))
              .join(", "),
            formatQuantity(item.quantity),
            quantityPercent(item.quantity, data.asOf.totalQuantity, t("unavailable.confirm")),
          ])}
        />
      </Section>
    </div>
  );
}

function InventoryAgingSection({ data }: { data: InventoryStatisticsData }) {
  const t = useTranslations("statistics.inventory");
  const {
    ageLabel,
    formatPurchaseCost,
    formatQuantity,
    integrityMessage,
  } = useInventoryStatisticsPresentation();
  const { aging } = data;
  const message = integrityMessage(
    aging.integrity.availability,
    "aging"
  );
  const canShow =
    aging.integrity.availability === "READY" ||
    aging.integrity.availability === "EMPTY";

  return (
    <Section
      title={t("aging.title")}
      description={t("aging.description", { date: data.asOf.date })}
    >
      {message ? (
        <FeedbackBanner
          tone={aging.integrity.availability === "EMPTY" ? "neutral" : "warning"}
          size="xs"
        >
          {message}
        </FeedbackBanner>
      ) : null}

      {!canShow ? (
        <EmptyDataState message={t("aging.pending")} />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {aging.buckets.map((bucket) => {
              const purchaseCost = formatPurchaseCost(
                bucket.purchaseCost
              );

              return (
                <StatisticsCoverageItem
                  key={bucket.key}
                  label={ageLabel(bucket.key)}
                  value={formatQuantity(bucket.quantity)}
                  description={`${purchaseCost.value} · ${purchaseCost.detail}`}
                />
              );
            })}
          </div>

          <CompactTable
            columns={[
              { label: t("aging.sku"), wrap: true },
              t("aging.grade"),
              { label: t("aging.target"), align: "right" },
              { label: t("aging.longTerm"), align: "right" },
              { label: t("age.days0_29"), align: "right" },
              { label: t("age.days30_59"), align: "right" },
              { label: t("age.days60_89"), align: "right" },
              { label: t("age.days90Plus"), align: "right" },
              { label: t("aging.cost"), align: "right" },
              { label: t("aging.missingPrice"), align: "right" },
            ]}
            gridTemplateColumns="minmax(260px,1.7fr) minmax(70px,0.4fr) repeat(6,minmax(92px,0.55fr)) minmax(140px,0.8fr) minmax(110px,0.6fr)"
            minWidth={1280}
            maxHeight={440}
            emptyMessage={t("aging.empty")}
            rows={aging.skuRows.map((row) => {
              const bucketQuantity = (key: typeof row.ageBuckets[number]["key"]) =>
                row.ageBuckets.find((bucket) => bucket.key === key)?.quantity ??
                null;

              return [
                <div key={row.skuCode}>
                  <div className="font-medium">{row.skuCode}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {inventorySkuLabel(row)}
                  </div>
                </div>,
                row.saleGrade || "-",
                formatQuantity(row.quantity),
                formatQuantity(row.longTermQuantity),
                formatQuantity(bucketQuantity("DAYS_0_29")),
                formatQuantity(bucketQuantity("DAYS_30_59")),
                formatQuantity(bucketQuantity("DAYS_60_89")),
                formatQuantity(bucketQuantity("DAYS_90_PLUS")),
                formatPurchaseCost(row.purchaseCost).value,
                formatQuantity(row.purchaseCost.missingPriceQuantity),
              ];
            })}
          />
        </div>
      )}
    </Section>
  );
}

function InventoryPeriodSection({ data }: { data: InventoryStatisticsData }) {
  const t = useTranslations("statistics.inventory");
  const {
    buildTransitionMatrix,
    formatNumber,
    formatQuantity,
    formatTurnover,
    integrityMessage,
    periodLabel,
  } = useInventoryStatisticsPresentation();
  const { period } = data;
  const message = integrityMessage(
    period.integrity.availability,
    "period"
  );
  const turnover = formatTurnover(period.summary.turnover);
  const transitionMatrix = buildTransitionMatrix(period.transitions);
  const dateLabels = period.daily.map((point) => point.date.slice(5));

  return (
    <div className="grid gap-4">
      {message ? (
        <FeedbackBanner
          tone={period.integrity.availability === "EMPTY" ? "neutral" : "warning"}
          size="xs"
        >
          {message}
        </FeedbackBanner>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          icon={TrendingUp}
          label={t("flow.turnover")}
          value={turnover.value}
          description={turnover.detail}
          tone="success"
        />
        <SummaryTile
          icon={ShoppingCart}
          label={t("flow.sold")}
          value={formatQuantity(
            period.summary.salesCompletedQuantity
          )}
          description={periodLabel(period.preset)}
          tone="sky"
        />
        <SummaryTile
          icon={Warehouse}
          label={t("flow.averageInventory")}
          value={formatQuantity(
            period.summary.averageWarehouseQuantity
          )}
          description={t("flow.averageDescription")}
          tone="purple"
        />
        <SummaryTile
          icon={ArrowDownToLine}
          label={t("flow.newInventory")}
          value={formatQuantity(
            period.summary.newInventoryQuantity
          )}
          description={t("flow.newDescription")}
        />
        <SummaryTile
          icon={RotateCcw}
          label={t("flow.customerReturn")}
          value={formatQuantity(
            period.summary.customerReturnReentryQuantity
          )}
          description={t("flow.customerReturnDescription")}
          tone="warning"
        />
        <SummaryTile
          icon={ArrowDownToLine}
          label={t("flow.otherReturn")}
          value={formatQuantity(
            period.summary.otherWarehouseReentryQuantity
          )}
          description={t("flow.otherReturnDescription")}
          tone="sky"
        />
        <SummaryTile
          icon={ArrowUpFromLine}
          label={t("flow.exit")}
          value={formatQuantity(
            period.summary.warehouseExitQuantity
          )}
          description={t("flow.exitDescription")}
          tone="purple"
        />
        <SummaryTile
          icon={Trash2}
          label={t("flow.removed")}
          value={formatQuantity(period.summary.removedQuantity)}
          description={t("flow.removedDescription")}
          tone="warning"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <MultiLineTrendChart
          title={t("flow.closingChart")}
          description={t("flow.closingChartDescription")}
          maxAxisLabels={8}
          showPointMarkers={period.daily.length <= 60}
          valueFormatter={(value) => formatQuantity(value)}
          series={[
            {
              key: "closing",
              label: t("flow.closing"),
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.closingWarehouseQuantity,
              })),
            },
            {
              key: "sales",
              label: t("flow.sold"),
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.salesCompletedQuantity,
              })),
            },
          ]}
        />
        <MultiLineTrendChart
          title={t("flow.movementChart")}
          description={t("flow.movementChartDescription")}
          maxAxisLabels={8}
          showPointMarkers={period.daily.length <= 60}
          valueFormatter={(value) => formatQuantity(value)}
          series={[
            {
              key: "new",
              label: t("flow.new"),
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.newInventoryQuantity,
              })),
            },
            {
              key: "customer-return",
              label: t("flow.customerReturn"),
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.customerReturnReentryQuantity,
              })),
            },
            {
              key: "other-return",
              label: t("flow.otherReturn"),
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.otherWarehouseReentryQuantity,
              })),
            },
            {
              key: "exit",
              label: t("flow.exit"),
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.warehouseExitQuantity,
              })),
            },
            {
              key: "removed",
              label: t("flow.removed"),
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.removedQuantity,
              })),
            },
            {
              key: "sales",
              label: t("flow.sold"),
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.salesCompletedQuantity,
              })),
            },
          ]}
        />
      </div>

      <div className="grid gap-4 2xl:grid-cols-2">
        <Section
          title={t("flow.transition")}
          description={t("flow.transitionDescription")}
        >
          <CompactTable
            columns={transitionMatrix.columns.map((label, index) => ({
              label,
              align: index === 0 ? "left" : "right",
              wrap: index === 0,
            }))}
            minWidth={Math.max(760, transitionMatrix.columns.length * 125)}
            maxHeight={420}
            emptyMessage={t("flow.noTransition")}
            rows={transitionMatrix.rows.map((row) =>
              row.map((value, index) =>
                index === 0 ? value : formatNumber(Number(value))
              )
            )}
          />
        </Section>

        <Section
          title={t("flow.skuTurnover")}
          description={t("flow.skuTurnoverDescription")}
        >
          <CompactTable
            columns={[
              { label: t("flow.sku"), wrap: true },
              { label: t("flow.average"), align: "right" },
              { label: t("flow.sold"), align: "right" },
              { label: t("flow.turnover"), align: "right" },
            ]}
            gridTemplateColumns="minmax(300px,1.8fr) repeat(3,minmax(110px,0.65fr))"
            minWidth={720}
            maxHeight={420}
            emptyMessage={t("flow.emptySku")}
            rows={period.skuRows.map((row) => [
              <div key={row.skuCode}>
                <div className="font-medium">{row.skuCode}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {inventorySkuLabel(row)}
                </div>
              </div>,
              formatQuantity(row.averageWarehouseQuantity),
              formatQuantity(row.salesCompletedQuantity),
              formatTurnover(row.turnover).value,
            ])}
          />
        </Section>
      </div>
    </div>
  );
}

function InventoryStatisticsScope({
  data,
}: {
  data: InventoryStatisticsData;
}) {
  const t = useTranslations("statistics.inventory");
  const { formatQuantity } = useInventoryStatisticsPresentation();
  return (
    <Section
      title={t("scope.title")}
      description={t("scope.description")}
    >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <StatisticsCalculationScope calculation={data.calculation} />
        <StatisticsCoverageItem
          label={t("scope.asOf")}
          value={formatQuantity(data.asOf.totalQuantity)}
          description={t("scope.asOfDescription", { inventory: data.source.inventoryRowCount, ledger: data.source.balanceQuantity })}
        />
        <StatisticsCoverageItem
          label={t("scope.cutoff")}
          value={t("scope.cutoffValue", { count: data.source.cutoffExcludedMovementCount })}
          description={t("scope.cutoffDescription", { count: data.source.cutoffExcludedSaleRecordCount })}
        />
        <StatisticsCoverageItem
          label={t("scope.price")}
          value={
            data.source.asOfPriceExcludedCount === 0
              ? t("scope.noneExcluded")
              : t("scope.excluded", { count: data.source.asOfPriceExcludedCount })
          }
          description={
            data.source.asOfReconstructionIssueCount === 0
              ? t("scope.reconstructionComplete")
              : t("scope.reconstructionNeeded", { count: data.source.asOfReconstructionIssueCount })
          }
        />
      </div>
    </Section>
  );
}

export function InventoryStatisticsPanel({
  periodSelection,
}: {
  periodSelection: StatisticsPeriodSelection;
}) {
  const t = useTranslations("statistics.inventory");
  const { formatPeriodRange, periodLabel } = useInventoryStatisticsPresentation();
  const requestKey =
    buildStatisticsPeriodRequestQuery(periodSelection);
  const [requestState, setRequestState] = React.useState<{
    requestKey: string | null;
    data: InventoryStatisticsData | null;
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
        `/api/statistics/inventory${
          requestKey ? `?${requestKey}` : ""
        }`,
        {
          cache: "no-store",
          signal: controller.signal,
        }
      )
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as
            | InventoryStatisticsApiResponse
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
          {t("loading.aggregating")}
        </FeedbackBanner>
        <EmptyDataState message={t("loading.initial")} />
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
    <div
      aria-busy={isLoading}
      className="grid min-w-0 gap-4"
    >
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

      <InventoryStatisticsScope data={visibleData} />
      <AsOfInventorySection data={visibleData} />
      <InventoryAgingSection data={visibleData} />
      <Section
        title={t("period.sectionTitle", { period: periodLabel(visibleData.period.preset) })}
        description={formatPeriodRange(
          visibleData.period.fromDate,
          visibleData.period.toDate,
          visibleData.period.dayCount
        )}
      >
        <InventoryPeriodSection data={visibleData} />
      </Section>
    </div>
  );
}
