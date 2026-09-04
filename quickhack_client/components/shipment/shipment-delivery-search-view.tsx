"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
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
  SHIPMENT_DELIVERY_STAGE,
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
  const t = useTranslations("shipment.deliverySearch");

  function dateBasisLabel(value: ShipmentDeliveryDateBasis) {
    if (value === "OUTBOUND_CONFIRMED_AT") return t("dateBasis.outboundConfirmed");
    if (value === "INVOICE_ALLOCATED_AT") return t("dateBasis.invoiceAllocated");
    if (value === "CARRIER_REGISTERED_AT") return t("dateBasis.carrierRegistered");
    if (value === "TRACKING_SCANNED_AT") return t("dateBasis.trackingScanned");
    return t("dateBasis.ordered");
  }

  function stageLabel(value: ShipmentDeliveryStage) {
    if (value === "INVOICE_ALLOCATED") return t("stage.invoiceAllocated");
    if (value === "REGISTERED") return t("stage.registered");
    if (value === "IN_TRANSIT") return t("stage.inTransit");
    if (value === "DELIVERED") return t("stage.delivered");
    if (value === "ON_HOLD") return t("stage.onHold");
    if (value === "EXCEPTION") return t("stage.exception");
    if (value === "CLOSED") return t("stage.closed");
    return t("stage.preparing");
  }

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
            aria-label={t("filters.dateBasis")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.values(SHIPMENT_DELIVERY_DATE_BASIS).map(
              (key) => (
                <SelectItem key={key} value={key}>
                  {dateBasisLabel(key)}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>
        <Input
          type="date"
          className="w-36"
          aria-label={t("filters.from")}
          value={value.from}
          onChange={(event) => patch({ from: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">~</span>
        <Input
          type="date"
          className="w-36"
          aria-label={t("filters.to")}
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
          <SelectTrigger className="w-36" aria-label={t("filters.allStages")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("filters.allStages")}</SelectItem>
            {Object.values(SHIPMENT_DELIVERY_STAGE).map(
              (key) => (
                <SelectItem key={key} value={key}>
                  {stageLabel(key)}
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
          <SelectTrigger className="w-28" aria-label={t("filters.carrier")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("filters.allCarriers")}</SelectItem>
            <SelectItem value="LOGEN">{t("filters.logen")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={value.packing}
          onValueChange={(packing) =>
            patch({ packing: packing as DeliverySearchFilters["packing"] })
          }
        >
          <SelectTrigger className="w-28" aria-label={t("filters.packing")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("filters.allPacking")}</SelectItem>
            <SelectItem value="SINGLE">{t("filters.single")}</SelectItem>
            <SelectItem value="COMBINED">{t("filters.combined")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={value.review}
          onValueChange={(review) =>
            patch({ review: review as DeliverySearchFilters["review"] })
          }
        >
          <SelectTrigger className="w-32" aria-label={t("filters.review")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("filters.allReview")}</SelectItem>
            <SelectItem value="REQUIRED">{t("filters.reviewOnly")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative min-w-72 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={value.search}
            placeholder={t("filters.searchPlaceholder")}
            onChange={(event) => patch({ search: event.target.value })}
          />
        </div>
        <Button type="submit" disabled={disabled}>
          <Search className="size-4" />
          {t("actions.apply")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={onReset}
        >
          <RotateCcw className="size-4" />
          {t("actions.reset")}
        </Button>
      </div>
    </form>
  );
}

export function ShipmentDeliverySearchView() {
  const t = useTranslations("shipment.deliverySearch");

  const stageLabel = React.useCallback((value: ShipmentDeliveryStage) => {
    if (value === "INVOICE_ALLOCATED") return t("stage.invoiceAllocated");
    if (value === "REGISTERED") return t("stage.registered");
    if (value === "IN_TRANSIT") return t("stage.inTransit");
    if (value === "DELIVERED") return t("stage.delivered");
    if (value === "ON_HOLD") return t("stage.onHold");
    if (value === "EXCEPTION") return t("stage.exception");
    if (value === "CLOSED") return t("stage.closed");
    return t("stage.preparing");
  }, [t]);

  const activitySourceLabel = React.useCallback((value: ShipmentDeliverySearchRow["lastActivitySource"]) => {
    if (value === "TRACKING") return t("activity.tracking");
    if (value === "CARRIER") return t("activity.carrier");
    if (value === "CHANNEL") return t("activity.channel");
    return t("activity.package");
  }, [t]);
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
            legacyApiMessage(payload, t("fallback.listLoadFailed"))
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
    [t]
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
          legacyApiMessage(payload, t("fallback.detailLoadFailed"))
        );
      }
      setDetail(payload.detail);
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  }, [t]);

  function applyFilters() {
    if (
      draftFilters.from &&
      draftFilters.to &&
      draftFilters.from > draftFilters.to
    ) {
      setMessage(t("validation.invalidDateRange"));
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
        label: t("columns.status"),
        width: "155px",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 py-2",
        render: (row) => (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <Badge variant={stageVariant(row.deliveryStage)}>
              {stageLabel(row.deliveryStage)}
            </Badge>
            {row.reviewRequired ? (
              <Badge variant="warning">{t("reviewCount", { count: row.reviewCount })}</Badge>
            ) : row.channelStatuses.length > 0 ? (
              <span className="max-w-full truncate text-[11px] text-muted-foreground">
                {t("values.channel")} {row.channelStatuses.join(", ")}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: "invoice",
        label: t("columns.invoice"),
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
              <span>{row.carrierCode || t("values.invoiceMissing")}</span>
              {row.reissued ? (
                <Badge variant="purple">{t("values.reissued", { revision: row.revisionNo ?? 0 })}</Badge>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        key: "order",
        label: t("columns.order"),
        width: "175px",
        sortable: false,
        filterable: false,
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate">{row.representativeOrderId}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {row.orderCount > 1 ? t("values.orderRemainder", { count: row.orderCount - 1 }) : ""}
              {t("values.shipmentBoxes", { count: row.shipmentBoxCount })}
            </div>
          </div>
        ),
      },
      {
        key: "productPackage",
        label: t("columns.productPackage"),
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
                  ? t("packing.combined", { count: row.memberCount })
                  : t("packing.single")}
              </Badge>
              {row.splitShipment ? (
                <Badge variant="purple">{t("packing.split")}</Badge>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        key: "outbound",
        label: t("columns.outbound"),
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
                : t("values.notPrinted")}
            </div>
          </div>
        ),
      },
      {
        key: "receiverRegion",
        label: t("columns.receiverRegion"),
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
        label: t("columns.latestTracking"),
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
        label: t("columns.lastActivity"),
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
    [activitySourceLabel, stageLabel, t]
  );

  return (
    <WorkspacePageFrame className="gap-3 p-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={loading || loadingMore}
          onClick={() => void loadPage(appliedFilters, null, false)}
        >
          <RefreshCcw className="size-4" />
          {t("actions.refresh")}
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
            {t("resultSummary", { total: totalCount, visible: rows.length })}
          </span>
          <span>{t("hint")}</span>
        </div>
        <VirtualizedDataGrid
          rows={rows}
          columns={columns}
          rowKey={(row) => row.packageGroupId}
          selectedRowKey={detailOpen ? selectedPackageGroupId : null}
          onRowClick={openDetail}
          emptyMessage={
            loading
              ? t("loading")
              : t("empty")
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
              {loadingMore ? t("actions.loading") : t("actions.loadMore")}
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
