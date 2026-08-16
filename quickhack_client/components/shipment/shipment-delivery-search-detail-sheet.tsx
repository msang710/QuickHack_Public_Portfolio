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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/quickhack_client/components/ui/sheet";
import { inventoryStatusLabel } from "@/quickhack_shared/inventory/inventory-status";
import {
  SHIPMENT_DELIVERY_STAGE_LABELS,
  type ShipmentDeliverySearchDetail,
  type ShipmentDeliveryTrackingEvent,
} from "@/quickhack_shared/shipment/delivery-search";

type TrackingPageResponse = {
  ok: boolean;
  message?: string;
  items?: ShipmentDeliveryTrackingEvent[];
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
};

function textOrDash(value: string | number | null | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized || "-";
}

function formatDateTime(value: string | null | undefined) {
  return textOrDash(value).replace("T", " ").slice(0, 19);
}

function workflowStatusLabel(status: string) {
  const labels: Record<string, string> = {
    PENDING: "대기",
    IN_PROGRESS: "처리 중",
    COMPLETED: "완료",
    REGISTERED: "등록 완료",
    CONFIRMED: "확정",
    NOT_PRINTED: "출력 전",
    SPOOLED: "프린터 전송",
    PRINTED: "출력 완료",
    FAILED: "실패",
    BLOCKED: "처리 중단",
    REVIEW_REQUIRED: "직접 확인 필요",
    LOCAL_PENDING: "내부 확정 필요",
  };
  return labels[status] ?? status;
}

function statusVariant(status: string) {
  if (["COMPLETED", "REGISTERED", "CONFIRMED", "PRINTED"].includes(status)) {
    return "success" as const;
  }
  if (["FAILED", "BLOCKED", "REVIEW_REQUIRED"].includes(status)) {
    return "danger" as const;
  }
  if (["PENDING", "IN_PROGRESS", "LOCAL_PENDING", "NOT_PRINTED"].includes(status)) {
    return "warning" as const;
  }
  return "secondary" as const;
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
      labelWidth="110px"
      className="py-2.5 text-xs"
      valueClassName="whitespace-pre-line"
    />
  );
}

export function ShipmentDeliverySearchDetailSheet({
  open,
  onOpenChange,
  detail,
  loading,
  error,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: ShipmentDeliverySearchDetail | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const summary = detail?.summary ?? null;
  const [selectedTrackingShipmentId, setSelectedTrackingShipmentId] =
    React.useState<number | null>(null);
  const defaultTrackingShipmentId =
    detail?.revisions.find((revision) => revision.isCurrent)?.carrierShipmentId ??
    detail?.revisions.at(-1)?.carrierShipmentId ??
    null;
  const trackingShipmentId = detail?.revisions.some(
    (revision) => revision.carrierShipmentId === selectedTrackingShipmentId
  )
    ? selectedTrackingShipmentId
    : defaultTrackingShipmentId;
  const [trackingEvents, setTrackingEvents] = React.useState<ShipmentDeliveryTrackingEvent[]>([]);
  const [trackingCursor, setTrackingCursor] = React.useState<string | null>(null);
  const [trackingTotal, setTrackingTotal] = React.useState(0);
  const [trackingLoading, setTrackingLoading] = React.useState(false);
  const [trackingError, setTrackingError] = React.useState("");

  const loadTrackingPage = React.useCallback(async (
    carrierShipmentId: number,
    cursor: string | null,
    append: boolean,
    signal?: AbortSignal
  ) => {
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
        | TrackingPageResponse
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "배송 추적 이력을 불러오지 못했습니다.");
      }
      const next = payload.items ?? [];
      setTrackingEvents((current) => append ? [...current, ...next] : next);
      setTrackingCursor(payload.hasMore ? payload.nextCursor ?? null : null);
      setTrackingTotal(payload.totalCount ?? next.length);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setTrackingError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!signal?.aborted) setTrackingLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open || !trackingShipmentId) return;
    const controller = new AbortController();
    const timerId = window.setTimeout(() => {
      void loadTrackingPage(trackingShipmentId, null, false, controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [loadTrackingPage, open, trackingShipmentId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <SheetTitle>
              {summary?.trackingNumber || `배송 건 #${summary?.packageGroupId ?? ""}`}
            </SheetTitle>
            {summary ? (
              <Badge
                variant={
                  ["EXCEPTION", "CLOSED"].includes(summary.deliveryStage)
                    ? "danger"
                    : summary.deliveryStage === "DELIVERED"
                      ? "success"
                      : "secondary"
                }
              >
                {SHIPMENT_DELIVERY_STAGE_LABELS[summary.deliveryStage]}
              </Badge>
            ) : null}
            {summary?.reviewRequired ? (
              <Badge variant="warning">확인 필요 {summary.reviewCount}</Badge>
            ) : null}
          </div>
          <SheetDescription>
            물리 포장 그룹 #{summary?.packageGroupId ?? "-"} · 구성품{" "}
            {summary?.memberCount ?? 0}개
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
              배송 건 상세 정보를 불러오는 중입니다.
            </div>
          ) : error ? (
            <div className="space-y-3">
              <FeedbackBanner tone="danger">{error}</FeedbackBanner>
              <Button type="button" variant="outline" onClick={onRetry}>
                <RefreshCcw className="size-4" />
                다시 불러오기
              </Button>
            </div>
          ) : detail ? (
            <>
              {detail.reviews.length > 0 ? (
                <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <div className="mb-2 flex items-center gap-2 font-semibold">
                    <AlertTriangle className="size-4" />
                    판매 채널 동기화 점검 필요
                  </div>
                  <div className="space-y-2">
                    {detail.reviews.map((review) => (
                      <div
                        key={`${review.source}:${review.id}`}
                        className="border-t border-amber-200 pt-2 first:border-0 first:pt-0"
                      >
                        <div>{review.reason || review.operationType}</div>
                        {review.errorMessage ? (
                          <div className="mt-1 break-words text-xs text-red-700">
                            {review.errorMessage}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <h3 className="mb-2 text-sm font-semibold">배송지 정보</h3>
              <DescriptionList className="mb-5 rounded-md border bg-background px-4">
                <DetailRow
                  label="수취인"
                  value={`${detail.receiver.name} / ${textOrDash(
                    detail.receiver.maskedPhone
                  )}`}
                />
                <DetailRow
                  label="주소"
                  value={[
                    detail.receiver.postCode,
                    detail.receiver.address1,
                    detail.receiver.address2,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
                <DetailRow
                  label="배송 메모"
                  value={detail.receiver.shippingMemo}
                />
                <DetailRow
                  label="포장 상태"
                  value={detail.packageGroup.groupStatus}
                />
                <DetailRow
                  label="생성 일시"
                  value={formatDateTime(detail.packageGroup.createdAt)}
                />
                {detail.packageGroup.invalidationReason ? (
                  <DetailRow
                    label="종료 사유"
                    value={detail.packageGroup.invalidationReason}
                  />
                ) : null}
              </DescriptionList>

              <h3 className="mb-2 text-sm font-semibold">처리 진행 상태</h3>
              <div className="mb-5 overflow-hidden rounded-md border bg-background">
                {detail.workflows.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    아직 시작된 송장 처리 작업이 없습니다.
                  </div>
                ) : (
                  detail.workflows.map((workflow) => (
                    <div
                      key={`${workflow.key}:${workflow.relatedId ?? "none"}`}
                      className="grid grid-cols-[125px_120px_minmax(0,1fr)] gap-3 border-b px-4 py-3 text-xs last:border-b-0"
                    >
                      <span className="font-medium">{workflow.label}</span>
                      <Badge
                        variant={statusVariant(workflow.status)}
                        className="w-fit"
                      >
                        {workflowStatusLabel(workflow.status)}
                      </Badge>
                      <div className="min-w-0">
                        <div className="text-muted-foreground">
                          {formatDateTime(workflow.occurredAt)}
                        </div>
                        {workflow.errorMessage ? (
                          <div className="mt-1 break-words text-red-700">
                            {workflow.errorCode
                              ? `${workflow.errorCode}: `
                              : ""}
                            {workflow.errorMessage}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <h3 className="mb-2 text-sm font-semibold">포장 구성</h3>
              <div className="mb-5 overflow-hidden rounded-md border bg-background">
                {detail.members.map((member) => (
                  <div
                    key={member.allocationId}
                    className="border-b px-4 py-3 text-xs last:border-b-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">
                        {member.memberSequence}. {member.pgNo}
                      </span>
                      <Badge
                        variant={
                          member.inventoryStatus === "NONE_TRACKING"
                            ? "danger"
                            : "secondary"
                        }
                      >
                        {inventoryStatusLabel(member.inventoryStatus)}
                      </Badge>
                      <span className="text-muted-foreground">
                        {member.uniqueNo}
                      </span>
                    </div>
                    <div className="mt-1 break-words">{member.productName}</div>
                    <div className="mt-1 text-muted-foreground">
                      주문 {member.externalOrderId} · 묶음배송{" "}
                      {member.externalShipmentId}
                      {member.batchLabel
                        ? ` · ${member.batchLabel}-${member.printLineNo ?? "-"}`
                        : ""}
                    </div>
                  </div>
                ))}
              </div>

              <h3 className="mb-2 text-sm font-semibold">송장 이력</h3>
              <div className="mb-5 overflow-hidden rounded-md border bg-background">
                {detail.revisions.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    아직 발급된 송장이 없습니다.
                  </div>
                ) : (
                  detail.revisions.map((revision) => (
                    <div
                      key={revision.carrierShipmentId}
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        setSelectedTrackingShipmentId(revision.carrierShipmentId)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          setSelectedTrackingShipmentId(
                            revision.carrierShipmentId
                          );
                        }
                      }}
                      className={`flex cursor-pointer items-start justify-between gap-3 border-b px-4 py-3 text-xs last:border-b-0 ${
                        trackingShipmentId === revision.carrierShipmentId
                          ? "bg-primary/5"
                          : ""
                      }`}
                    >
                      <div>
                        <div className="font-mono font-semibold">
                          rev.{revision.revisionNo} · {revision.trackingNumber}
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          {revision.carrierCode} ·{" "}
                          {formatDateTime(revision.createdAt)}
                        </div>
                      </div>
                      <Badge
                        variant={revision.isCurrent ? "success" : "neutral"}
                      >
                        {revision.isCurrent ? "현재 송장" : "이전 송장"}
                      </Badge>
                    </div>
                  ))
                )}
              </div>

              <h3 className="mb-2 text-sm font-semibold">배송 추적 이력</h3>
              <div className="overflow-hidden rounded-md border bg-background">
                {trackingEvents.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    수집된 배송 추적 이력이 없습니다.
                  </div>
                ) : (
                  trackingEvents.map((event) => (
                    <div
                      key={event.id}
                      className="grid grid-cols-[145px_120px_minmax(0,1fr)] gap-3 border-b px-4 py-3 text-xs last:border-b-0"
                    >
                      <span className="font-mono text-muted-foreground">
                        {formatDateTime(event.occurredAt)}
                      </span>
                      <span className="font-medium">{event.statusName}</span>
                      <span className="truncate text-muted-foreground">
                        {event.branchName || event.salesOfficeName || "-"}
                        {event.recipientTypeName
                          ? ` / ${event.recipientTypeName}`
                          : ""}
                      </span>
                    </div>
                  ))
                )}
              </div>
              {trackingError ? (
                <FeedbackBanner tone="warning" className="mt-2">
                  {trackingError}
                </FeedbackBanner>
              ) : null}
              <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  {trackingEvents.length.toLocaleString("ko-KR")} /{" "}
                  {trackingTotal.toLocaleString("ko-KR")}건
                </span>
                {trackingCursor && trackingShipmentId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={trackingLoading}
                    onClick={() =>
                      void loadTrackingPage(
                        trackingShipmentId,
                        trackingCursor,
                        true
                      )
                    }
                  >
                    {trackingLoading ? "불러오는 중" : "더 보기"}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
