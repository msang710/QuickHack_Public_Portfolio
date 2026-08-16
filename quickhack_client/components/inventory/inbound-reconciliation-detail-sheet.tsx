"use client";

import * as React from "react";
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
import { inboundStatusLabel } from "@/quickhack_shared/inbound/inbound-status";
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

const SCOPE_LABELS: Record<
  InboundReconciliationDetailScope,
  {
    title: string;
    empty: string;
    quantityLabel: string;
  }
> = {
  UNASSIGNED: {
    title: "미지정 PG 상세",
    empty: "현재 미지정 PG가 없습니다.",
    quantityLabel: "PG",
  },
  MISMATCHED: {
    title: "불일치 차수 상세",
    empty: "현재 기대 수량과 연결 수량이 다른 차수가 없습니다.",
    quantityLabel: "차수",
  },
  SHORTAGE: {
    title: "부족 수량 상세",
    empty: "현재 부족 수량이 있는 차수가 없습니다.",
    quantityLabel: "대",
  },
  EXCESS: {
    title: "초과 수량 상세",
    empty: "현재 초과 수량이 있는 차수가 없습니다.",
    quantityLabel: "대",
  },
};

function quantityText(value: number) {
  return value.toLocaleString("ko-KR");
}

function differenceText(value: number) {
  return value > 0
    ? `+${quantityText(value)}`
    : quantityText(value);
}

function deviceDescription(device: LatestInboundDeviceDto) {
  return [
    device.model || "기종 미정",
    device.storage || "용량 미정",
    device.color || "색상 미정",
    device.saleGrade || "등급 미정",
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
            payload?.message || "입고 대조 상세를 불러오지 못했습니다."
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
    []
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

  const scopeDefinition = SCOPE_LABELS[selection.scope];
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
          <SheetTitle>{scopeDefinition.title}</SheetTitle>
          <SheetDescription>
            {selection.businessDate} · 상세는 창을 열 때의 최신 DB 상태로
            다시 조회합니다.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="size-4 animate-spin" />
              입고 대조 상세를 불러오는 중입니다.
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
                다시 시도
              </Button>
            </div>
          ) : data ? (
            <div className="grid gap-4">
              <div className="flex items-center justify-between rounded-md border bg-muted/25 px-3 py-2">
                <span className="text-sm text-muted-foreground">
                  현재 상세 합계
                </span>
                <strong className="tabular-nums">
                  {quantityText(data.scopeQuantity)}
                  {scopeDefinition.quantityLabel}
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
                  {scopeDefinition.empty} 상단 지표를 새로고침하면 현재
                  결과와 맞춰집니다.
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
  return (
    <section className="overflow-hidden rounded-md border">
      <div className="grid gap-3 bg-muted/25 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">
              {batch.batchDate} · {batch.batchNo}차
            </h3>
            <p className="text-xs text-muted-foreground">
              {batch.note || "비고 없음"}
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
            차이 {differenceText(batch.arrivalDifference)}
          </Badge>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <BatchMetric label="기대" value={batch.expectedQuantity} />
          <BatchMetric label="현재 연결" value={batch.linkedQuantity} />
          <BatchMetric
            label="매입처 반품"
            value={batch.supplierReturnQuantity}
          />
          <BatchMetric
            label="정상 입고 대상"
            value={batch.normalInboundTargetQuantity}
          />
        </dl>
      </div>

      <div className="grid gap-2 border-t p-3">
        <h4 className="text-xs font-semibold text-muted-foreground">
          현재 연결 PG {quantityText(batch.devices.length)}개
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
            현재 이 차수에 연결된 PG가 없습니다.
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
  return (
    <div className="rounded border bg-background px-2 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">
        {quantityText(value)}
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
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${device.pgNo} 재고 수정에서 열기`}
      onClick={() => onOpenInventoryEdit(device.pgNo)}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm font-semibold">
          {device.pgNo}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {deviceDescription(device)}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          최신 상태 {inboundStatusLabel(device.inboundStatus)} ·{" "}
          {device.updatedAt}
        </div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
        재고 수정
        <ArrowRight className="size-3.5" />
      </span>
    </button>
  );
}
