"use client";

import * as React from "react";
import { RefreshCcw, RotateCcw, Search } from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import { ShipmentDeliverySearchDetailSheet } from "@/quickhack_client/components/shipment/shipment-delivery-search-detail-sheet";
import { todayKstDate } from "@/quickhack_shared/core/time";
import {
  SHIPMENT_DELIVERY_DATE_BASIS,
  SHIPMENT_DELIVERY_DATE_BASIS_LABELS,
  SHIPMENT_DELIVERY_STAGE,
  SHIPMENT_DELIVERY_STAGE_LABELS,
  type ShipmentDeliveryDateBasis,
  type ShipmentDeliverySearchDetail,
  type ShipmentDeliverySearchDetailResponse,
  type ShipmentDeliverySearchResponse,
  type ShipmentDeliverySearchRow,
  type ShipmentDeliveryStage,
} from "@/quickhack_shared/shipment/delivery-search";

type DeliverySearchFilters = {
  dateBasis: ShipmentDeliveryDateBasis;
  from: string;
  to: string;
  stage: ShipmentDeliveryStage | "ALL";
  carrier: "ALL" | "LOGEN";
  packing: "ALL" | "SINGLE" | "COMBINED";
  review: "ALL" | "REQUIRED";
  search: string;
};

type DeliverySearchColumnKey =
  | "status"
  | "invoice"
  | "order"
  | "productPackage"
  | "outbound"
  | "receiverRegion"
  | "latestTracking"
  | "lastActivity";

function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function defaultFilters(): DeliverySearchFilters {
  const to = todayKstDate();
  return {
    dateBasis: SHIPMENT_DELIVERY_DATE_BASIS.orderedAt,
    from: addDays(to, -29),
    to,
    stage: "ALL",
    carrier: "ALL",
    packing: "ALL",
    review: "ALL",
    search: "",
  };
}

function textOrDash(value: string | number | null | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized || "-";
}

function formatDateTime(value: string | null | undefined) {
  return textOrDash(value).replace("T", " ").slice(0, 19);
}

function stageVariant(stage: ShipmentDeliveryStage) {
  if (stage === SHIPMENT_DELIVERY_STAGE.delivered) return "success" as const;
  if (
    stage === SHIPMENT_DELIVERY_STAGE.exception ||
    stage === SHIPMENT_DELIVERY_STAGE.closed
  ) {
    return "danger" as const;
  }
  if (
    stage === SHIPMENT_DELIVERY_STAGE.onHold ||
    stage === SHIPMENT_DELIVERY_STAGE.preparing
  ) {
    return "warning" as const;
  }
  if (stage === SHIPMENT_DELIVERY_STAGE.inTransit) return "sky" as const;
  return "secondary" as const;
}

function activitySourceLabel(value: ShipmentDeliverySearchRow["lastActivitySource"]) {
  if (value === "TRACKING") return "배송 추적";
  if (value === "CARRIER") return "택배사 처리";
  if (value === "CHANNEL") return "쿠팡 처리";
  return "포장 정보";
}

function Filters({
  value,
  disabled,
  onChange,
  onApply,
  onReset,
}: {
  value: DeliverySearchFilters;
  disabled: boolean;
  onChange: (next: DeliverySearchFilters) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  function patch(next: Partial<DeliverySearchFilters>) {
    onChange({ ...value, ...next });
  }

  return (
    <form
      className="grid gap-2 rounded-md border bg-popover p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={value.dateBasis}
          onValueChange={(dateBasis) =>
            patch({ dateBasis: dateBasis as ShipmentDeliveryDateBasis })
          }
        >
          <SelectTrigger
            className="w-36"
            aria-label="배송 조회 기간 기준"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SHIPMENT_DELIVERY_DATE_BASIS_LABELS).map(
              ([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>
        <Input
          type="date"
          className="w-36"
          aria-label="배송 조회 시작일"
          value={value.from}
          onChange={(event) => patch({ from: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">~</span>
        <Input
          type="date"
          className="w-36"
          aria-label="배송 조회 종료일"
          value={value.to}
          onChange={(event) => patch({ to: event.target.value })}
        />
        <Select
          value={value.stage}
          onValueChange={(stage) =>
            patch({
              stage: stage as ShipmentDeliveryStage | "ALL",
            })
          }
        >
          <SelectTrigger className="w-36" aria-label="배송 상태">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 상태</SelectItem>
            {Object.entries(SHIPMENT_DELIVERY_STAGE_LABELS).map(
              ([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>
        <Select
          value={value.carrier}
          onValueChange={(carrier) =>
            patch({ carrier: carrier as DeliverySearchFilters["carrier"] })
          }
        >
          <SelectTrigger className="w-28" aria-label="택배사">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 택배사</SelectItem>
            <SelectItem value="LOGEN">로젠택배</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={value.packing}
          onValueChange={(packing) =>
            patch({ packing: packing as DeliverySearchFilters["packing"] })
          }
        >
          <SelectTrigger className="w-28" aria-label="포장 유형">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 포장</SelectItem>
            <SelectItem value="SINGLE">단일 포장</SelectItem>
            <SelectItem value="COMBINED">합포장</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={value.review}
          onValueChange={(review) =>
            patch({ review: review as DeliverySearchFilters["review"] })
          }
        >
          <SelectTrigger className="w-32" aria-label="확인 필요 여부">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 확인 상태</SelectItem>
            <SelectItem value="REQUIRED">확인 필요만</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative min-w-72 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={value.search}
            placeholder="주문번호, 묶음배송번호, 송장번호, PG, 수취인 검색"
            onChange={(event) => patch({ search: event.target.value })}
          />
        </div>
        <Button type="submit" disabled={disabled}>
          <Search className="size-4" />
          조회
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={onReset}
        >
          <RotateCcw className="size-4" />
          초기화
        </Button>
      </div>
    </form>
  );
}

export function ShipmentDeliverySearchView() {
  const initialFilters = React.useMemo(() => defaultFilters(), []);
  const [draftFilters, setDraftFilters] =
    React.useState<DeliverySearchFilters>(initialFilters);
  const [appliedFilters, setAppliedFilters] =
    React.useState<DeliverySearchFilters>(initialFilters);
  const [rows, setRows] = React.useState<ShipmentDeliverySearchRow[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [selectedPackageGroupId, setSelectedPackageGroupId] =
    React.useState<number | null>(null);
  const [detail, setDetail] =
    React.useState<ShipmentDeliverySearchDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState("");

  const loadPage = React.useCallback(
    async (
      filters: DeliverySearchFilters,
      cursor: string | null,
      append: boolean
    ) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setMessage("");

      try {
        const params = new URLSearchParams({
          dateBasis: filters.dateBasis,
          from: filters.from,
          to: filters.to,
          stage: filters.stage,
          carrier: filters.carrier,
          packing: filters.packing,
          review: filters.review,
          search: filters.search.trim(),
          limit: "100",
        });
        if (cursor) params.set("cursor", String(cursor));
        const response = await fetch(`/api/shipments/search?${params}`, {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as
          | ShipmentDeliverySearchResponse
          | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(
            payload?.message || "전체 배송 건을 불러오지 못했습니다."
          );
        }
        const nextRows = payload.items ?? [];
        setRows((current) => (append ? [...current, ...nextRows] : nextRows));
        setTotalCount(payload.totalCount ?? nextRows.length);
        setNextCursor(payload.nextCursor ?? null);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    []
  );

  React.useEffect(() => {
    const timerId = window.setTimeout(
      () => void loadPage(initialFilters, null, false),
      0
    );
    return () => window.clearTimeout(timerId);
  }, [initialFilters, loadPage]);

  const loadDetail = React.useCallback(async (packageGroupId: number) => {
    setDetailLoading(true);
    setDetailError("");
    try {
      const response = await fetch(
        `/api/shipments/search/${packageGroupId}`,
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as
        | ShipmentDeliverySearchDetailResponse
        | null;
      if (!response.ok || !payload?.ok || !payload.detail) {
        throw new Error(
          payload?.message || "배송 건 상세 정보를 불러오지 못했습니다."
        );
      }
      setDetail(payload.detail);
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  function applyFilters() {
    if (
      draftFilters.from &&
      draftFilters.to &&
      draftFilters.from > draftFilters.to
    ) {
      setMessage("조회 시작일은 종료일보다 늦을 수 없습니다.");
      return;
    }
    const next = { ...draftFilters, search: draftFilters.search.trim() };
    setAppliedFilters(next);
    setDetailOpen(false);
    setNextCursor(null);
    void loadPage(next, null, false);
  }

  function resetFilters() {
    const next = defaultFilters();
    setDraftFilters(next);
    setAppliedFilters(next);
    setDetailOpen(false);
    setNextCursor(null);
    void loadPage(next, null, false);
  }

  function openDetail(row: ShipmentDeliverySearchRow) {
    setSelectedPackageGroupId(row.packageGroupId);
    setDetail(null);
    setDetailError("");
    setDetailOpen(true);
    void loadDetail(row.packageGroupId);
  }

  const columns = React.useMemo<
    DataGridColumn<DeliverySearchColumnKey, ShipmentDeliverySearchRow>[]
  >(
    () => [
      {
        key: "status",
        label: "상태",
        width: "155px",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 py-2",
        render: (row) => (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <Badge variant={stageVariant(row.deliveryStage)}>
              {SHIPMENT_DELIVERY_STAGE_LABELS[row.deliveryStage]}
            </Badge>
            {row.reviewRequired ? (
              <Badge variant="warning">확인 필요 {row.reviewCount}</Badge>
            ) : row.channelStatuses.length > 0 ? (
              <span className="max-w-full truncate text-[11px] text-muted-foreground">
                쿠팡 {row.channelStatuses.join(", ")}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: "invoice",
        label: "송장",
        width: "175px",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-mono font-medium">
              {textOrDash(row.trackingNumber)}
            </div>
            <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <span>{row.carrierCode || "송장 미발급"}</span>
              {row.reissued ? (
                <Badge variant="purple">재발급 rev.{row.revisionNo}</Badge>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        key: "order",
        label: "주문",
        width: "175px",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate">{row.representativeOrderId}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {row.orderCount > 1 ? `외 ${row.orderCount - 1}건 · ` : ""}
              묶음배송 {row.shipmentBoxCount}건
            </div>
          </div>
        ),
      },
      {
        key: "productPackage",
        label: "상품·포장",
        width: "minmax(260px,1fr)",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        render: (row) => (
          <div className="min-w-0">
            <div className="line-clamp-2 break-words font-medium">
              {row.representativeProductName}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              <Badge
                variant={
                  row.packingType === "COMBINED" ? "orange" : "neutral"
                }
              >
                {row.packingType === "COMBINED"
                  ? `합포장 ${row.memberCount}개`
                  : "단일 포장"}
              </Badge>
              {row.splitShipment ? (
                <Badge variant="purple">분할배송</Badge>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        key: "outbound",
        label: "출고",
        width: "145px",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">
              {textOrDash(row.outboundBatchLabel)}
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {row.printLineNumbers.length
                ? `No. ${row.printLineNumbers.join(", ")}`
                : "출력 전"}
            </div>
          </div>
        ),
      },
      {
        key: "receiverRegion",
        label: "수취인·지역",
        width: "190px",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">
              {textOrDash(row.receiverName)}
            </div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              {[row.receiverPostCode, row.receiverRegion]
                .filter(Boolean)
                .join(" ")}
            </div>
          </div>
        ),
      },
      {
        key: "latestTracking",
        label: "최근 배송 현황",
        width: "205px",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">
              {textOrDash(row.latestTrackingStatus)}
            </div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              {textOrDash(row.latestBranchName)}
            </div>
          </div>
        ),
      },
      {
        key: "lastActivity",
        label: "최근 처리",
        width: "165px",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-mono">
              {formatDateTime(row.lastActivityAt)}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {activitySourceLabel(row.lastActivitySource)}
            </div>
          </div>
        ),
      },
    ],
    []
  );

  return (
    <WorkspacePageFrame className="gap-3 p-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">전체 배송 건 검색</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            물리 포장 단위로 송장 준비부터 배송 완료·종료 건까지 검색합니다.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={loading || loadingMore}
          onClick={() => void loadPage(appliedFilters, null, false)}
        >
          <RefreshCcw className="size-4" />
          새로고침
        </Button>
      </div>

      <Filters
        value={draftFilters}
        disabled={loading || loadingMore}
        onChange={setDraftFilters}
        onApply={applyFilters}
        onReset={resetFilters}
      />

      {message ? (
        <FeedbackBanner tone="danger" className="shrink-0">
          {message}
        </FeedbackBanner>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 items-center justify-between text-xs text-muted-foreground">
          <span>
            검색 결과 {totalCount.toLocaleString("ko-KR")}건 · 현재{" "}
            {rows.length.toLocaleString("ko-KR")}건 표시
          </span>
          <span>행을 클릭하면 배송 상세 이력을 확인할 수 있습니다.</span>
        </div>
        <VirtualizedDataGrid
          rows={rows}
          columns={columns}
          rowKey={(row) => row.packageGroupId}
          selectedRowKey={detailOpen ? selectedPackageGroupId : null}
          onRowClick={openDetail}
          emptyMessage={
            loading
              ? "전체 배송 건을 불러오는 중입니다."
              : "조건에 맞는 배송 건이 없습니다."
          }
          minWidth="1470px"
          rowHeight={72}
        />
        {nextCursor ? (
          <div className="shrink-0 text-center">
            <Button
              type="button"
              variant="outline"
              disabled={loadingMore}
              onClick={() =>
                void loadPage(appliedFilters, nextCursor, true)
              }
            >
              <RefreshCcw
                className={`size-4 ${loadingMore ? "animate-spin" : ""}`}
              />
              {loadingMore ? "불러오는 중" : "더 보기"}
            </Button>
          </div>
        ) : null}
      </div>

      <ShipmentDeliverySearchDetailSheet
        key={selectedPackageGroupId ?? "empty"}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onRetry={() => {
          if (selectedPackageGroupId) {
            void loadDetail(selectedPackageGroupId);
          }
        }}
      />
    </WorkspacePageFrame>
  );
}
