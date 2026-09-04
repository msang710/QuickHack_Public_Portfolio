"use client";

import { useLocale, useTranslations } from "next-intl";
import type {
  InventoryStatisticsAgeBucketKey,
  InventoryStatisticsPeriodPreset,
  InventoryStatisticsPeriodTransitionRow,
  InventoryStatisticsPurchaseCostMetric,
  InventoryStatisticsStatusGroupKey,
  InventoryStatisticsTurnoverMetric,
} from "@/quickhack_shared/statistics/statistics";

export type InventoryTransitionMatrix = {
  columns: string[];
  rows: Array<Array<string | number>>;
};

export function useInventoryStatisticsPresentation() {
  const locale = useLocale();
  const t = useTranslations("statistics.inventory");
  const metricT = useTranslations("statistics.metric");
  const intlLocale = locale;

  const statusKeys: Record<InventoryStatisticsStatusGroupKey, string> = {
    SELLABLE: "status.sellable",
    ORDER_ALLOCATED: "status.allocated",
    SALES_RESTRICTED: "status.restricted",
    DELIVERING: "status.delivering",
    TRACKING_EXCEPTION: "status.trackingException",
    FINAL_DELIVERY: "status.finalDelivery",
    CLAIM_LOCATION_UNKNOWN: "status.claimUnknown",
  };
  const ageKeys: Record<InventoryStatisticsAgeBucketKey, string> = {
    DAYS_0_29: "age.days0_29",
    DAYS_30_59: "age.days30_59",
    DAYS_60_89: "age.days60_89",
    DAYS_90_PLUS: "age.days90Plus",
  };
  const periodKeys: Record<InventoryStatisticsPeriodPreset | "custom", string> = {
    "30d": "period.days30",
    "90d": "period.days90",
    "1y": "period.year1",
    all: "period.all",
    custom: "period.custom",
  };

  const translateKey = (key: string) => t(key as never);
  const formatNumber = (value: number | null) =>
    value === null ? t("unavailable.aggregate") : value.toLocaleString(intlLocale);
  const formatQuantity = (value: number | null) =>
    value === null ? t("unavailable.aggregate") : t("unit.device", { count: value });
  const formatPercent = (value: number | null) =>
    value === null ? t("unavailable.confirm") : `${value.toLocaleString(intlLocale)}%`;
  const formatCurrency = (value: number | null) =>
    value === null
      ? t("unavailable.aggregate")
      : new Intl.NumberFormat(intlLocale, {
          maximumFractionDigits: 0,
          style: "currency",
          currency: "KRW",
        }).format(value);

  const formatPurchaseCost = (metric: InventoryStatisticsPurchaseCostMetric) => {
    if (metric.totalQuantity === null) {
      return { value: t("unavailable.aggregate"), detail: t("metric.costUnavailable") };
    }
    if (metric.totalQuantity === 0) {
      return { value: formatCurrency(0), detail: t("metric.noInventory") };
    }
    return {
      value: metric.amount === null ? t("metric.noAmount") : formatCurrency(metric.amount),
      detail: t("metric.costDetail", {
        priced: formatQuantity(metric.pricedQuantity),
        missing: formatQuantity(metric.missingPriceQuantity),
        coverage: formatPercent(metric.coveragePercent),
      }),
    };
  };

  const formatTurnover = (metric: InventoryStatisticsTurnoverMetric) => ({
    value:
      metric.value === null
        ? t("unavailable.aggregate")
        : t("unit.turns", { count: metric.value }),
    detail:
      metric.value === null
        ? metric.unavailableReasonCode
          ? (metricT as unknown as (key: string, values?: Record<string, number>) => string)(`unavailableReason.${metric.unavailableReasonCode}`, {
              days: metric.unavailableReasonDays ?? 0,
            })
          : metric.unavailableReason ?? t("metric.turnoverUnavailable")
        : t("metric.turnoverDetail", {
            sold: formatQuantity(metric.soldQuantity),
            average: formatQuantity(metric.averageWarehouseQuantity),
          }),
  });

  const integrityMessage = (
    availability: "READY" | "EMPTY" | "PARTIAL",
    area: "asOf" | "aging" | "period"
  ) => {
    if (availability === "READY") return null;
    if (availability === "EMPTY") {
      return area === "period" ? t("integrity.emptyPeriod") : t("integrity.emptyInventory");
    }
    return t("integrity.partial", { area: t(`integrity.${area}`) });
  };

  const statusLabel = (key: InventoryStatisticsStatusGroupKey) => translateKey(statusKeys[key]);
  const buildTransitionMatrix = (
    transitions: InventoryStatisticsPeriodTransitionRow[]
  ): InventoryTransitionMatrix => {
    const keys: Array<InventoryStatisticsStatusGroupKey | null> = [
      null, "SELLABLE", "ORDER_ALLOCATED", "SALES_RESTRICTED", "DELIVERING",
      "TRACKING_EXCEPTION", "FINAL_DELIVERY", "CLAIM_LOCATION_UNKNOWN",
    ];
    const label = (key: InventoryStatisticsStatusGroupKey | null, side: "from" | "to") =>
      key === null ? t(side === "from" ? "status.created" : "status.removed") : statusLabel(key);
    const quantities = new Map(
      transitions.map((row) => [`${row.fromGroup ?? "NULL"}>${row.toGroup ?? "NULL"}`, row.quantity])
    );
    const fromKeys = keys.filter((fromKey) => transitions.some((row) => row.fromGroup === fromKey));
    const toKeys = keys.filter((toKey) => transitions.some((row) => row.toGroup === toKey));
    return {
      columns: [t("status.previous"), ...toKeys.map((key) => label(key, "to"))],
      rows: fromKeys.map((fromKey) => [
        label(fromKey, "from"),
        ...toKeys.map((toKey) => quantities.get(`${fromKey ?? "NULL"}>${toKey ?? "NULL"}`) ?? 0),
      ]),
    };
  };

  return {
    ageLabel: (key: InventoryStatisticsAgeBucketKey) => translateKey(ageKeys[key]),
    buildTransitionMatrix,
    formatNumber,
    formatPeriodRange: (from: string, to: string, days: number) => t("period.range", { from, to, days }),
    formatPurchaseCost,
    formatQuantity,
    formatTurnover,
    integrityMessage,
    periodLabel: (preset: InventoryStatisticsPeriodPreset | "custom") => translateKey(periodKeys[preset]),
    statusLabel,
  };
}

export function inventorySkuLabel(row: {
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
}) {
  return [row.model, row.storage, row.color, row.saleGrade]
    .filter((value) => value.trim())
    .join(" / ");
}
