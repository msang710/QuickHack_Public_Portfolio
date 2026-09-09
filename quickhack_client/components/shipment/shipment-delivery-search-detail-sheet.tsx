"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import { packageGroupStatusLabel } from "@/quickhack_client/components/shipment/package-group-status-presentation";
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
import { statusLabel } from "@/quickhack_client/components/shared/device-detail-sheet";
import {
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
  const t = useTranslations("shipment.deliverySearch");
  const packageStatusT = useTranslations("shipment.packageGroupStatus");
  const detailT = useTranslations("common.deviceDetail");

  function stageLabel(value: ShipmentDeliverySearchDetail["summary"]["deliveryStage"]) {
    if (value === "INVOICE_ALLOCATED") return t("stage.invoiceAllocated");
    if (value === "REGISTERED") return t("stage.registered");
    if (value === "IN_TRANSIT") return t("stage.inTransit");
    if (value === "DELIVERED") return t("stage.delivered");
    if (value === "ON_HOLD") return t("stage.onHold");
    if (value === "EXCEPTION") return t("stage.exception");
    if (value === "CLOSED") return t("stage.closed");
    return t("stage.preparing");
  }

  function workflowStatusLabel(status: string) {
    if (status === "IN_PROGRESS") return t("workflowStatus.inProgress");
    if (status === "COMPLETED") return t("workflowStatus.completed");
    if (status === "REGISTERED") return t("workflowStatus.registered");
    if (status === "CONFIRMED") return t("workflowStatus.confirmed");
    if (status === "NOT_PRINTED") return t("workflowStatus.notPrinted");
    if (status === "SPOOLED") return t("workflowStatus.spooled");
    if (status === "PRINTED") return t("workflowStatus.printed");
    if (status === "FAILED") return t("workflowStatus.failed");
    if (status === "BLOCKED") return t("workflowStatus.blocked");
    if (status === "REVIEW_REQUIRED") return t("workflowStatus.reviewRequired");
    if (status === "LOCAL_PENDING") return t("workflowStatus.localPending");
    if (status === "PENDING") return t("workflowStatus.pending");
    return status;
  }

  function workflowLabel(key: ShipmentDeliverySearchDetail["workflows"][number]["key"]) {
    if (key === "INVOICE_ISSUE") return t("workflow.invoiceIssue");
    if (key === "LABEL_PRINT") return t("workflow.labelPrint");
    if (key === "CHANNEL_WRITE") return t("workflow.channelWrite");
    if (key === "CARRIER_REGISTRATION") return t("workflow.carrierRegistration");
    return t("workflow.invoiceReplacement");
  }

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
        throw new Error(legacyApiMessage(payload, t("fallback.trackingLoadFailed")));
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
  }, [t]);

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
              {summary?.trackingNumber || t("detail.title", { id: String(summary?.packageGroupId ?? "") })}
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
                {stageLabel(summary.deliveryStage)}
              </Badge>
            ) : null}
            {summary?.reviewRequired ? (
              <Badge variant="warning">{t("reviewCount", { count: summary.reviewCount })}</Badge>
            ) : null}
          </div>
          <SheetDescription>
            {t("detail.packageSummary", { group: String(summary?.packageGroupId ?? "-"), members: summary?.memberCount ?? 0 })}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
              {t("loading")}
            </div>
          ) : error ? (
            <div className="space-y-3">
              <FeedbackBanner tone="danger">{error}</FeedbackBanner>
              <Button type="button" variant="outline" onClick={onRetry}>
                <RefreshCcw className="size-4" />
                {t("actions.retry")}
              </Button>
            </div>
          ) : detail ? (
            <>
              {detail.reviews.length > 0 ? (
                <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <div className="mb-2 flex items-center gap-2 font-semibold">
                    <AlertTriangle className="size-4" />
                    {t("detail.reviewRequired")}
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

              <h3 className="mb-2 text-sm font-semibold">{t("detail.destination")}</h3>
              <DescriptionList className="mb-5 rounded-md border bg-background px-4">
                <DetailRow
                  label={t("detail.receiver")}
                  value={`${detail.receiver.name} / ${textOrDash(
                    detail.receiver.maskedPhone
                  )}`}
                />
                <DetailRow
                  label={t("detail.address")}
                  value={[
                    detail.receiver.postCode,
                    detail.receiver.address1,
                    detail.receiver.address2,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
                <DetailRow
                  label={t("detail.deliveryMemo")}
                  value={detail.receiver.shippingMemo}
                />
                <DetailRow
                  label={t("detail.packageStatus")}
                  value={packageGroupStatusLabel(detail.packageGroup.groupStatus, packageStatusT)}
                />
                <DetailRow
                  label={t("detail.createdAt")}
                  value={formatDateTime(detail.packageGroup.createdAt)}
                />
                {detail.packageGroup.invalidationReason ? (
                  <DetailRow
                    label={t("detail.invalidationReason")}
                    value={detail.packageGroup.invalidationReason}
                  />
                ) : null}
              </DescriptionList>

              <h3 className="mb-2 text-sm font-semibold">{t("detail.workflow")}</h3>
              <div className="mb-5 overflow-hidden rounded-md border bg-background">
                {detail.workflows.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {t("detail.workflowEmpty")}
                  </div>
                ) : (
                  detail.workflows.map((workflow) => (
                    <div
                      key={`${workflow.key}:${workflow.relatedId ?? "none"}`}
                      className="grid grid-cols-[125px_120px_minmax(0,1fr)] gap-3 border-b px-4 py-3 text-xs last:border-b-0"
                    >
                      <span className="font-medium">{workflowLabel(workflow.key)}</span>
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

              <h3 className="mb-2 text-sm font-semibold">{t("detail.members")}</h3>
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
                        {statusLabel(member.inventoryStatus ?? "", detailT)}
                      </Badge>
                      <span className="text-muted-foreground">
                        {member.uniqueNo}
                      </span>
                    </div>
                    <div className="mt-1 break-words">{member.productName}</div>
                    <div className="mt-1 text-muted-foreground">
                      {t("detail.orderMember", { orderId: member.externalOrderId, shipmentId: member.externalShipmentId })}
                      {member.batchLabel
                        ? ` · ${member.batchLabel}-${member.printLineNo ?? "-"}`
                        : ""}
                    </div>
                  </div>
                ))}
              </div>

              <h3 className="mb-2 text-sm font-semibold">{t("detail.invoiceHistory")}</h3>
              <div className="mb-5 overflow-hidden rounded-md border bg-background">
                {detail.revisions.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {t("detail.invoicesEmpty")}
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
                        {revision.isCurrent ? t("detail.currentInvoice") : t("detail.previousInvoice")}
                      </Badge>
                    </div>
                  ))
                )}
              </div>

              <h3 className="mb-2 text-sm font-semibold">{t("detail.tracking")}</h3>
              <div className="overflow-hidden rounded-md border bg-background">
                {trackingEvents.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {t("detail.trackingEmpty")}
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
                  {t("detail.trackingSummary", { loaded: trackingEvents.length, total: trackingTotal })}
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
                    {trackingLoading ? t("actions.loading") : t("actions.loadMore")}
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
