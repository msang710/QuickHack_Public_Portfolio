"use client";

import * as React from "react";
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

type InventoryQuantityMatrixTableProps = {
  groups: readonly InventoryQuantityModelGroup[];
  columns: readonly InventoryQuantityMatrixColumn[];
  presetLabel: string;
  expandedGroupKeys: ReadonlySet<string>;
  autoExpandedGroupKeys: ReadonlySet<string>;
  onToggleGroup: (groupKey: string) => void;
  onSelect: (selection: InventoryQuantityDetailSelection) => void;
  emptyMessage: string;
};

function quantityText(value: number) {
  return value.toLocaleString("ko-KR");
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
  column: InventoryQuantityMatrixColumn;
  onSelect: (selection: InventoryQuantityDetailSelection) => void;
}) {
  const metric = inventoryQuantityMetricForRow(row, column);
  const selection = detailSelection(row, column);

  if (metric.displayQuantity === null) {
    return (
      <span
        className="text-muted-foreground"
        title={
          metric.calculatedQuantity === null
            ? "재고 원장 수량을 아직 확정할 수 없습니다."
            : "생성된 재고 잔액이 없습니다."
        }
      >
        –
      </span>
    );
  }

  if (!selection) {
    return (
      <span className="font-semibold tabular-nums">
        {quantityText(metric.displayQuantity)}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="min-w-8 rounded px-1.5 py-1 text-right font-semibold tabular-nums text-primary underline decoration-primary/35 underline-offset-4 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${rowDescription(row)} ${column.label} ${quantityText(
        metric.displayQuantity
      )} 상세 보기`}
      onClick={() => onSelect(selection)}
    >
      {quantityText(metric.displayQuantity)}
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
              상품 구분
            </th>
            <th
              colSpan={columns.length}
              className="sticky top-0 z-30 border-b bg-muted/95 px-3 text-left text-xs font-semibold text-muted-foreground backdrop-blur"
            >
              {presetLabel} 수량
            </th>
          </tr>
          <tr className="h-10">
            <th className="sticky left-0 top-9 z-40 w-11 border-b border-r bg-muted px-2 text-center text-xs font-medium">
              <span className="sr-only">기종 펼치기</span>
            </th>
            <th className="sticky left-11 top-9 z-40 w-[210px] border-b border-r bg-muted px-3 text-left text-xs font-medium">
              재고 SKU
            </th>
            <th className="sticky top-9 z-20 w-[105px] border-b border-r bg-muted px-3 text-left text-xs font-medium">
              용량
            </th>
            <th className="sticky top-9 z-20 w-[135px] border-b border-r bg-muted px-3 text-left text-xs font-medium">
              색상
            </th>
            <th className="sticky top-9 z-20 w-[90px] border-b border-r bg-muted px-3 text-left text-xs font-medium">
              등급
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
                        aria-label={`${group.model} 하위 재고 ${
                          expanded ? "접기" : "펼치기"
                        }`}
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
                        {group.rows.length.toLocaleString("ko-KR")}개 구성
                      </span>
                      {group.inactiveSkuCount > 0 ? (
                        <Badge variant="neutral">
                          비활성 {group.inactiveSkuCount}
                        </Badge>
                      ) : null}
                      {group.unclassifiedRowCount > 0 ? (
                        <Badge variant="warning">
                          미분류 {group.unclassifiedRowCount}
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
                          : quantityText(metric.displayQuantity)}
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
                              {row.skuCode ?? "SKU 미지정"}
                            </span>
                            {row.rowKind === "UNCLASSIFIED_INBOUND" ? (
                              <Badge variant="warning">미분류</Badge>
                            ) : row.skuActive === false ? (
                              <Badge variant="neutral">비활성</Badge>
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
