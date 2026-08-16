"use client";

import * as React from "react";
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
  buildInventoryTransitionMatrix,
  formatInventoryNumber,
  formatInventoryPeriodRange,
  formatInventoryPurchaseCost,
  formatInventoryQuantity,
  formatInventoryTurnover,
  inventoryAgeBucketLabel,
  inventoryIntegrityMessage,
  inventoryPeriodLabel,
  inventorySkuLabel,
  inventoryStatusGroupLabel,
} from "@/quickhack_client/components/statistics/inventory-statistics-presentation";
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

function quantityPercent(quantity: number | null, total: number | null) {
  if (quantity === null || total === null) {
    return "확인 불가";
  }

  return `${groupPercent(quantity, total)}%`;
}

function AsOfInventorySection({ data }: { data: InventoryStatisticsData }) {
  const message = inventoryIntegrityMessage(
    data.integrity.availability,
    "asOf"
  );
  const group = (key: InventoryStatisticsStatusGroupKey) =>
    data.asOf.groups.find((item) => item.key === key)?.quantity ?? null;
  const sellableQuantity = group("SELLABLE");
  const allocatedQuantity = group("ORDER_ALLOCATED");
  const restrictedQuantity = group("SALES_RESTRICTED");
  const longTermCost = formatInventoryPurchaseCost(
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
          label={`${data.asOf.date} 기준 전체 재고`}
          value={formatInventoryQuantity(data.asOf.totalQuantity)}
          description={`${data.asOf.date} 마감 기준`}
        />
        <SummaryTile
          icon={PackageCheck}
          label="판매 가능"
          value={formatInventoryQuantity(sellableQuantity)}
          description={quantityPercent(
            sellableQuantity,
            data.asOf.totalQuantity
          )}
          tone="success"
        />
        <SummaryTile
          icon={ShoppingCart}
          label="주문 배정"
          value={formatInventoryQuantity(allocatedQuantity)}
          description={quantityPercent(
            allocatedQuantity,
            data.asOf.totalQuantity
          )}
          tone="sky"
        />
        <SummaryTile
          icon={Warehouse}
          label="판매 제한·점검"
          value={formatInventoryQuantity(restrictedQuantity)}
          description={quantityPercent(
            restrictedQuantity,
            data.asOf.totalQuantity
          )}
          tone="warning"
        />
        <SummaryTile
          icon={TimerReset}
          label="장기 재고"
          value={formatInventoryQuantity(data.aging.longTermQuantity)}
          description="30일 이상 · 주문 배정 제외"
          tone="purple"
        />
        <SummaryTile
          icon={CircleDollarSign}
          label="장기 재고 매입원가"
          value={longTermCost.value}
          description={longTermCost.detail}
          tone="warning"
        />
      </div>

      <Section
        title={`${data.asOf.date} 기준 재고 상태 구성`}
        description="선택한 마감일의 모든 재고를 판매·출고·배송·클레임 의미에 따라 한 번씩만 분류합니다."
      >
        <CompactTable
          columns={[
            "상태 그룹",
            { label: "포함 상태", wrap: true },
            { label: "수량", align: "right" },
            { label: "비율", align: "right" },
          ]}
          gridTemplateColumns="minmax(180px,0.8fr) minmax(360px,2fr) minmax(100px,0.5fr) minmax(90px,0.45fr)"
          minWidth={780}
          rows={data.asOf.groups.map((item) => [
            inventoryStatusGroupLabel(item.key),
            item.statuses.map((status) => status.label).join(", "),
            formatInventoryQuantity(item.quantity),
            quantityPercent(item.quantity, data.asOf.totalQuantity),
          ])}
        />
      </Section>
    </div>
  );
}

function InventoryAgingSection({ data }: { data: InventoryStatisticsData }) {
  const { aging } = data;
  const message = inventoryIntegrityMessage(
    aging.integrity.availability,
    "aging"
  );
  const canShow =
    aging.integrity.availability === "READY" ||
    aging.integrity.availability === "EMPTY";

  return (
    <Section
      title="재고 연령과 장기 재고 부담"
      description={`${data.asOf.date} 마감 시점의 창고 보유 주기를 기준으로 하며 주문 배정 재고는 장기 재고에서 제외합니다.`}
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
        <EmptyDataState message="원장 보유 주기를 확인한 뒤 재고 연령을 표시합니다." />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {aging.buckets.map((bucket) => {
              const purchaseCost = formatInventoryPurchaseCost(
                bucket.purchaseCost
              );

              return (
                <StatisticsCoverageItem
                  key={bucket.key}
                  label={inventoryAgeBucketLabel(bucket.key)}
                  value={formatInventoryQuantity(bucket.quantity)}
                  description={`${purchaseCost.value} · ${purchaseCost.detail}`}
                />
              );
            })}
          </div>

          <CompactTable
            columns={[
              { label: "SKU / 상품", wrap: true },
              "등급",
              { label: "기준일 대상", align: "right" },
              { label: "장기 재고", align: "right" },
              { label: "0~29일", align: "right" },
              { label: "30~59일", align: "right" },
              { label: "60~89일", align: "right" },
              { label: "90일 이상", align: "right" },
              { label: "확인 매입원가", align: "right" },
              { label: "가격 미확인", align: "right" },
            ]}
            gridTemplateColumns="minmax(260px,1.7fr) minmax(70px,0.4fr) repeat(6,minmax(92px,0.55fr)) minmax(140px,0.8fr) minmax(110px,0.6fr)"
            minWidth={1280}
            maxHeight={440}
            emptyMessage="기준일에 장기 재고 대상 SKU가 없습니다."
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
                formatInventoryQuantity(row.quantity),
                formatInventoryQuantity(row.longTermQuantity),
                formatInventoryQuantity(bucketQuantity("DAYS_0_29")),
                formatInventoryQuantity(bucketQuantity("DAYS_30_59")),
                formatInventoryQuantity(bucketQuantity("DAYS_60_89")),
                formatInventoryQuantity(bucketQuantity("DAYS_90_PLUS")),
                formatInventoryPurchaseCost(row.purchaseCost).value,
                formatInventoryQuantity(row.purchaseCost.missingPriceQuantity),
              ];
            })}
          />
        </div>
      )}
    </Section>
  );
}

function InventoryPeriodSection({ data }: { data: InventoryStatisticsData }) {
  const { period } = data;
  const message = inventoryIntegrityMessage(
    period.integrity.availability,
    "period"
  );
  const turnover = formatInventoryTurnover(period.summary.turnover);
  const transitionMatrix = buildInventoryTransitionMatrix(period.transitions);
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
          label="판매 회전율"
          value={turnover.value}
          description={turnover.detail}
          tone="success"
        />
        <SummaryTile
          icon={ShoppingCart}
          label="판매 완료"
          value={formatInventoryQuantity(
            period.summary.salesCompletedQuantity
          )}
          description={inventoryPeriodLabel(period.preset)}
          tone="sky"
        />
        <SummaryTile
          icon={Warehouse}
          label="일평균 창고 재고"
          value={formatInventoryQuantity(
            period.summary.averageWarehouseQuantity
          )}
          description="KST 날짜별 마감 수량 평균"
          tone="purple"
        />
        <SummaryTile
          icon={ArrowDownToLine}
          label="신규 재고 유입"
          value={formatInventoryQuantity(
            period.summary.newInventoryQuantity
          )}
          description="최초 재고 생성"
        />
        <SummaryTile
          icon={RotateCcw}
          label="고객 반품 재입고"
          value={formatInventoryQuantity(
            period.summary.customerReturnReentryQuantity
          )}
          description="판매 후 창고 재진입"
          tone="warning"
        />
        <SummaryTile
          icon={ArrowDownToLine}
          label="기타 재입고"
          value={formatInventoryQuantity(
            period.summary.otherWarehouseReentryQuantity
          )}
          description="고객 반품 외 재진입"
          tone="sky"
        />
        <SummaryTile
          icon={ArrowUpFromLine}
          label="창고 이탈"
          value={formatInventoryQuantity(
            period.summary.warehouseExitQuantity
          )}
          description="배송·클레임 등 창고 외 이동"
          tone="purple"
        />
        <SummaryTile
          icon={Trash2}
          label="재고 삭제"
          value={formatInventoryQuantity(period.summary.removedQuantity)}
          description="원장에서 제거된 수량"
          tone="warning"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <MultiLineTrendChart
          title="일별 창고 재고와 판매"
          description="모든 날짜의 흐름은 유지하고 축 표시는 읽기 좋은 간격으로 줄입니다."
          maxAxisLabels={8}
          showPointMarkers={period.daily.length <= 60}
          valueFormatter={(value) => `${formatInventoryNumber(value)}대`}
          series={[
            {
              key: "closing",
              label: "창고 마감 재고",
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.closingWarehouseQuantity,
              })),
            },
            {
              key: "sales",
              label: "판매 완료",
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.salesCompletedQuantity,
              })),
            },
          ]}
        />
        <MultiLineTrendChart
          title="일별 재고 유입·이탈"
          description="신규 유입, 재입고와 창고 이탈·삭제를 같은 기간에서 비교합니다."
          maxAxisLabels={8}
          showPointMarkers={period.daily.length <= 60}
          valueFormatter={(value) => `${formatInventoryNumber(value)}대`}
          series={[
            {
              key: "new",
              label: "신규 유입",
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.newInventoryQuantity,
              })),
            },
            {
              key: "customer-return",
              label: "고객 반품 재입고",
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.customerReturnReentryQuantity,
              })),
            },
            {
              key: "other-return",
              label: "기타 재입고",
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.otherWarehouseReentryQuantity,
              })),
            },
            {
              key: "exit",
              label: "창고 이탈",
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.warehouseExitQuantity,
              })),
            },
            {
              key: "removed",
              label: "재고 삭제",
              points: period.daily.map((point, index) => ({
                label: dateLabels[index],
                value: point.removedQuantity,
              })),
            },
            {
              key: "sales",
              label: "판매 완료",
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
          title="재고 상태 이동"
          description="선택 기간에 발생한 상태 그룹 간 이동을 작업 단위로 집계합니다."
        >
          <CompactTable
            columns={transitionMatrix.columns.map((label, index) => ({
              label,
              align: index === 0 ? "left" : "right",
              wrap: index === 0,
            }))}
            minWidth={Math.max(760, transitionMatrix.columns.length * 125)}
            maxHeight={420}
            emptyMessage="선택 기간에 재고 상태 이동이 없습니다."
            rows={transitionMatrix.rows.map((row) =>
              row.map((value, index) =>
                index === 0 ? value : formatInventoryNumber(Number(value))
              )
            )}
          />
        </Section>

        <Section
          title="SKU별 판매 회전율"
          description="판매 완료 수량과 일평균 창고 재고를 같은 SKU 기준으로 비교합니다."
        >
          <CompactTable
            columns={[
              { label: "SKU / 상품", wrap: true },
              { label: "평균 재고", align: "right" },
              { label: "판매 완료", align: "right" },
              { label: "회전율", align: "right" },
            ]}
            gridTemplateColumns="minmax(300px,1.8fr) repeat(3,minmax(110px,0.65fr))"
            minWidth={720}
            maxHeight={420}
            emptyMessage="선택 기간에 SKU별 회전율을 표시할 데이터가 없습니다."
            rows={period.skuRows.map((row) => [
              <div key={row.skuCode}>
                <div className="font-medium">{row.skuCode}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {inventorySkuLabel(row)}
                </div>
              </div>,
              formatInventoryQuantity(row.averageWarehouseQuantity),
              formatInventoryQuantity(row.salesCompletedQuantity),
              formatInventoryTurnover(row.turnover).value,
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
  return (
    <Section
      title="집계 기준과 복원 범위"
      description="조회 기간과 마감 기준, 기준일 재고를 복원할 때 제외하거나 확인하지 못한 근거를 함께 표시합니다."
    >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <StatisticsCalculationScope calculation={data.calculation} />
        <StatisticsCoverageItem
          label="기준일 재고"
          value={formatInventoryQuantity(data.asOf.totalQuantity)}
          description={`재고 ${formatInventoryNumber(
            data.source.inventoryRowCount
          )}건 · 원장 ${formatInventoryNumber(
            data.source.balanceQuantity
          )}대`}
        />
        <StatisticsCoverageItem
          label="마감 이후 제외"
          value={`${formatInventoryNumber(
            data.source.cutoffExcludedMovementCount
          )}행`}
          description={`판매 ${formatInventoryNumber(
            data.source.cutoffExcludedSaleRecordCount
          )}건 제외`}
        />
        <StatisticsCoverageItem
          label="기준일 가격 근거"
          value={
            data.source.asOfPriceExcludedCount === 0
              ? "제외 없음"
              : `${formatInventoryNumber(
                  data.source.asOfPriceExcludedCount
                )}건 제외`
          }
          description={
            data.source.asOfReconstructionIssueCount === 0
              ? "재고 복원 검증 완료"
              : `복원 확인 필요 ${formatInventoryNumber(
                  data.source.asOfReconstructionIssueCount
                )}건`
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
              payload?.message || "재고 통계를 불러오지 못했습니다."
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
          재고 원장과 판매 원장을 집계하고 있습니다.
        </FeedbackBanner>
        <EmptyDataState message="재고 통계를 불러오는 중입니다." />
      </div>
    );
  }

  if (!visibleData && errorMessage) {
    return (
      <FeedbackBanner tone="danger">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">
              재고 통계를 불러오지 못했습니다.
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
    <div
      aria-busy={isLoading}
      className="grid min-w-0 gap-4"
    >
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

      <InventoryStatisticsScope data={visibleData} />
      <AsOfInventorySection data={visibleData} />
      <InventoryAgingSection data={visibleData} />
      <Section
        title={`${inventoryPeriodLabel(visibleData.period.preset)} 재고 흐름과 판매 회전율`}
        description={formatInventoryPeriodRange(
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
