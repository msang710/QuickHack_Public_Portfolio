"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
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
import { statusLabel } from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  TODAY_ORDER_INVENTORY_STATUSES,
  mergeInventoryQuantityMovementPages,
} from "@/quickhack_shared/inventory/inventory-quantity-matrix-view";
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

function quantityText(value: number | null, locale: string) {
  return value === null ? "–" : value.toLocaleString(locale);
}

function deltaText(value: number, locale: string) {
  return value > 0
    ? `+${value.toLocaleString(locale)}`
    : value.toLocaleString(locale);
}

function sourceText(sourceType: string, sourceId: string | null) {
  return sourceId ? `${sourceType} · ${sourceId}` : sourceType;
}

export function InventoryQuantityDetailSheet({
  selection,
  onOpenChange,
}: InventoryQuantityDetailSheetProps) {
  const t = useTranslations("inventory.quantityDetail");
  const detailT = useTranslations("common.deviceDetail");
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
            legacyApiMessage(payload, t("fallback.loadFailed"))
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
    [t]
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
    ? t("titles.movement", {
        status: statusLabel(movementTarget.inventoryStatus, detailT),
      })
    : selection.kind === "TODAY_ORDER"
      ? t("titles.todayOrder")
      : t("titles.prePurchase");

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
                aria-label={t("actions.back")}
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
  const t = useTranslations("inventory.quantityDetail");
  const detailT = useTranslations("common.deviceDetail");
  const locale = useLocale();

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {t("todayOrderDescription")}
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
                {statusLabel(inventoryStatus, detailT)}
              </span>
              <span className="text-xl font-semibold tabular-nums">
                {hasBalance ? quantityText(quantity, locale) : "–"}
              </span>
              <span className="text-xs text-muted-foreground">
                {hasBalance ? t("actions.history") : t("balance.empty")}
              </span>
            </>
          );

          return hasBalance && cell?.balanceId ? (
            <button
              key={inventoryStatus}
              type="button"
              className="grid gap-1 rounded-md border p-3 text-left hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("viewHistoryAria", {
                quantity: quantityText(quantity, locale),
                status: statusLabel(inventoryStatus, detailT),
              })}
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
  const t = useTranslations("inventory.quantityDetail");
  const locale = useLocale();

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">{t("prePurchase.inspecting")}</div>
          <div className="mt-1 text-xl font-semibold">
            {quantityText(row.prePurchase.inspectingQuantity, locale)}
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">{t("prePurchase.inspected")}</div>
          <div className="mt-1 text-xl font-semibold">
            {quantityText(row.prePurchase.inspectedQuantity, locale)}
          </div>
        </div>
      </div>
      <div className="grid gap-2">
        <h3 className="text-sm font-semibold">{t("prePurchase.latest")}</h3>
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
                {t("prePurchase.batch", {
                  batch:
                    device.inboundBatchId === null
                      ? t("prePurchase.unassigned")
                      : String(device.inboundBatchId),
                })} · {device.updatedAt}
              </div>
            </div>
            <Badge
              variant={
                device.inboundStatus === "INSPECTING" ? "warning" : "success"
              }
            >
              {device.inboundStatus === "INSPECTING"
                ? t("prePurchase.inspecting")
                : t("prePurchase.inspected")}
            </Badge>
          </div>
        ))}
        {row.prePurchase.devices.length === 0 ? (
          <FeedbackBanner tone="neutral">
            {t("prePurchase.empty")}
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
  const t = useTranslations("inventory.quantityDetail");
  const locale = useLocale();

  if (loading && !page) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="size-4 animate-spin" />
        {t("loading")}
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
          {t("actions.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/35 px-3 py-2">
        <div>
          <div className="text-xs text-muted-foreground">{t("balance.current")}</div>
          <div className="text-xl font-semibold tabular-nums">
            {quantityText(page?.balance.quantity ?? null, locale)}
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
          {t("actions.refresh")}
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
              {t("actions.retry")}
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
                {deltaText(movement.quantityDelta, locale)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
              <span className="text-muted-foreground">{t("movement.quantity")}</span>
              <span className="col-span-1 font-medium sm:col-span-2">
                {quantityText(movement.beforeQuantity, locale)} →{" "}
                {quantityText(movement.afterQuantity, locale)}
              </span>
              <span className="text-muted-foreground">PG</span>
              <span className="col-span-1 font-mono sm:col-span-2">
                {movement.pgNo ?? "–"}
              </span>
              <span className="text-muted-foreground">{t("movement.source")}</span>
              <span className="col-span-1 sm:col-span-2">
                {sourceText(movement.sourceType, movement.sourceId)}
              </span>
              <span className="text-muted-foreground">{t("movement.actor")}</span>
              <span className="col-span-1 sm:col-span-2">
                {movement.actorName ??
                  (movement.workerJobId ? "worker" : t("movement.system"))}
              </span>
              <span className="text-muted-foreground">{t("movement.reason")}</span>
              <span className="col-span-1 sm:col-span-2">
                {movement.reason ?? "–"}
              </span>
            </div>
          </article>
        ))}
      </div>

      {page && page.items.length === 0 ? (
        <FeedbackBanner tone="neutral">
          {t("balance.emptyHistory", {
            quantity: quantityText(page.balance.quantity, locale),
          })}
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
          {loadingMore ? t("actions.loadingMore") : t("actions.loadMore")}
        </Button>
      ) : null}

      <span className="sr-only">
        {t("balance.selected", { balanceId: target.balanceId })}
      </span>
    </div>
  );
}
