"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/quickhack_client/components/ui/sheet";
import { statusLabel } from "@/quickhack_client/components/shared/device-detail-sheet";
import type {
  InboundBatchReconciliationDto,
  InboundReconciliationDetailDto,
  InboundReconciliationDetailScope,
  LatestInboundDeviceDto,
} from "@/quickhack_shared/inbound/inbound-reconciliation";

export type InboundReconciliationDetailSelection = {
  businessDate: string;
  scope: InboundReconciliationDetailScope;
};

type DetailApiResponse = {
  ok: boolean;
  message?: string;
  data?: InboundReconciliationDetailDto;
};

const SCOPE_KEYS = {
  UNASSIGNED: "unassigned",
  MISMATCHED: "mismatched",
  SHORTAGE: "shortage",
  EXCESS: "excess",
} as const satisfies Record<InboundReconciliationDetailScope, string>;

function quantityText(value: number, locale: string) {
  return value.toLocaleString(locale);
}

function differenceText(value: number, locale: string) {
  return value > 0
    ? `+${quantityText(value, locale)}`
    : quantityText(value, locale);
}

function deviceDescription(
  device: LatestInboundDeviceDto,
  fallback: { model: string; storage: string; color: string; grade: string }
) {
  return [
    device.model || fallback.model,
    device.storage || fallback.storage,
    device.color || fallback.color,
    device.saleGrade || fallback.grade,
  ].join(" · ");
}

export function InboundReconciliationDetailSheet({
  selection,
  onOpenChange,
  onOpenInventoryEdit,
}: {
  selection: InboundReconciliationDetailSelection | null;
  onOpenChange: (open: boolean) => void;
  onOpenInventoryEdit: (pgNo: string) => void;
}) {
  const t = useTranslations("inventory.reconciliationDetail");
  const open = selection !== null;
  const [data, setData] =
    React.useState<InboundReconciliationDetailDto | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const requestSequenceRef = React.useRef(0);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  const load = React.useCallback(
    async (target: InboundReconciliationDetailSelection) => {
      const requestSequence = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestSequence;
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setLoading(true);
      setError("");
      setData(null);

      try {
        const params = new URLSearchParams({
          businessDate: target.businessDate,
          scope: target.scope,
        });
        const response = await fetch(
          `/api/inventory/inbound-reconciliation?${params.toString()}`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        const payload = (await response.json().catch(() => null)) as
          | DetailApiResponse
          | null;

        if (!response.ok || !payload?.ok || !payload.data) {
          throw new Error(
            legacyApiMessage(payload, t("fallback.loadFailed"))
          );
        }

        if (requestSequenceRef.current !== requestSequence) {
          return;
        }

        setData(payload.data);
      } catch (caught) {
        if (
          controller.signal.aborted ||
          requestSequenceRef.current !== requestSequence
        ) {
          return;
        }

        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (requestSequenceRef.current === requestSequence) {
          setLoading(false);
        }
      }
    },
    [t]
  );

  React.useEffect(() => {
    if (!selection) {
      abortControllerRef.current?.abort();
      requestSequenceRef.current += 1;
      return;
    }

    const target = selection;
    queueMicrotask(() => void load(target));

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [load, selection]);

  const closeSheet = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        abortControllerRef.current?.abort();
        requestSequenceRef.current += 1;
        setData(null);
        setError("");
      }

      onOpenChange(nextOpen);
    },
    [onOpenChange]
  );

  if (!selection) {
    return null;
  }

  const scopeKey = SCOPE_KEYS[selection.scope];
  const isEmpty =
    data !== null &&
    data.devices.length === 0 &&
    data.batches.length === 0;

  function openInventoryEdit(pgNo: string) {
    closeSheet(false);
    onOpenInventoryEdit(pgNo);
  }

  return (
    <Sheet open={open} onOpenChange={closeSheet}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t(`scopes.${scopeKey}.title`)}</SheetTitle>
          <SheetDescription>
            {t("description", { date: selection.businessDate })}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : error ? (
            <div className="grid gap-3">
              <FeedbackBanner tone="danger">{error}</FeedbackBanner>
              <Button
                type="button"
                variant="outline"
                onClick={() => void load(selection)}
              >
                <RefreshCw />
                {t("actions.retry")}
              </Button>
            </div>
          ) : data ? (
            <div className="grid gap-4">
              <div className="flex items-center justify-between rounded-md border bg-muted/25 px-3 py-2">
                <span className="text-sm text-muted-foreground">
                  {t("total")}
                </span>
                <strong className="tabular-nums">
                  {t("totalValue", {
                    quantity: data.scopeQuantity,
                    unit: t(`scopes.${scopeKey}.unit`),
                  })}
                </strong>
              </div>

              {data.devices.length > 0 ? (
                <div className="grid gap-2">
                  {data.devices.map((device) => (
                    <InboundDeviceRow
                      key={`${device.inboundId}:${device.pgNo}`}
                      device={device}
                      onOpenInventoryEdit={openInventoryEdit}
                    />
                  ))}
                </div>
              ) : null}

              {data.batches.length > 0 ? (
                <div className="grid gap-3">
                  {data.batches.map((batch) => (
                    <InboundBatchCard
                      key={batch.inboundBatchId}
                      batch={batch}
                      onOpenInventoryEdit={openInventoryEdit}
                    />
                  ))}
                </div>
              ) : null}

              {isEmpty ? (
                <FeedbackBanner tone="neutral">
                  {t("emptyRefresh", {
                    message: t(`scopes.${scopeKey}.empty`),
                  })}
                </FeedbackBanner>
              ) : null}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function InboundBatchCard({
  batch,
  onOpenInventoryEdit,
}: {
  batch: InboundBatchReconciliationDto;
  onOpenInventoryEdit: (pgNo: string) => void;
}) {
  const t = useTranslations("inventory.reconciliationDetail");
  const locale = useLocale();
  return (
    <section className="overflow-hidden rounded-md border">
      <div className="grid gap-3 bg-muted/25 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">
              {t("batch.title", { batch: batch.batchNo, date: batch.batchDate })}
            </h3>
            <p className="text-xs text-muted-foreground">
              {batch.note || t("batch.noNote")}
            </p>
          </div>
          <Badge
            variant={
              batch.arrivalDifference === 0
                ? "success"
                : batch.arrivalDifference < 0
                  ? "warning"
                  : "danger"
            }
          >
            {t("batch.difference", {
              value: differenceText(batch.arrivalDifference, locale),
            })}
          </Badge>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <BatchMetric label={t("batch.expected")} value={batch.expectedQuantity} />
          <BatchMetric label={t("batch.connected")} value={batch.linkedQuantity} />
          <BatchMetric
            label={t("batch.supplierReturn")}
            value={batch.supplierReturnQuantity}
          />
          <BatchMetric
            label={t("batch.normalTarget")}
            value={batch.normalInboundTargetQuantity}
          />
        </dl>
      </div>

      <div className="grid gap-2 border-t p-3">
        <h4 className="text-xs font-semibold text-muted-foreground">
          {t("batch.connectedPg", { count: batch.devices.length })}
        </h4>
        {batch.devices.map((device) => (
          <InboundDeviceRow
            key={`${device.inboundId}:${device.pgNo}`}
            device={device}
            onOpenInventoryEdit={onOpenInventoryEdit}
          />
        ))}
        {batch.devices.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("batch.empty")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function BatchMetric({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  const locale = useLocale();
  return (
    <div className="rounded border bg-background px-2 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">
        {quantityText(value, locale)}
      </dd>
    </div>
  );
}

function InboundDeviceRow({
  device,
  onOpenInventoryEdit,
}: {
  device: LatestInboundDeviceDto;
  onOpenInventoryEdit: (pgNo: string) => void;
}) {
  const t = useTranslations("inventory.reconciliationDetail");
  const detailT = useTranslations("common.deviceDetail");
  const description = deviceDescription(device, {
    color: t("device.colorUnknown"),
    grade: t("device.gradeUnknown"),
    model: t("device.modelUnknown"),
    storage: t("device.storageUnknown"),
  });

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("device.openAria", { pg: device.pgNo })}
      onClick={() => onOpenInventoryEdit(device.pgNo)}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm font-semibold">
          {device.pgNo}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {description}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {t("device.latest", {
            status: statusLabel(device.inboundStatus, detailT),
            updatedAt: device.updatedAt,
          })}
        </div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
        {t("actions.editInventory")}
        <ArrowRight className="size-3.5" />
      </span>
    </button>
  );
}
