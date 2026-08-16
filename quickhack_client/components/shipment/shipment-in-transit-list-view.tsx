"use client";

import * as React from "react";
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
import { inventoryStatusLabel } from "@/quickhack_shared/inventory/inventory-status";

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

const numberFormatter = new Intl.NumberFormat("ko-KR");

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

function carrierStatusLabel(value: string | null | undefined) {
  if (value === "REGISTERED") return "송장 등록";
  if (value === "IN_TRANSIT") return "배송 중";
  if (value === "DELIVERED") return "배송 완료";
  if (value === "EXCEPTION") return "배송 예외";
  return textOrDash(value);
}

function CarrierStatusBadge({ row }: { row: TrackingRow }) {
  const variant =
    row.carrierStatus === "EXCEPTION"
      ? "danger"
      : row.carrierStatus === "IN_TRANSIT"
        ? "sky"
        : "neutral";
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant={variant}>{carrierStatusLabel(row.carrierStatus)}</Badge>
      {row.reviewRequired ? (
        <Badge variant="warning">확인 필요</Badge>
      ) : null}
    </div>
  );
}

function InventoryStatusBadges({ value }: { value: string }) {
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
          {inventoryStatusLabel(status)}
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
        throw new Error(payload?.message || "배송 추적 이력을 불러오지 못했습니다.");
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
  }, [carrierShipmentId]);

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
            합포장 그룹 #{row.packageGroupId} / 구성품 {row.memberCount}대
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {row.reviews.length > 0 ? (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                <AlertTriangle className="size-4" />
                자동 반영 확인 필요
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

          <h3 className="mb-2 text-sm font-semibold">배송 요약</h3>
          <DescriptionList className="mb-5 rounded-md border bg-background px-4">
            <DetailRow label="택배사" value={row.carrierCode} />
            <DetailRow label="현재 상태" value={carrierStatusLabel(row.carrierStatus)} />
            <DetailRow label="최근 스캔" value={row.latestStatusName} />
            <DetailRow label="스캔 지점" value={row.latestBranchName} />
            <DetailRow
              label="스캔 일시"
              value={formatScanDateTime(row.latestScanDate, row.latestScanTime)}
            />
            <DetailRow label="최근 조회" value={formatDateTime(row.lastTrackedAt)} />
            <DetailRow label="수취인" value={`${row.receiverName} / ${row.receiverSafeNumber}`} />
            <DetailRow label="주소" value={row.receiverAddress} />
          </DescriptionList>

          <h3 className="mb-2 text-sm font-semibold">배송 추적 이력</h3>
          <div className="mb-5 overflow-hidden rounded-md border bg-background">
            {trackingEvents.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                수집된 배송 스캔 이력이 없습니다.
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

          <h3 className="mb-2 text-sm font-semibold">합포장 구성품</h3>
          <div className="overflow-hidden rounded-md border bg-background">
            {row.members.map((member) => (
              <div key={member.allocationId} className="border-b px-4 py-3 text-sm last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{member.pgNo}</span>
                  <Badge variant={member.inventoryStatus === "NONE_TRACKING" ? "danger" : "secondary"}>
                    {inventoryStatusLabel(member.inventoryStatus)}
                  </Badge>
                  <span className="text-muted-foreground">{member.uniqueNo}</span>
                </div>
                <div className="mt-1 break-words text-muted-foreground">
                  {member.productName} / 주문 {member.externalOrderId}
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
              추적 이력 {trackingEvents.length.toLocaleString("ko-KR")} /{" "}
              {trackingTotal.toLocaleString("ko-KR")}건
            </span>
            {trackingCursor ? (
              <Button
                size="sm"
                variant="outline"
                disabled={trackingLoading}
                onClick={() => void loadTrackingEvents(trackingCursor, true)}
              >
                {trackingLoading ? "불러오는 중" : "더 보기"}
              </Button>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function ShipmentInTransitListView() {
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
        throw new Error(payload?.message || "배송 현황을 불러오지 못했습니다.");
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
  }, []);

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
        label: "택배 상태",
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => `${row.carrierStatus} ${row.reviewRequired ? "확인 필요" : ""}`,
        render: (row) => <CarrierStatusBadge row={row} />,
      },
      {
        key: "latestStatus",
        label: "최근 스캔",
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
        label: "최근 조회",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => formatDateTime(row.lastTrackedAt),
        render: (row) => <span>{formatDateTime(row.lastTrackedAt)}</span>,
      },
      {
        key: "trackingNumber",
        label: "송장번호",
        width: "135px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.trackingNumber,
        render: (row) => <span>{row.trackingNumber}</span>,
      },
      {
        key: "shipmentBatch",
        label: "출고 차수",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.shipmentBatchText,
        render: (row) => <MultiLineText value={row.shipmentBatchText} />,
      },
      {
        key: "inventoryStatus",
        label: "재고 상태",
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
        label: "주문번호",
        width: "160px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.externalOrderIds,
        render: (row) => <MultiLineText value={row.externalOrderIds} />,
      },
      {
        key: "product",
        label: "상품",
        width: "minmax(260px,1.1fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.productText,
        render: (row) => <span className="line-clamp-2 break-words">{row.productText}</span>,
      },
      {
        key: "channelStatus",
        label: "쿠팡 상태",
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.channelStatusText,
        render: (row) => <MultiLineText value={row.channelStatusText} />,
      },
      {
        key: "receiverName",
        label: "수취인",
        width: "120px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverName,
        render: (row) => <span className="truncate">{textOrDash(row.receiverName)}</span>,
      },
      {
        key: "receiverAddress",
        label: "주소",
        width: "minmax(300px,1.3fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverAddress,
        render: (row) => <span className="line-clamp-2 break-words">{row.receiverAddress}</span>,
      },
    ],
    []
  );

  return (
    <WorkspacePageFrame className="p-5">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">현재 배송 중 목록</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            합포장 {numberFormatter.format(summary?.packageGroupCount ?? 0)}건 / PG{" "}
            {numberFormatter.format(summary?.memberCount ?? 0)}대 / 배송 중{" "}
            {numberFormatter.format(summary?.inTransitCount ?? 0)}건 / 예외{" "}
            {numberFormatter.format(summary?.exceptionCount ?? 0)}건
          </p>
        </div>
        <div className="flex items-center gap-2">
        {nextCursor ? (
          <Button
            variant="outline"
            onClick={() => void loadRows(nextCursor, true)}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? "불러오는 중" : "더 보기"}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => void loadRows()} disabled={isLoading}>
          <RefreshCcw className="size-4" />
          목록 새로고침
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
            ? "배송 현황을 불러오는 중입니다."
            : "배송 중이거나 확인이 필요한 합포장 건이 없습니다."
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
