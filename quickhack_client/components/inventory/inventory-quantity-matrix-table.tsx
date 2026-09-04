"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import type { InventoryQuantityDetailSelection } from "@/quickhack_client/components/inventory/inventory-quantity-detail-sheet";
import {
  inventoryQuantityMetricForGroup,
  inventoryQuantityMetricForRow,
  type InventoryQuantityMatrixColumn,
  type InventoryQuantityModelGroup,
} from "@/quickhack_shared/inventory/inventory-quantity-matrix-view";
import type { InventoryQuantityMatrixRowDto } from "@/quickhack_shared/inventory/inventory-quantity";
import { cn } from "@/quickhack_shared/core/utils";

type PresentedInventoryQuantityMatrixColumn = InventoryQuantityMatrixColumn & {
  label: string;
  shortLabel: string;
};

type InventoryQuantityMatrixTableProps = {
  groups: readonly InventoryQuantityModelGroup[];
  columns: readonly PresentedInventoryQuantityMatrixColumn[];
  presetLabel: string;
  expandedGroupKeys: ReadonlySet<string>;
  autoExpandedGroupKeys: ReadonlySet<string>;
  onToggleGroup: (groupKey: string) => void;
  onSelect: (selection: InventoryQuantityDetailSelection) => void;
  emptyMessage: string;
};

function quantityText(value: number, locale: string) {
  return value.toLocaleString(locale);
}

function detailSelection(
  row: InventoryQuantityMatrixRowDto,
  column: InventoryQuantityMatrixColumn
): InventoryQuantityDetailSelection | null {
  const metric = inventoryQuantityMetricForRow(row, column);

  if (
    metric.detailKind === "MOVEMENT" &&
    metric.balanceId !== null &&
    metric.inventoryStatus
  ) {
    return {
      kind: "MOVEMENT",
      row,
      balanceId: metric.balanceId,
      inventoryStatus: metric.inventoryStatus,
    };
  }

  if (metric.detailKind === "TODAY_ORDER") {
    return {
      kind: "TODAY_ORDER",
      row,
    };
  }

  if (metric.detailKind === "PRE_PURCHASE") {
    return {
      kind: "PRE_PURCHASE",
      row,
    };
  }

  return null;
}

function rowDescription(row: InventoryQuantityMatrixRowDto) {
  return [row.model, row.storage, row.color, row.saleGrade]
    .filter(Boolean)
    .join(" ");
}

function QuantityCell({
  row,
  column,
  onSelect,
}: {
  row: InventoryQuantityMatrixRowDto;
  column: PresentedInventoryQuantityMatrixColumn;
  onSelect: (selection: InventoryQuantityDetailSelection) => void;
}) {
  const t = useTranslations("inventory.quantityMatrix");
  const locale = useLocale();
  const metric = inventoryQuantityMetricForRow(row, column);
  const selection = detailSelection(row, column);

  if (metric.displayQuantity === null) {
    return (
      <span
        className="text-muted-foreground"
        title={
          metric.calculatedQuantity === null
            ? t("unconfirmedLedger")
            : t("noBalance")
        }
      >
        –
      </span>
    );
  }

  if (!selection) {
    return (
      <span className="font-semibold tabular-nums">
        {quantityText(metric.displayQuantity, locale)}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="min-w-8 rounded px-1.5 py-1 text-right font-semibold tabular-nums text-primary underline decoration-primary/35 underline-offset-4 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("detailAria", {
        column: column.label,
        quantity: quantityText(metric.displayQuantity, locale),
        row: rowDescription(row),
      })}
      onClick={() => onSelect(selection)}
    >
      {quantityText(metric.displayQuantity, locale)}
    </button>
  );
}

export function InventoryQuantityMatrixTable({
  groups,
  columns,
  presetLabel,
  expandedGroupKeys,
  autoExpandedGroupKeys,
  onToggleGroup,
  onSelect,
  emptyMessage,
}: InventoryQuantityMatrixTableProps) {
  const t = useTranslations("inventory.quantityMatrix");
  const locale = useLocale();
  const minimumWidth = 560 + columns.length * 112;

  return (
    <div
      className="min-h-0 flex-1 overflow-auto rounded-md border bg-popover"
      data-inventory-quantity-matrix="true"
    >
      <table
        className="w-full border-separate border-spacing-0 text-sm"
        style={{ minWidth: `${minimumWidth}px` }}
      >
        <thead>
          <tr className="h-9">
            <th
              colSpan={5}
              className="sticky top-0 z-30 border-b border-r bg-muted/95 px-3 text-left text-xs font-semibold text-muted-foreground backdrop-blur"
            >
              {t("columns.product")}
            </th>
            <th
              colSpan={columns.length}
              className="sticky top-0 z-30 border-b bg-muted/95 px-3 text-left text-xs font-semibold text-muted-foreground backdrop-blur"
            >
              {t("columns.quantity", { preset: presetLabel })}
            </th>
          </tr>
          <tr className="h-10">
            <th className="sticky left-0 top-9 z-40 w-11 border-b border-r bg-muted px-2 text-center text-xs font-medium">
              <span className="sr-only">{t("columns.expandModel")}</span>
            </th>
            <th className="sticky left-11 top-9 z-40 w-[210px] border-b border-r bg-muted px-3 text-left text-xs font-medium">
              {t("columns.sku")}
            </th>
            <th className="sticky top-9 z-20 w-[105px] border-b border-r bg-muted px-3 text-left text-xs font-medium">
              {t("columns.storage")}
            </th>
            <th className="sticky top-9 z-20 w-[135px] border-b border-r bg-muted px-3 text-left text-xs font-medium">
              {t("columns.color")}
            </th>
            <th className="sticky top-9 z-20 w-[90px] border-b border-r bg-muted px-3 text-left text-xs font-medium">
              {t("columns.grade")}
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                className="sticky top-9 z-20 min-w-[112px] border-b border-r bg-muted px-3 text-right text-xs font-medium last:border-r-0"
                title={column.label}
              >
                {column.shortLabel}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const expanded =
              expandedGroupKeys.has(group.groupKey) ||
              autoExpandedGroupKeys.has(group.groupKey);

            return (
              <React.Fragment key={group.groupKey}>
                <tr className="h-11 bg-secondary/45">
                  <td
                    colSpan={5}
                    className="sticky left-0 z-10 border-b border-r bg-secondary px-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-expanded={expanded}
                        aria-label={t("groupAria", {
                          action: expanded
                            ? t("actions.collapse")
                            : t("actions.expand"),
                          model: group.model,
                        })}
                        onClick={() => onToggleGroup(group.groupKey)}
                      >
                        {expanded ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                      </button>
                      <span className="truncate font-semibold">{group.model}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t("groupCount", { count: group.rows.length })}
                      </span>
                      {group.inactiveSkuCount > 0 ? (
                        <Badge variant="neutral">
                          {t("badges.inactive", { count: group.inactiveSkuCount })}
                        </Badge>
                      ) : null}
                      {group.unclassifiedRowCount > 0 ? (
                        <Badge variant="warning">
                          {t("badges.unclassified", { count: group.unclassifiedRowCount })}
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  {columns.map((column) => {
                    const metric = inventoryQuantityMetricForGroup(
                      group,
                      column
                    );

                    return (
                      <td
                        key={column.key}
                        className="border-b border-r px-3 text-right font-semibold tabular-nums last:border-r-0"
                      >
                        {metric.displayQuantity === null
                          ? "–"
                          : quantityText(metric.displayQuantity, locale)}
                      </td>
                    );
                  })}
                </tr>
                {expanded
                  ? group.rows.map((row) => (
                      <tr
                        key={row.rowKey}
                        className={cn(
                          "h-12 bg-background hover:bg-muted/35",
                          row.skuActive === false && "text-muted-foreground"
                        )}
                      >
                        <td className="sticky left-0 z-10 border-b border-r bg-inherit" />
                        <td className="sticky left-11 z-10 border-b border-r bg-inherit px-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-mono text-xs">
                              {row.skuCode ?? t("missingSku")}
                            </span>
                            {row.rowKind === "UNCLASSIFIED_INBOUND" ? (
                              <Badge variant="warning">
                                {t("badges.unclassifiedSingle")}
                              </Badge>
                            ) : row.skuActive === false ? (
                              <Badge variant="neutral">
                                {t("badges.inactiveSingle")}
                              </Badge>
                            ) : null}
                          </div>
                        </td>
                        <td className="border-b border-r px-3">{row.storage}</td>
                        <td className="border-b border-r px-3">{row.color}</td>
                        <td className="border-b border-r px-3">{row.saleGrade}</td>
                        {columns.map((column) => (
                          <td
                            key={column.key}
                            className="border-b border-r px-3 text-right last:border-r-0"
                          >
                            <QuantityCell
                              row={row}
                              column={column}
                              onSelect={onSelect}
                            />
                          </td>
                        ))}
                      </tr>
                    ))
                  : null}
              </React.Fragment>
            );
          })}
          {groups.length === 0 ? (
            <tr>
              <td
                colSpan={5 + columns.length}
                className="h-40 px-4 text-center text-sm text-muted-foreground"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
