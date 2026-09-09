"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { RefreshCw } from "lucide-react";
import {
  InventoryQuantityDetailSheet,
  type InventoryQuantityDetailSelection,
} from "@/quickhack_client/components/inventory/inventory-quantity-detail-sheet";
import {
  InboundReconciliationDetailSheet,
  type InboundReconciliationDetailSelection,
} from "@/quickhack_client/components/inventory/inbound-reconciliation-detail-sheet";
import { InventoryQuantityMatrixTable } from "@/quickhack_client/components/inventory/inventory-quantity-matrix-table";
import { statusLabel } from "@/quickhack_client/components/shared/device-detail-sheet";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import {
  INVENTORY_QUANTITY_MATRIX_PRESETS,
  buildInventoryQuantityModelGroups,
  filterInventoryQuantityModelGroups,
  type InventoryQuantityMatrixPreset,
} from "@/quickhack_shared/inventory/inventory-quantity-matrix-view";
import type {
  InventoryLedgerAvailability,
  InventoryQuantityMatrixPayload,
} from "@/quickhack_shared/inventory/inventory-quantity";
import { cn } from "@/quickhack_shared/core/utils";

type MatrixApiResponse = {
  ok: boolean;
  message?: string;
  data?: InventoryQuantityMatrixPayload;
};

const PRESET_ORDER: readonly InventoryQuantityMatrixPreset[] = [
  "SUMMARY",
  "OUTBOUND",
  "EXCEPTIONS",
  "ALL",
];

function quantityText(value: number | null, locale: string) {
  return value === null ? "–" : value.toLocaleString(locale);
}

function SummaryCard({
  label,
  value,
  description,
}: {
  label: string;
  value: number | null;
  description: string;
}) {
  const locale = useLocale();
  return (
    <div className="min-w-0 rounded-md border bg-popover px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">
        {quantityText(value, locale)}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {description}
      </div>
    </div>
  );
}

function AvailabilityBanner({
  availability,
}: {
  availability: InventoryLedgerAvailability;
}) {
  const t = useTranslations("inventory.quantityLedger.availability");
  if (availability === "READY") {
    return null;
  }

  if (availability === "EMPTY") {
    return (
      <FeedbackBanner tone="info">
        {t("empty")}
      </FeedbackBanner>
    );
  }

  return (
    <FeedbackBanner tone="danger">
      {t("mismatch")}
    </FeedbackBanner>
  );
}

function ReconciliationMetricButton({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick: () => void;
}) {
  const t = useTranslations("inventory.quantityLedger");
  const locale = useLocale();
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("detailAria", {
        label,
        quantity: quantityText(value, locale),
      })}
      onClick={onClick}
    >
      <span>{label}</span>
      <strong className="tabular-nums">{quantityText(value, locale)}</strong>
    </button>
  );
}

export function InventoryQuantityLedgerView({
  onOpenInventoryEdit,
}: {
  onOpenInventoryEdit: (pgNo: string) => void;
}) {
  const t = useTranslations("inventory.quantityLedger");
  const detailT = useTranslations("common.deviceDetail");
  const [data, setData] =
    React.useState<InventoryQuantityMatrixPayload | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [preset, setPreset] =
    React.useState<InventoryQuantityMatrixPreset>("SUMMARY");
  const [search, setSearch] = React.useState("");
  const [expandedGroupKeys, setExpandedGroupKeys] = React.useState<
    Set<string>
  >(() => new Set());
  const [selection, setSelection] =
    React.useState<InventoryQuantityDetailSelection | null>(null);
  const [reconciliationSelection, setReconciliationSelection] =
    React.useState<InboundReconciliationDetailSelection | null>(null);
  const requestSequenceRef = React.useRef(0);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  const load = React.useCallback(async () => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        "/api/inventory/quantity-ledger?format=matrix",
        {
          cache: "no-store",
          signal: controller.signal,
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | MatrixApiResponse
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
  }, [t]);

  React.useEffect(() => {
    queueMicrotask(() => void load());

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [load]);

  const groups = React.useMemo(
    () => buildInventoryQuantityModelGroups(data?.rows ?? []),
    [data?.rows]
  );
  const filtered = React.useMemo(
    () => filterInventoryQuantityModelGroups(groups, search),
    [groups, search]
  );
  const autoExpandedGroupKeys = React.useMemo(
    () => new Set(filtered.autoExpandedGroupKeys),
    [filtered.autoExpandedGroupKeys]
  );
  const localizedPreset = React.useCallback((presetKey: InventoryQuantityMatrixPreset) => {
    const source = INVENTORY_QUANTITY_MATRIX_PRESETS[presetKey];
    const presetName = presetKey === "SUMMARY" ? "summary" : presetKey === "OUTBOUND" ? "outbound" : presetKey === "EXCEPTIONS" ? "exceptions" : "all";
    return {
      label: t(`presets.${presetName}.label`),
      description: t(`presets.${presetName}.description`),
      columns: source.columns.map((column) => {
        if (column.kind === "STATUS") {
          const label = statusLabel(column.inventoryStatus, detailT);
          return { ...column, label, shortLabel: label };
        }
        const key = column.kind === "SELLABLE" ? "sellable" : column.kind === "TODAY_ORDER" ? "todayOrder" : column.kind === "PRE_PURCHASE" ? "prePurchase" : "total";
        return { ...column, label: t(`matrixColumns.${key}.label`), shortLabel: t(`matrixColumns.${key}.short`) };
      }),
    };
  }, [detailT, t]);
  const presetDefinition = localizedPreset(preset);

  const toggleGroup = React.useCallback((groupKey: string) => {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);

      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }

      return next;
    });
  }, []);

  return (
    <WorkspacePageFrame className="gap-3 px-5 py-4">
      <div className="grid shrink-0 grid-cols-2 gap-2 xl:grid-cols-4">
        <SummaryCard
          label={t("summary.sellable")}
          value={data?.summary.sellableQuantity ?? null}
          description={t("summary.sellableDescription")}
        />
        <SummaryCard
          label={t("summary.todayOrder")}
          value={data?.summary.todayOrderQuantity ?? null}
          description={t("summary.todayOrderDescription")}
        />
        <SummaryCard
          label={t("summary.prePurchase")}
          value={data?.summary.prePurchaseQuantity ?? null}
          description={t("summary.prePurchaseDescription")}
        />
        <SummaryCard
          label={t("summary.total")}
          value={data?.summary.primaryTotalQuantity ?? null}
          description={t("summary.totalDescription")}
        />
      </div>

      {data ? (
        <AvailabilityBanner availability={data.availability} />
      ) : null}

      {error ? (
        <FeedbackBanner tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {error}
              {data
                ? t("staleSuffix")
                : ""}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              {t("actions.retry")}
            </Button>
          </div>
        </FeedbackBanner>
      ) : null}

      {data ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-muted/25 px-3 py-2 text-xs">
          <span className="font-semibold">
            {t("reconciliation.title", { date: data.reconciliation.businessDate })}
          </span>
          <ReconciliationMetricButton
            label={t("reconciliation.unassigned")}
            value={data.reconciliation.unassignedPgQuantity}
            onClick={() =>
              setReconciliationSelection({
                businessDate: data.reconciliation.businessDate,
                scope: "UNASSIGNED",
              })
            }
          />
          <ReconciliationMetricButton
            label={t("reconciliation.mismatched")}
            value={data.reconciliation.mismatchedBatchQuantity}
            onClick={() =>
              setReconciliationSelection({
                businessDate: data.reconciliation.businessDate,
                scope: "MISMATCHED",
              })
            }
          />
          <ReconciliationMetricButton
            label={t("reconciliation.shortage")}
            value={data.reconciliation.shortageQuantity}
            onClick={() =>
              setReconciliationSelection({
                businessDate: data.reconciliation.businessDate,
                scope: "SHORTAGE",
              })
            }
          />
          <ReconciliationMetricButton
            label={t("reconciliation.excess")}
            value={data.reconciliation.excessQuantity}
            onClick={() =>
              setReconciliationSelection({
                businessDate: data.reconciliation.businessDate,
                scope: "EXCESS",
              })
            }
          />
          <span className="text-muted-foreground">
            {t("reconciliation.hint")}
          </span>
        </div>
      ) : null}

      <div className="flex shrink-0 flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <div
          className="inline-flex w-fit rounded-md border bg-muted/35 p-1"
          aria-label={t("search.columnsAria")}
        >
          {PRESET_ORDER.map((presetKey) => {
            const definition = localizedPreset(presetKey);

            return (
              <button
                key={presetKey}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  preset === presetKey
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-pressed={preset === presetKey}
                title={definition.description}
                onClick={() => setPreset(presetKey)}
              >
                {definition.label}
              </button>
            );
          })}
        </div>
        <div className="flex w-full gap-2 xl:w-auto">
          <SearchInput
            value={search}
            onValueChange={setSearch}
            label={t("search.label")}
            placeholder={t("search.placeholder")}
            wrapperClassName="min-w-0 flex-1 xl:w-[410px]"
          />
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            {t("actions.refresh")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 items-center justify-between text-xs text-muted-foreground">
          <span>
            {t("search.result", {
              configurations: filtered.groups.reduce(
                (sum, group) => sum + group.rows.length,
                0
              ),
              models: filtered.groups.length,
            })}
          </span>
          <span>{presetDefinition.description}</span>
        </div>
        <InventoryQuantityMatrixTable
          groups={filtered.groups}
          columns={presetDefinition.columns}
          presetLabel={presetDefinition.label}
          expandedGroupKeys={expandedGroupKeys}
          autoExpandedGroupKeys={autoExpandedGroupKeys}
          onToggleGroup={toggleGroup}
          onSelect={setSelection}
          emptyMessage={
            loading && !data
              ? t("empty.loading")
              : search.trim()
                ? t("empty.search")
                : t("empty.default")
          }
        />
      </div>

      <InventoryQuantityDetailSheet
        selection={selection}
        onOpenChange={(open) => {
          if (!open) {
            setSelection(null);
          }
        }}
      />
      <InboundReconciliationDetailSheet
        selection={reconciliationSelection}
        onOpenChange={(open) => {
          if (!open) {
            setReconciliationSelection(null);
          }
        }}
        onOpenInventoryEdit={onOpenInventoryEdit}
      />
    </WorkspacePageFrame>
  );
}
