"use client";

import * as React from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
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
import {
  TODAY_ORDER_INVENTORY_STATUSES,
  mergeInventoryQuantityMovementPages,
} from "@/quickhack_shared/inventory/inventory-quantity-matrix-view";
import { inventoryStatusLabel } from "@/quickhack_shared/inventory/inventory-status";
import type {
  InventoryQuantityMatrixRowDto,
  InventoryQuantityMovementPageDto,
} from "@/quickhack_shared/inventory/inventory-quantity";

export type InventoryQuantityDetailSelection =
  | {
      kind: "MOVEMENT";
      row: InventoryQuantityMatrixRowDto;
      balanceId: number;
      inventoryStatus: string;
    }
  | {
      kind: "TODAY_ORDER";
      row: InventoryQuantityMatrixRowDto;
    }
  | {
      kind: "PRE_PURCHASE";
      row: InventoryQuantityMatrixRowDto;
    };

type MovementTarget = {
  row: InventoryQuantityMatrixRowDto;
  balanceId: number;
  inventoryStatus: string;
};

type MovementApiResponse = {
  ok: boolean;
  message?: string;
  data?: InventoryQuantityMovementPageDto;
};

type MovementNavigation = {
  parentSelectionKey: string;
  target: MovementTarget;
};

type InventoryQuantityDetailSheetProps = {
  selection: InventoryQuantityDetailSelection | null;
  onOpenChange: (open: boolean) => void;
};

function selectionKey(selection: InventoryQuantityDetailSelection | null) {
  if (!selection) {
    return "NONE";
  }

  if (selection.kind === "MOVEMENT") {
    return `MOVEMENT:${selection.balanceId}`;
  }

  return `${selection.kind}:${selection.row.rowKey}`;
}

function productDescription(row: InventoryQuantityMatrixRowDto) {
  return `${row.model} · ${row.storage} · ${row.color} · ${row.saleGrade}`;
}

function quantityText(value: number | null) {
  return value === null ? "–" : value.toLocaleString("ko-KR");
}

function deltaText(value: number) {
  return value > 0
    ? `+${value.toLocaleString("ko-KR")}`
    : value.toLocaleString("ko-KR");
}

function sourceText(sourceType: string, sourceId: string | null) {
  return sourceId ? `${sourceType} · ${sourceId}` : sourceType;
}

export function InventoryQuantityDetailSheet({
  selection,
  onOpenChange,
}: InventoryQuantityDetailSheetProps) {
  const open = selection !== null;
  const currentSelectionKey = selectionKey(selection);
  const [navigation, setNavigation] =
    React.useState<MovementNavigation | null>(null);
  const [movementPage, setMovementPage] =
    React.useState<InventoryQuantityMovementPageDto | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState("");
  const [failedCursor, setFailedCursor] = React.useState<number | null>(null);
  const requestSequenceRef = React.useRef(0);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  const navigatedTarget =
    navigation?.parentSelectionKey === currentSelectionKey
      ? navigation.target
      : null;
  const movementTarget = React.useMemo<MovementTarget | null>(
    () =>
      navigatedTarget ??
      (selection?.kind === "MOVEMENT"
        ? {
            row: selection.row,
            balanceId: selection.balanceId,
            inventoryStatus: selection.inventoryStatus,
          }
        : null),
    [navigatedTarget, selection]
  );

  const loadMovements = React.useCallback(
    async (
      target: MovementTarget,
      options: { append: boolean; cursor?: number | null }
    ) => {
      const requestSequence = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestSequence;
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      if (options.append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setMovementPage(null);
      }
      setError("");
      setFailedCursor(null);

      try {
        const params = new URLSearchParams({ limit: "50" });

        if (options.cursor) {
          params.set("cursor", String(options.cursor));
        }

        const response = await fetch(
          `/api/inventory/quantity-ledger/${target.balanceId}/movements?${params.toString()}`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        const payload = (await response.json().catch(() => null)) as
          | MovementApiResponse
          | null;

        if (!response.ok || !payload?.ok || !payload.data) {
          throw new Error(
            payload?.message || "재고 수불 이력을 불러오지 못했습니다."
          );
        }

        if (requestSequenceRef.current !== requestSequence) {
          return;
        }

        setMovementPage((current) =>
          options.append
            ? mergeInventoryQuantityMovementPages(current, payload.data!)
            : payload.data!
        );
      } catch (caught) {
        if (
          controller.signal.aborted ||
          requestSequenceRef.current !== requestSequence
        ) {
          return;
        }

        setError(caught instanceof Error ? caught.message : String(caught));
        setFailedCursor(options.cursor ?? null);
      } finally {
        if (requestSequenceRef.current === requestSequence) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    []
  );

  React.useEffect(() => {
    if (!open || !movementTarget) {
      abortControllerRef.current?.abort();
      requestSequenceRef.current += 1;
      return;
    }

    const target = movementTarget;
    queueMicrotask(() =>
      void loadMovements(target, {
        append: false,
      })
    );

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [loadMovements, movementTarget, open]);

  const closeSheet = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        abortControllerRef.current?.abort();
        setNavigation(null);
        setMovementPage(null);
        setError("");
      }

      onOpenChange(nextOpen);
    },
    [onOpenChange]
  );

  if (!selection) {
    return null;
  }

  const isNestedMovement =
    selection.kind === "TODAY_ORDER" && navigatedTarget !== null;
  const title = movementTarget
    ? `${inventoryStatusLabel(
        movementTarget.inventoryStatus
      )} 수불 이력`
    : selection.kind === "TODAY_ORDER"
      ? "오늘 주문 수량 구성"
      : "매입 전 수량 구성";

  return (
    <Sheet open={open} onOpenChange={closeSheet}>
      <SheetContent>
        <SheetHeader>
          <div className="flex min-w-0 items-center gap-2 pr-10">
            {isNestedMovement ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="오늘 주문 수량 구성으로 돌아가기"
                onClick={() => setNavigation(null)}
              >
                <ArrowLeft />
              </Button>
            ) : null}
            <div className="min-w-0">
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription className="truncate">
                {productDescription(selection.row)}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {movementTarget ? (
            <MovementDetail
              page={movementPage}
              loading={loading}
              loadingMore={loadingMore}
              error={error}
              failedCursor={failedCursor}
              target={movementTarget}
              onReload={(cursor) =>
                void loadMovements(movementTarget, {
                  append: cursor !== null,
                  cursor,
                })
              }
            />
          ) : selection.kind === "TODAY_ORDER" ? (
            <TodayOrderDetail
              row={selection.row}
              onSelectMovement={(target) =>
                setNavigation({
                  parentSelectionKey: currentSelectionKey,
                  target,
                })
              }
            />
          ) : (
            <PrePurchaseDetail row={selection.row} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TodayOrderDetail({
  row,
  onSelectMovement,
}: {
  row: InventoryQuantityMatrixRowDto;
  onSelectMovement: (target: MovementTarget) => void;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        오늘 주문 전체 수량을 구성하는 네 상태입니다. 생성된 잔액을
        선택하면 같은 창에서 수불 이력을 확인할 수 있습니다.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {TODAY_ORDER_INVENTORY_STATUSES.map((inventoryStatus) => {
          const cell = row.cells.find(
            (candidate) =>
              candidate.inventoryStatus === inventoryStatus
          );
          const hasBalance = cell?.balanceId !== null && cell?.balanceId !== undefined;
          const quantity = cell?.quantity ?? null;
          const content = (
            <>
              <span className="text-sm text-muted-foreground">
                {inventoryStatusLabel(inventoryStatus)}
              </span>
              <span className="text-xl font-semibold tabular-nums">
                {hasBalance ? quantityText(quantity) : "–"}
              </span>
              <span className="text-xs text-muted-foreground">
                {hasBalance ? "수불 이력 보기" : "생성된 잔액 없음"}
              </span>
            </>
          );

          return hasBalance && cell?.balanceId ? (
            <button
              key={inventoryStatus}
              type="button"
              className="grid gap-1 rounded-md border p-3 text-left hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${inventoryStatusLabel(
                inventoryStatus
              )} ${quantityText(quantity)} 수불 이력 보기`}
              onClick={() =>
                onSelectMovement({
                  row,
                  balanceId: cell.balanceId!,
                  inventoryStatus,
                })
              }
            >
              {content}
            </button>
          ) : (
            <div
              key={inventoryStatus}
              className="grid gap-1 rounded-md border border-dashed p-3"
            >
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PrePurchaseDetail({
  row,
}: {
  row: InventoryQuantityMatrixRowDto;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">검수 중</div>
          <div className="mt-1 text-xl font-semibold">
            {quantityText(row.prePurchase.inspectingQuantity)}
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">검수 완료</div>
          <div className="mt-1 text-xl font-semibold">
            {quantityText(row.prePurchase.inspectedQuantity)}
          </div>
        </div>
      </div>
      <div className="grid gap-2">
        <h3 className="text-sm font-semibold">최신 매입 전 PG</h3>
        {row.prePurchase.devices.map((device) => (
          <div
            key={`${device.inboundId}:${device.pgNo}`}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-sm font-semibold">
                {device.pgNo}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                차수 {device.inboundBatchId ?? "미지정"} ·{" "}
                {device.updatedAt}
              </div>
            </div>
            <Badge
              variant={
                device.inboundStatus === "INSPECTING" ? "warning" : "success"
              }
            >
              {device.inboundStatus === "INSPECTING"
                ? "검수 중"
                : "검수 완료"}
            </Badge>
          </div>
        ))}
        {row.prePurchase.devices.length === 0 ? (
          <FeedbackBanner tone="neutral">
            현재 매입 전 PG가 없습니다.
          </FeedbackBanner>
        ) : null}
      </div>
    </div>
  );
}

function MovementDetail({
  page,
  loading,
  loadingMore,
  error,
  failedCursor,
  target,
  onReload,
}: {
  page: InventoryQuantityMovementPageDto | null;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  failedCursor: number | null;
  target: MovementTarget;
  onReload: (cursor: number | null) => void;
}) {
  if (loading && !page) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="size-4 animate-spin" />
        수불 이력을 불러오는 중입니다.
      </div>
    );
  }

  if (error && !page) {
    return (
      <div className="grid gap-3">
        <FeedbackBanner tone="danger">{error}</FeedbackBanner>
        <Button
          type="button"
          variant="outline"
          onClick={() => onReload(null)}
        >
          <RefreshCw />
          다시 시도
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/35 px-3 py-2">
        <div>
          <div className="text-xs text-muted-foreground">현재 잔액</div>
          <div className="text-xl font-semibold tabular-nums">
            {quantityText(page?.balance.quantity ?? null)}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || loadingMore}
          onClick={() => onReload(null)}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          이력 새로고침
        </Button>
      </div>

      {error ? (
        <FeedbackBanner tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onReload(failedCursor)}
            >
              다시 시도
            </Button>
          </div>
        </FeedbackBanner>
      ) : null}

      <div className="grid gap-3">
        {page?.items.map((movement) => (
          <article
            key={movement.movementId}
            className="relative grid gap-2 rounded-md border p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">
                  {movement.movementType}
                </div>
                <div className="text-xs text-muted-foreground">
                  {movement.occurredAt}
                </div>
              </div>
              <div
                className={
                  movement.quantityDelta > 0
                    ? "font-semibold text-emerald-700"
                    : movement.quantityDelta < 0
                      ? "font-semibold text-red-700"
                      : "font-semibold"
                }
              >
                {deltaText(movement.quantityDelta)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
              <span className="text-muted-foreground">수량</span>
              <span className="col-span-1 font-medium sm:col-span-2">
                {quantityText(movement.beforeQuantity)} →{" "}
                {quantityText(movement.afterQuantity)}
              </span>
              <span className="text-muted-foreground">PG</span>
              <span className="col-span-1 font-mono sm:col-span-2">
                {movement.pgNo ?? "–"}
              </span>
              <span className="text-muted-foreground">업무 출처</span>
              <span className="col-span-1 sm:col-span-2">
                {sourceText(movement.sourceType, movement.sourceId)}
              </span>
              <span className="text-muted-foreground">처리자</span>
              <span className="col-span-1 sm:col-span-2">
                {movement.actorName ??
                  (movement.workerJobId ? "worker" : "시스템")}
              </span>
              <span className="text-muted-foreground">사유</span>
              <span className="col-span-1 sm:col-span-2">
                {movement.reason ?? "–"}
              </span>
            </div>
          </article>
        ))}
      </div>

      {page && page.items.length === 0 ? (
        <FeedbackBanner tone="neutral">
          현재 잔액은 {quantityText(page.balance.quantity)}이며 기록된 수불
          이력은 없습니다.
        </FeedbackBanner>
      ) : null}

      {page?.nextCursor ? (
        <Button
          type="button"
          variant="outline"
          disabled={loadingMore}
          onClick={() => onReload(page.nextCursor)}
        >
          <RefreshCw className={loadingMore ? "animate-spin" : ""} />
          {loadingMore ? "이력을 불러오는 중" : "더 불러오기"}
        </Button>
      ) : null}

      <span className="sr-only">
        선택한 재고 잔액 {target.balanceId}
      </span>
    </div>
  );
}
