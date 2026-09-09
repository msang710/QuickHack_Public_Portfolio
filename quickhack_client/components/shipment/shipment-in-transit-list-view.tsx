"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import {
  DescriptionList,
  DescriptionRow,
} from "@/quickhack_client/components/ui/description-list";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/quickhack_client/components/ui/sheet";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import { statusLabel } from "@/quickhack_client/components/shared/device-detail-sheet";

type TrackingMember = {
  allocationId: number;
  memberSequence: number;
  pgNo: string;
  uniqueNo: string;
  model: string;
  storage: string | null;
  color: string | null;
  saleGrade: string | null;
  inventoryStatus: string | null;
  externalOrderId: string;
  externalShipmentId: string;
  channelStatus: string | null;
  productName: string;
  shipmentBatchText: string;
};

type TrackingEvent = {
  id: number;
  scanDate: string | null;
  scanTime: string | null;
  statusName: string;
  branchCode: string | null;
  branchName: string | null;
  salesOfficeCode: string | null;
  salesOfficeName: string | null;
  recipientTypeName: string | null;
};

type TrackingReview = {
  id: number;
  operationType: string;
  reason: string | null;
  error: string | null;
  status: string;
  updatedAt: string;
};

type TrackingRow = {
  id: number;
  packageGroupId: number;
  groupStatus: string;
  carrierShipmentId: number;
  carrierCode: string;
  trackingNumber: string;
  carrierStatus: string;
  carrierRegisteredAt: string | null;
  lastTrackedAt: string | null;
  latestStatusName: string | null;
  latestScanDate: string | null;
  latestScanTime: string | null;
  latestBranchName: string | null;
  receiverName: string;
  receiverSafeNumber: string;
  receiverAddress: string;
  packageCount: number;
  memberCount: number;
  externalOrderIds: string;
  externalShipmentIds: string;
  channelStatusText: string;
  productText: string;
  pgText: string;
  uniqueNoText: string;
  inventoryStatusText: string;
  shipmentBatchText: string;
  reviewRequired: boolean;
  members: TrackingMember[];
  reviews: TrackingReview[];
};

type TrackingApiResponse = {
  ok: boolean;
  message?: string;
  summary?: {
    packageGroupCount: number;
    memberCount: number;
    inTransitCount: number;
    exceptionCount: number;
    reviewRequiredCount: number;
  };
  items?: TrackingRow[];
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
};

type TrackingEventPageResponse = {
  ok: boolean;
  message?: string;
  items?: TrackingEvent[];
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
};

type TrackingColumnKey =
  | "carrierStatus"
  | "latestStatus"
  | "lastTrackedAt"
  | "trackingNumber"
  | "shipmentBatch"
  | "inventoryStatus"
  | "pg"
  | "externalOrderId"
  | "product"
  | "channelStatus"
  | "receiverName"
  | "receiverAddress";

function textOrDash(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return text || "-";
}

function formatDateTime(value: string | null | undefined) {
  return textOrDash(value).replace("T", " ").slice(0, 19);
}

function formatScanDateTime(
  scanDate: string | null | undefined,
  scanTime: string | null | undefined
) {
  const date = String(scanDate ?? "").replace(/\D/g, "");
  const time = String(scanTime ?? "").replace(/\D/g, "");
  if (date.length !== 8) return "-";
  const formattedDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  if (time.length < 4) return formattedDate;
  return `${formattedDate} ${time.slice(0, 2)}:${time.slice(2, 4)}${
    time.length >= 6 ? `:${time.slice(4, 6)}` : ""
  }`;
}

function MultiLineText({ value }: { value: string | null | undefined }) {
  return (
    <span className="whitespace-pre-line break-words leading-4">
      {textOrDash(value)}
    </span>
  );
}

type InTransitTranslator = ReturnType<typeof useTranslations<"shipment.inTransit">>;

function carrierStatusLabel(value: string | null | undefined, t: InTransitTranslator) {
  if (value === "REGISTERED") return t("status.registered");
  if (value === "IN_TRANSIT") return t("status.inTransit");
  if (value === "DELIVERED") return t("status.delivered");
  if (value === "EXCEPTION") return t("status.exception");
  return textOrDash(value);
}

function CarrierStatusBadge({ row }: { row: TrackingRow }) {
  const t = useTranslations("shipment.inTransit");
  const variant =
    row.carrierStatus === "EXCEPTION"
      ? "danger"
      : row.carrierStatus === "IN_TRANSIT"
        ? "sky"
        : "neutral";
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant={variant}>{carrierStatusLabel(row.carrierStatus, t)}</Badge>
      {row.reviewRequired ? (
        <Badge variant="warning">{t("reviewRequired")}</Badge>
      ) : null}
    </div>
  );
}

function InventoryStatusBadges({ value }: { value: string }) {
  const detailT = useTranslations("common.deviceDetail");
  const statuses = Array.from(
    new Set(
      value
        .split("\n")
        .map((status) => status.trim())
        .filter(Boolean)
    )
  );
  if (statuses.length === 0) return <span>-</span>;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {statuses.map((status) => (
        <Badge
          key={status}
          variant={status === "NONE_TRACKING" ? "danger" : "secondary"}
        >
          {statusLabel(status, detailT)}
        </Badge>
      ))}
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <DescriptionRow
      label={label}
      value={value}
      className="py-2.5"
      valueClassName="whitespace-pre-line"
    />
  );
}

function TrackingDetailSheet({
  row,
  open,
  onOpenChange,
}: {
  row: TrackingRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("shipment.inTransit");
  const detailT = useTranslations("common.deviceDetail");
  const [trackingEvents, setTrackingEvents] = React.useState<TrackingEvent[]>([]);
  const [trackingCursor, setTrackingCursor] = React.useState<string | null>(null);
  const [trackingTotal, setTrackingTotal] = React.useState(0);
  const [trackingLoading, setTrackingLoading] = React.useState(false);
  const [trackingError, setTrackingError] = React.useState("");
  const carrierShipmentId = row?.carrierShipmentId ?? null;
  const loadTrackingEvents = React.useCallback(async (
    cursor: string | null,
    append: boolean,
    signal?: AbortSignal
  ) => {
    if (!carrierShipmentId) return;
    if (!append) {
      setTrackingEvents([]);
      setTrackingCursor(null);
      setTrackingTotal(0);
    }
    setTrackingLoading(true);
    setTrackingError("");
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(
        `/api/shipments/tracking-events/${carrierShipmentId}?${params.toString()}`,
        { cache: "no-store", signal }
      );
      const payload = (await response.json().catch(() => null)) as
        | TrackingEventPageResponse
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("fallback.trackingLoadFailed")));
      }
      const next = payload.items ?? [];
      setTrackingEvents((current) => append ? [...current, ...next] : next);
      setTrackingCursor(payload.hasMore ? payload.nextCursor ?? null : null);
      setTrackingTotal(payload.totalCount ?? next.length);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setTrackingError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted) setTrackingLoading(false);
    }
  }, [carrierShipmentId, t]);

  React.useEffect(() => {
    if (!open || !carrierShipmentId) return;
    const controller = new AbortController();
    const timerId = window.setTimeout(() => {
      void loadTrackingEvents(null, false, controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [carrierShipmentId, loadTrackingEvents, open]);

  if (!row) return null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-center gap-2 pr-8">
            <SheetTitle>{row.trackingNumber}</SheetTitle>
            <CarrierStatusBadge row={row} />
          </div>
          <SheetDescription>
            {t("detail.packageSummary", {
              group: row.packageGroupId,
              members: row.memberCount,
            })}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {row.reviews.length > 0 ? (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                <AlertTriangle className="size-4" />
                {t("detail.autoReview")}
              </div>
              {row.reviews.map((review) => (
                <div key={review.id} className="mt-2 border-t border-amber-200 pt-2 first:mt-0 first:border-0 first:pt-0">
                  <div>{review.reason || review.operationType}</div>
                  {review.error ? (
                    <div className="mt-1 break-words text-xs text-red-700">
                      {review.error}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <h3 className="mb-2 text-sm font-semibold">{t("detail.summary")}</h3>
          <DescriptionList className="mb-5 rounded-md border bg-background px-4">
            <DetailRow label={t("detail.carrier")} value={row.carrierCode} />
            <DetailRow label={t("detail.currentStatus")} value={carrierStatusLabel(row.carrierStatus, t)} />
            <DetailRow label={t("detail.latestScan")} value={row.latestStatusName} />
            <DetailRow label={t("detail.scanLocation")} value={row.latestBranchName} />
            <DetailRow
              label={t("detail.scanAt")}
              value={formatScanDateTime(row.latestScanDate, row.latestScanTime)}
            />
            <DetailRow label={t("detail.lastTracked")} value={formatDateTime(row.lastTrackedAt)} />
            <DetailRow label={t("detail.receiver")} value={`${row.receiverName} / ${row.receiverSafeNumber}`} />
            <DetailRow label={t("detail.address")} value={row.receiverAddress} />
          </DescriptionList>

          <h3 className="mb-2 text-sm font-semibold">{t("detail.events")}</h3>
          <div className="mb-5 overflow-hidden rounded-md border bg-background">
            {trackingEvents.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t("detail.eventsEmpty")}
              </div>
            ) : (
              trackingEvents.map((event) => (
                <div key={event.id} className="grid grid-cols-[145px_110px_minmax(0,1fr)] gap-3 border-b px-4 py-3 text-sm last:border-b-0">
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatScanDateTime(event.scanDate, event.scanTime)}
                  </span>
                  <span className="font-medium">{event.statusName}</span>
                  <span className="truncate text-muted-foreground">
                    {event.branchName || event.salesOfficeName || "-"}
                    {event.recipientTypeName ? ` / ${event.recipientTypeName}` : ""}
                  </span>
                </div>
              ))
            )}
          </div>

          <h3 className="mb-2 text-sm font-semibold">{t("detail.members")}</h3>
          <div className="overflow-hidden rounded-md border bg-background">
            {row.members.map((member) => (
              <div key={member.allocationId} className="border-b px-4 py-3 text-sm last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{member.pgNo}</span>
                  <Badge variant={member.inventoryStatus === "NONE_TRACKING" ? "danger" : "secondary"}>
                    {statusLabel(member.inventoryStatus ?? "", detailT)}
                  </Badge>
                  <span className="text-muted-foreground">{member.uniqueNo}</span>
                </div>
                <div className="mt-1 break-words text-muted-foreground">
                  {t("detail.order", {
                    orderId: member.externalOrderId,
                    product: member.productName,
                  })}
                </div>
              </div>
            ))}
          </div>
          {trackingError ? (
            <FeedbackBanner tone="warning" className="mt-3">
              {trackingError}
            </FeedbackBanner>
          ) : null}
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {t("detail.eventsSummary", {
                loaded: trackingEvents.length,
                total: trackingTotal,
              })}
            </span>
            {trackingCursor ? (
              <Button
                size="sm"
                variant="outline"
                disabled={trackingLoading}
                onClick={() => void loadTrackingEvents(trackingCursor, true)}
              >
                {trackingLoading ? t("actions.loading") : t("actions.loadMore")}
              </Button>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function ShipmentInTransitListView() {
  const t = useTranslations("shipment.inTransit");
  const [rows, setRows] = React.useState<TrackingRow[]>([]);
  const [summary, setSummary] = React.useState<TrackingApiResponse["summary"]>();
  const [selectedRow, setSelectedRow] = React.useState<TrackingRow | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState("");

  const loadRows = React.useCallback(async (
    cursor: string | null = null,
    append = false
  ) => {
    if (append) setIsLoadingMore(true);
    else setIsLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/shipments/in-transit?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | TrackingApiResponse
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("fallback.listLoadFailed")));
      }
      const nextRows = payload.items ?? [];
      setRows((current) => append ? [...current, ...nextRows] : nextRows);
      setSummary(payload.summary);
      setNextCursor(payload.hasMore ? payload.nextCursor ?? null : null);
      setSelectedRow((current) =>
        current
          ? nextRows.find((row) => row.id === current.id) ?? (append ? current : null)
          : null
      );
    } catch (error) {
      if (!append) {
        setRows([]);
        setSummary(undefined);
        setSelectedRow(null);
        setNextCursor(null);
      }
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (append) setIsLoadingMore(false);
      else setIsLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => void loadRows(), 0);
    return () => window.clearTimeout(timerId);
  }, [loadRows]);

  const columns = React.useMemo<
    DataGridColumn<TrackingColumnKey, TrackingRow>[]
  >(
    () => [
      {
        key: "carrierStatus",
        label: t("columns.carrierStatus"),
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) =>
          `${row.carrierStatus} ${row.reviewRequired ? t("reviewRequired") : ""}`,
        render: (row) => <CarrierStatusBadge row={row} />,
      },
      {
        key: "latestStatus",
        label: t("columns.latestScan"),
        width: "130px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => `${row.latestStatusName ?? ""} ${row.latestBranchName ?? ""}`,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{textOrDash(row.latestStatusName)}</div>
            <div className="truncate text-muted-foreground">{textOrDash(row.latestBranchName)}</div>
          </div>
        ),
      },
      {
        key: "lastTrackedAt",
        label: t("columns.lastTracked"),
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => formatDateTime(row.lastTrackedAt),
        render: (row) => <span>{formatDateTime(row.lastTrackedAt)}</span>,
      },
      {
        key: "trackingNumber",
        label: t("columns.trackingNumber"),
        width: "135px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.trackingNumber,
        render: (row) => <span>{row.trackingNumber}</span>,
      },
      {
        key: "shipmentBatch",
        label: t("columns.shipmentBatch"),
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.shipmentBatchText,
        render: (row) => <MultiLineText value={row.shipmentBatchText} />,
      },
      {
        key: "inventoryStatus",
        label: t("columns.inventoryStatus"),
        width: "130px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => row.inventoryStatusText,
        render: (row) => <InventoryStatusBadges value={row.inventoryStatusText} />,
      },
      {
        key: "pg",
        label: "PG",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.pgText,
        render: (row) => <MultiLineText value={row.pgText} />,
      },
      {
        key: "externalOrderId",
        label: t("columns.orderId"),
        width: "160px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.externalOrderIds,
        render: (row) => <MultiLineText value={row.externalOrderIds} />,
      },
      {
        key: "product",
        label: t("columns.product"),
        width: "minmax(260px,1.1fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.productText,
        render: (row) => <span className="line-clamp-2 break-words">{row.productText}</span>,
      },
      {
        key: "channelStatus",
        label: t("columns.channelStatus"),
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.channelStatusText,
        render: (row) => <MultiLineText value={row.channelStatusText} />,
      },
      {
        key: "receiverName",
        label: t("columns.receiver"),
        width: "120px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverName,
        render: (row) => <span className="truncate">{textOrDash(row.receiverName)}</span>,
      },
      {
        key: "receiverAddress",
        label: t("columns.address"),
        width: "minmax(300px,1.3fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverAddress,
        render: (row) => <span className="line-clamp-2 break-words">{row.receiverAddress}</span>,
      },
    ],
    [t]
  );

  return (
    <WorkspacePageFrame className="p-5">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("summary", {
              exceptions: summary?.exceptionCount ?? 0,
              inTransit: summary?.inTransitCount ?? 0,
              members: summary?.memberCount ?? 0,
              packages: summary?.packageGroupCount ?? 0,
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
        {nextCursor ? (
          <Button
            variant="outline"
            onClick={() => void loadRows(nextCursor, true)}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? t("actions.loading") : t("actions.loadMore")}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => void loadRows()} disabled={isLoading}>
          <RefreshCcw className="size-4" />
          {t("actions.refresh")}
        </Button>
        </div>
      </div>

      {message ? (
        <FeedbackBanner tone="warning" className="mb-3">
          {message}
        </FeedbackBanner>
      ) : null}

      <VirtualizedDataGrid
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        selectedRowKey={selectedRow?.id ?? null}
        onRowClick={setSelectedRow}
        emptyMessage={
          isLoading
            ? t("loading")
            : t("empty")
        }
        minWidth="1880px"
        rowHeight={58}
      />

      <TrackingDetailSheet
        row={selectedRow}
        open={Boolean(selectedRow)}
        onOpenChange={(open) => {
          if (!open) setSelectedRow(null);
        }}
      />
    </WorkspacePageFrame>
  );
}
