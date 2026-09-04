// QuickHack note: 매입가 지정/매입 대기 목록에서 공유하는 가격 포맷, 조건 메모 입력, 매입가 매트릭스 표 도구입니다.
"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Input } from "@/quickhack_client/components/ui/input";
import { SuggestInput } from "@/quickhack_client/components/ui/search-select";
import { TableSelectCheckbox } from "@/quickhack_client/components/ui/table-select-checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/quickhack_client/components/ui/table";

export type PurchasePriceDraft = {
  purchasePrice: string;
};

type PurchasePriceRateLike = {
  purchasePrice: number;
};

export type PurchasePriceCriteriaCell = {
  key: string;
  modelOptionId: number;
  storageOptionId: number;
  appearanceGradeOptionId: number;
  appearanceGrade: string;
};

export type PurchasePriceMatrixRow = {
  key: string;
  modelOptionId: number;
  storageOptionId: number;
  model: string;
  storage: string;
  cells: PurchasePriceCriteriaCell[];
  searchText: string;
};

export type PurchasePreviousPriceDraftTarget = {
  key: string;
  previousPrice: number;
};

type PurchasePriceMatrixTableProps = {
  rows: PurchasePriceMatrixRow[];
  visibleGradeOptions: Array<{ optionId: number; label: string }>;
  ratesByKey: ReadonlyMap<string, PurchasePriceRateLike>;
  previousRatesByKey: ReadonlyMap<string, PurchasePriceRateLike>;
  draftForCell: (key: string) => PurchasePriceDraft;
  applyPreviousPriceDraft: (
    key: string,
    previousPrice: number,
    checked: boolean
  ) => void;
  applyPreviousPriceDrafts: (
    targets: PurchasePreviousPriceDraftTarget[],
    checked: boolean
  ) => void;
  updateRateDraft: (
    key: string,
    updater: (current: PurchasePriceDraft) => PurchasePriceDraft
  ) => void;
};

export const SALE_PRODUCT_GRADE_OPTIONS = ["A", "A-", "B+", "B"];

export function formatPrice(value: number | null, locale: string) {
  if (value === null || value === undefined) {
    return "-";
  }

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPriceWithWonSymbol(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "KRW",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPriceInput(value: string, locale: string) {
  const digitsOnly = value.replace(/[^\d]/g, "");

  return digitsOnly ? Number(digitsOnly).toLocaleString(locale) : "";
}

export function parsePriceInput(value: string) {
  const normalized = value.replace(/,/g, "").trim();

  return /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : null;
}

export function todayKstDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDaysToDateString(value: string, days: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return "";
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return date.toISOString().slice(0, 10);
}

export function PurchaseConditionNoteInput({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const t = useTranslations("inbound.purchasePrice.note");

  return (
    <SuggestInput
      label={t("label")}
      value={value}
      options={options}
      placeholder={t("placeholder")}
      emptyLabel={t("default")}
      className="min-w-[220px]"
      onValueChange={onChange}
    />
  );
}

export function purchasePriceCriteriaKey({
  model,
  storage,
  appearanceGrade,
}: {
  model: string;
  storage: string;
  appearanceGrade: string;
}) {
  return [model, storage, appearanceGrade].join("\u001f");
}

export function purchasePriceOptionKey({
  modelOptionId,
  storageOptionId,
  appearanceGradeOptionId,
}: {
  modelOptionId: number;
  storageOptionId: number;
  appearanceGradeOptionId: number;
}) {
  return [modelOptionId, storageOptionId, appearanceGradeOptionId].join("\u001f");
}

// QuickHack object: 매입가 지정 메뉴에서 기종/용량 행과 외관등급별 가격 입력 셀을 렌더링하는 전용 편집 표입니다.
export function PurchasePriceMatrixTable({
  rows,
  visibleGradeOptions,
  ratesByKey,
  previousRatesByKey,
  draftForCell,
  applyPreviousPriceDraft,
  applyPreviousPriceDrafts,
  updateRateDraft,
}: PurchasePriceMatrixTableProps) {
  const t = useTranslations("inbound.purchasePrice");
  const locale = useLocale();

  function previousPriceTargetsForRow(row: PurchasePriceMatrixRow) {
    return visibleGradeOptions.flatMap((grade) => {
      const cell = row.cells.find(
        (item) => item.appearanceGradeOptionId === grade.optionId
      );

      if (!cell) {
        return [];
      }

      const previousRate = previousRatesByKey.get(cell.key);

      return previousRate
        ? [{ key: cell.key, previousPrice: previousRate.purchasePrice }]
        : [];
    });
  }

  function previousPriceSelectionState(
    targets: PurchasePreviousPriceDraftTarget[]
  ) {
    const checkedCount = targets.filter((target) => {
      const previousPriceText = target.previousPrice.toLocaleString(locale);

      return draftForCell(target.key).purchasePrice === previousPriceText;
    }).length;

    return {
      checked: targets.length > 0 && checkedCount === targets.length,
      indeterminate: checkedCount > 0 && checkedCount < targets.length,
      disabled: targets.length === 0,
    };
  }

  const allPreviousPriceTargets = rows.flatMap(previousPriceTargetsForRow);
  const allPreviousPriceSelectionState = previousPriceSelectionState(
    allPreviousPriceTargets
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-popover">
      <Table className="min-w-[1060px]">
        <TableHeader className="sticky top-0 z-10 bg-secondary">
          <TableRow>
            <TableHead className="min-w-[240px]">{t("columns.model")}</TableHead>
            <TableHead className="w-[110px]">{t("columns.storage")}</TableHead>
            <TableHead className="w-[78px] text-center">
              <TableSelectCheckbox
                checked={allPreviousPriceSelectionState.checked}
                indeterminate={allPreviousPriceSelectionState.indeterminate}
                disabled={allPreviousPriceSelectionState.disabled}
                ariaLabel={t("previous.allAria")}
                onCheckedChange={(checked) =>
                  applyPreviousPriceDrafts(allPreviousPriceTargets, checked)
                }
              />
            </TableHead>
            {visibleGradeOptions.map((grade) => (
              <TableHead key={grade.optionId} className="min-w-[190px]">
                {grade.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={3 + visibleGradeOptions.length}
                className="h-64 text-center text-sm text-muted-foreground"
              >
                {t("empty")}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.key}>
                {(() => {
                  const rowPreviousPriceTargets = previousPriceTargetsForRow(row);
                  const rowPreviousPriceSelectionState =
                    previousPriceSelectionState(rowPreviousPriceTargets);

                  return (
                    <>
                      <TableCell className="font-semibold">{row.model}</TableCell>
                      <TableCell>{row.storage}</TableCell>
                      <TableCell className="text-center">
                        <TableSelectCheckbox
                          checked={rowPreviousPriceSelectionState.checked}
                          indeterminate={
                            rowPreviousPriceSelectionState.indeterminate
                          }
                          disabled={rowPreviousPriceSelectionState.disabled}
                          ariaLabel={t("previous.rowAria", {
                            model: row.model,
                            storage: row.storage,
                          })}
                          onCheckedChange={(checked) =>
                            applyPreviousPriceDrafts(
                              rowPreviousPriceTargets,
                              checked
                            )
                          }
                        />
                      </TableCell>
                    </>
                  );
                })()}
                {visibleGradeOptions.map((grade) => {
                  const cell = row.cells.find(
                    (item) => item.appearanceGradeOptionId === grade.optionId
                  );

                  if (!cell) {
                    return (
                      <TableCell
                        key={grade.optionId}
                        className="text-sm text-muted-foreground"
                      />
                    );
                  }

                  const draft = draftForCell(cell.key);
                  const rate = ratesByKey.get(cell.key);
                  const previousRate = previousRatesByKey.get(cell.key);
                  const previousPriceText = previousRate
                    ? previousRate.purchasePrice.toLocaleString(locale)
                    : "";
                  const isPreviousPriceChecked =
                    Boolean(previousRate) &&
                    draft.purchasePrice === previousPriceText;

                  return (
                    <TableCell key={cell.key} className="align-top">
                      <div className="grid gap-1.5">
                        {rate ? (
                          <span className="text-xs font-medium tabular-nums">
                            {formatPrice(rate.purchasePrice, locale)}
                          </span>
                        ) : null}
                        {previousRate ? (
                          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <input
                              type="checkbox"
                              className="size-3.5 rounded border-input"
                              checked={isPreviousPriceChecked}
                              aria-label={t("previous.cellAria", {
                                grade: grade.label,
                                model: row.model,
                                storage: row.storage,
                              })}
                              onChange={(event) =>
                                applyPreviousPriceDraft(
                                  cell.key,
                                  previousRate.purchasePrice,
                                  event.target.checked
                                )
                              }
                            />
                            <span>
                              {t("previous.unchanged", {
                                price: formatPriceWithWonSymbol(
                                  previousRate.purchasePrice,
                                  locale
                                ),
                              })}
                            </span>
                          </label>
                        ) : (
                          <div className="text-[11px] text-muted-foreground">
                            {t("previous.none")}
                          </div>
                        )}
                        <Input
                          inputMode="numeric"
                          value={draft.purchasePrice}
                          placeholder={
                            rate ? formatPrice(rate.purchasePrice, locale) : "0"
                          }
                          onChange={(event) =>
                            updateRateDraft(cell.key, (current) => ({
                              ...current,
                              purchasePrice: formatPriceInput(
                                event.target.value,
                                locale
                              ),
                            }))
                          }
                        />
                      </div>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
