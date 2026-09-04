// QuickHack note: 네 통계 메뉴가 공유하는 닫힌 기간의 편집·적용·초기화를 담당합니다.
"use client";

import * as React from "react";
import { CalendarDays, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  resolveClosedStatisticsPeriod,
  resolveStatisticsPeriodSelection,
  StatisticsPeriodError,
  type StatisticsDateRange,
  type StatisticsPeriodSelection,
} from "@/quickhack_shared/statistics/statistics-period";

export type StatisticsPeriodToolbarProps = {
  selection: StatisticsPeriodSelection;
  onSelectionChange: (selection: StatisticsPeriodSelection) => void;
};

function appliedRange(
  kind: StatisticsPeriodSelection["kind"],
  fromDate: string,
  toDate: string
) {
  return resolveStatisticsPeriodSelection(
    kind === "custom"
      ? {
          kind,
          fromDate,
          toDate,
        }
      : { kind }
  ).range;
}

export function StatisticsPeriodToolbar({
  selection,
  onSelectionChange,
}: StatisticsPeriodToolbarProps) {
  const t = useTranslations("statistics.periodToolbar");
  const appliedKind = selection.kind;
  const appliedFromDate =
    selection.kind === "custom" ? selection.fromDate : "";
  const appliedToDate =
    selection.kind === "custom" ? selection.toDate : "";
  const currentDefaultPeriod = resolveClosedStatisticsPeriod();
  const [draft, setDraft] = React.useState<StatisticsDateRange>(() =>
    appliedRange(appliedKind, appliedFromDate, appliedToDate)
  );
  const [errorMessage, setErrorMessage] = React.useState("");

  const selectedRange =
    appliedKind === "custom"
      ? {
          fromDate: appliedFromDate,
          toDate: appliedToDate,
        }
      : currentDefaultPeriod.range;
  const draftMatchesApplied =
    draft.fromDate === selectedRange.fromDate &&
    draft.toDate === selectedRange.toDate;
  const canReset =
    appliedKind === "custom" ||
    draft.fromDate !== currentDefaultPeriod.range.fromDate ||
    draft.toDate !== currentDefaultPeriod.range.toDate;

  function updateDraft(field: keyof StatisticsDateRange, value: string) {
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
    setErrorMessage("");
  }

  function applyDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft.fromDate || !draft.toDate) {
      setErrorMessage(t("error.incomplete"));
      return;
    }

    try {
      const period = resolveClosedStatisticsPeriod({
        fromDate: draft.fromDate,
        toDate: draft.toDate,
      });

      setErrorMessage("");
      onSelectionChange({
        kind: "custom",
        fromDate: period.range.fromDate,
        toDate: period.range.toDate,
      });
    } catch (error: unknown) {
      if (error instanceof StatisticsPeriodError) {
        const key = error.code === "STATISTICS_PERIOD_INCOMPLETE_RANGE"
          ? "error.incomplete"
          : error.code === "STATISTICS_PERIOD_INVALID_DATE"
            ? "error.invalidDate"
            : error.code === "STATISTICS_PERIOD_REVERSED_RANGE"
              ? "error.reversed"
              : "error.openDate";
        setErrorMessage(t(key));
      } else {
        setErrorMessage(t("error.unknown"));
      }
    }
  }

  function resetToDefault() {
    setDraft(currentDefaultPeriod.range);
    setErrorMessage("");
    onSelectionChange({ kind: "default" });
  }

  return (
    <section
      aria-label={t("aria")}
      className="rounded-md border bg-popover px-4 py-3"
    >
      <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-end 2xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CalendarDays
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
            <div className="text-sm font-semibold">{t("title")}</div>
            <Badge variant={appliedKind === "default" ? "sky" : "purple"}>
              {appliedKind === "default" ? t("default") : t("custom")}
            </Badge>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("applied", { from: selectedRange.fromDate, to: selectedRange.toDate })}
          </div>
        </div>

        <form
          className="flex min-w-0 flex-wrap items-end gap-2"
          onSubmit={applyDraft}
        >
          <label className="grid min-w-[150px] flex-1 gap-1 2xl:flex-none">
            <span className="text-xs font-medium text-muted-foreground">
              {t("from")}
            </span>
            <Input
              aria-describedby={
                errorMessage ? "statistics-period-error" : undefined
              }
              max={currentDefaultPeriod.dataCutoffDate}
              onChange={(event) =>
                updateDraft("fromDate", event.target.value)
              }
              type="date"
              value={draft.fromDate}
            />
          </label>
          <label className="grid min-w-[150px] flex-1 gap-1 2xl:flex-none">
            <span className="text-xs font-medium text-muted-foreground">
              {t("to")}
            </span>
            <Input
              aria-describedby={
                errorMessage ? "statistics-period-error" : undefined
              }
              max={currentDefaultPeriod.dataCutoffDate}
              onChange={(event) =>
                updateDraft("toDate", event.target.value)
              }
              type="date"
              value={draft.toDate}
            />
          </label>
          <Button disabled={draftMatchesApplied} type="submit">
            {t("apply")}
          </Button>
          <Button
            disabled={!canReset}
            onClick={resetToDefault}
            type="button"
            variant="outline"
          >
            <RotateCcw aria-hidden="true" />
            {t("reset")}
          </Button>
        </form>
      </div>

      {errorMessage ? (
        <div
          className="mt-2 text-xs font-medium text-red-700"
          id="statistics-period-error"
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}
    </section>
  );
}
