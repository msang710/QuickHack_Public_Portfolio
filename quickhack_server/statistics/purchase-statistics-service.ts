// QuickHack service: aggregate-only purchase statistics for completed inbound cycles.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  apiDate,
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { quickHackClock, parseKstSqlDateTime } from "@/quickhack_shared/core/time";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import { PURCHASE_PRICE_ENTRY_MODE } from "@/quickhack_shared/inbound/purchase-price-entry-mode";
import { actualDefectText } from "@/quickhack_shared/inspection/inspection-schema";
import type {
  PurchaseAmountMetric,
  PurchaseDurationMetric,
  PurchasePricePolicyRow,
  PurchaseProductPerformanceRow,
  PurchaseRateMetric,
  PurchaseStatisticsData,
  PurchaseSupplierPerformanceRow,
  StatisticsGroup,
} from "@/quickhack_shared/statistics/statistics";
import {
  resolveClosedStatisticsPeriod,
  statisticsDateTimeBounds,
  type StatisticsPeriodContext,
} from "@/quickhack_shared/statistics/statistics-period";
import { loadStatisticsCursorPages } from "@/quickhack_server/statistics/statistics-loader";
import { liveStatisticsCalculationMetadata } from "@/quickhack_server/statistics/statistics-period-request";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const UNKNOWN_SUPPLIER = "미기록 매입처";
const UNKNOWN_MODEL = "미기록 기종";
const UNKNOWN_STORAGE = "미기록 용량";
const UNKNOWN_GRADE = "미기록 등급";
const PRICE_POLICY_MODES = ["RATE", "OVERRIDE", "MANUAL", "UNKNOWN"] as const;
const KST_MONTH_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
});

type PricePolicyMode = (typeof PRICE_POLICY_MODES)[number];

export type PurchaseStatisticsInspectionInput = {
  inspectionId: number;
  inspectionType: string;
  checkedAt: string | null;
  appearanceCheckedAt: string | null;
  functionCheckedAt: string | null;
  appearanceGrade: string | null;
  appearanceDefect: string | null;
  functionDefect: string | null;
  returnYn: string;
};

export type PurchaseStatisticsInboundInput = {
  inboundId: number;
  pgNo: string;
  inboundStatus: string;
  supplierName: string | null;
  purchasePrice: number | null;
  purchasePriceReferenceAmount: number | null;
  purchasePriceEntryMode: string | null;
  receivedAt: string | null;
  priceAgreedAt: string | null;
  supplierReturnedAt: string | null;
  batchDate: string | null;
  batchNo: number | null;
  imei: string | null;
  model: string;
  storage: string | null;
  color: string | null;
  inspections: PurchaseStatisticsInspectionInput[];
};

export type PurchaseStatisticsSaleInput = {
  saleRecordId: number;
  allocationId: number;
  pgNo: string;
  purchaseInboundId: number | null;
  supplierName: string | null;
  purchaseAgreedAt: string | null;
  purchasePrice: number | null;
  soldAt: string;
  saleStatus: string;
  model: string | null;
  storage: string | null;
  color: string | null;
  saleGrade: string | null;
};

export type PurchaseStatisticsAggregateInput = {
  inbounds: PurchaseStatisticsInboundInput[];
  sales: PurchaseStatisticsSaleInput[];
};

type PreparedInbound = PurchaseStatisticsInboundInput & {
  supplierKey: string;
  modelKey: string;
  storageKey: string;
  purchaseGrade: string | null;
  purchaseGradeKey: string;
  purchaseDate: Date | null;
  supplierReturnDate: Date | null;
  terminalDate: Date | null;
  receivedDate: Date | null;
  lastInspectionDate: Date | null;
  appearanceDefects: string[];
  functionDefects: string[];
  hasInspectionEvidence: boolean;
  hasDefect: boolean;
  pricePolicyMode: PricePolicyMode;
};

type PreparedSale = PurchaseStatisticsSaleInput & {
  supplierKey: string | null;
  purchaseAgreedDate: Date | null;
  soldDate: Date | null;
};

type MonthlyAccumulator = {
  purchaseCount: number;
  purchaseAmount: number;
  pricedPurchaseCount: number;
  missingPurchasePriceCount: number;
  supplierReturnCount: number;
  inspectionDefectOutcomeCount: number;
};

const purchaseStatisticsInboundSelect = {
  inbound_id: true,
  pg_no: true,
  inbound_status: true,
  supplier_name: true,
  purchase_price: true,
  purchase_price_reference_amount: true,
  purchase_price_entry_mode: true,
  received_at: true,
  price_agreed_at: true,
  supplier_returned_at: true,
  inbound_batch: {
    select: {
      batch_date: true,
      batch_no: true,
    },
  },
  devices: {
    select: {
      imei: true,
      model: true,
      storage: true,
      color: true,
    },
  },
  inspections: {
    select: {
      inspection_id: true,
      inspection_type: true,
      checked_at: true,
      appearance_checked_at: true,
      function_checked_at: true,
      appearance_grade: true,
      appearance_defect: true,
      function_defect: true,
      return_yn: true,
    },
    orderBy: { inspection_id: "asc" },
  },
} satisfies Prisma.inboundsSelect;

function nullableText(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function parseDate(value: string | null | undefined) {
  const text = nullableText(value);

  if (!text) {
    return null;
  }

  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    const parsed = new Date(text);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(text)) {
    return parseKstSqlDateTime(text);
  }

  const localIso = /^\d{4}-\d{2}-\d{2}T/.test(text)
    ? `${text}+09:00`
    : text;
  const parsed = new Date(localIso);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function round(value: number, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function percentage(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : round((numerator / denominator) * 100);
}

function rateMetric(
  numerator: number,
  denominator: number,
  unavailableReason = "집계 가능한 분모가 없습니다."
): PurchaseRateMetric {
  if (denominator === 0) {
    return {
      value: null,
      numerator,
      denominator,
      unavailableReason,
    };
  }

  return {
    value: percentage(numerator, denominator),
    numerator,
    denominator,
  };
}

function validMoney(value: number | null | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function amountMetric<T>(
  rows: T[],
  price: (row: T) => number | null
): PurchaseAmountMetric {
  const prices = rows.map(price).filter(validMoney);

  return {
    amount:
      prices.length === 0
        ? null
        : prices.reduce((sum, value) => sum + value, 0),
    pricedCount: prices.length,
    totalCount: rows.length,
    coveragePercent: percentage(prices.length, rows.length),
  };
}

function averageAmount(metric: PurchaseAmountMetric) {
  return metric.amount === null || metric.pricedCount === 0
    ? null
    : Math.round(metric.amount / metric.pricedCount);
}

function percentileNearestRank(sorted: number[], percentile: number) {
  if (sorted.length === 0) {
    return null;
  }

  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? null;
}

function durationMetric(
  values: number[],
  excludedAnomalyCount: number
): PurchaseDurationMetric {
  const sorted = values.slice().sort((left, right) => left - right);
  let median: number | null = null;

  if (sorted.length > 0) {
    const middle = Math.floor(sorted.length / 2);
    median =
      sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
  }

  return {
    sampleCount: sorted.length,
    medianHours: median === null ? null : round(median),
    p90Hours:
      sorted.length === 0
        ? null
        : round(percentileNearestRank(sorted, 0.9) ?? 0),
    excludedAnomalyCount,
  };
}

function monthKey(date: Date) {
  const parts = Object.fromEntries(
    KST_MONTH_FORMATTER.formatToParts(date).map((part) => [
      part.type,
      part.value,
    ])
  );
  return `${parts.year ?? "0000"}-${parts.month ?? "00"}`;
}

function countGroups(values: string[]): StatisticsGroup[] {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Array.from(counts, ([label, count]) => ({ label, count })).sort(
    (left, right) =>
      right.count - left.count ||
      left.label.localeCompare(right.label, "ko-KR")
  );
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const groupKey = key(row);
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }

  return groups;
}

function inspectionDateCandidates(
  inspection: PurchaseStatisticsInspectionInput
) {
  return [
    inspection.checkedAt,
    inspection.appearanceCheckedAt,
    inspection.functionCheckedAt,
  ];
}

function latestInspectionDate(
  inspections: PurchaseStatisticsInspectionInput[]
) {
  return inspections
    .flatMap(inspectionDateCandidates)
    .map(parseDate)
    .filter((value): value is Date => value !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
}

function purchaseGrade(
  inspections: PurchaseStatisticsInspectionInput[]
) {
  return (
    inspections
      .slice()
      .sort((left, right) => right.inspectionId - left.inspectionId)
      .map((inspection) => nullableText(inspection.appearanceGrade))
      .find((value): value is string => value !== null) ?? null
  );
}

function defectParts(value: unknown) {
  const normalized = actualDefectText(value);

  if (!normalized) {
    return [];
  }

  return normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function pricePolicyMode(value: unknown): PricePolicyMode {
  const normalized = nullableText(value)?.toUpperCase();

  if (
    normalized === PURCHASE_PRICE_ENTRY_MODE.rate ||
    normalized === PURCHASE_PRICE_ENTRY_MODE.override ||
    normalized === PURCHASE_PRICE_ENTRY_MODE.manual
  ) {
    return normalized;
  }

  return "UNKNOWN";
}

function prepareInbounds(input: PurchaseStatisticsAggregateInput) {
  return input.inbounds
    .filter(
      (inbound) =>
        inbound.inboundStatus === INBOUND_STATUS.purchased ||
        inbound.inboundStatus === INBOUND_STATUS.supplierReturn
    )
    .map<PreparedInbound>((inbound) => {
      const supplierKey = nullableText(inbound.supplierName) ?? UNKNOWN_SUPPLIER;
      const modelKey = nullableText(inbound.model) ?? UNKNOWN_MODEL;
      const storageKey = nullableText(inbound.storage) ?? UNKNOWN_STORAGE;
      const grade = purchaseGrade(inbound.inspections);
      const purchaseDate = parseDate(inbound.priceAgreedAt);
      const supplierReturnDate = parseDate(inbound.supplierReturnedAt);
      const appearanceDefects = inbound.inspections.flatMap((inspection) =>
        defectParts(inspection.appearanceDefect)
      );
      const functionDefects = inbound.inspections.flatMap((inspection) =>
        defectParts(inspection.functionDefect)
      );

      return {
        ...inbound,
        supplierKey,
        modelKey,
        storageKey,
        purchaseGrade: grade,
        purchaseGradeKey: grade ?? UNKNOWN_GRADE,
        purchaseDate,
        supplierReturnDate,
        terminalDate:
          inbound.inboundStatus === INBOUND_STATUS.purchased
            ? purchaseDate
            : supplierReturnDate,
        receivedDate: parseDate(inbound.receivedAt),
        lastInspectionDate: latestInspectionDate(inbound.inspections),
        appearanceDefects,
        functionDefects,
        hasInspectionEvidence: inbound.inspections.length > 0,
        hasDefect:
          appearanceDefects.length > 0 || functionDefects.length > 0,
        pricePolicyMode: pricePolicyMode(inbound.purchasePriceEntryMode),
      };
    })
    .sort((left, right) => left.inboundId - right.inboundId);
}

function prepareSales(input: PurchaseStatisticsAggregateInput) {
  return input.sales
    .filter(
      (sale) => sale.saleStatus === "SOLD" || sale.saleStatus === "RETURNED"
    )
    .map<PreparedSale>((sale) => ({
      ...sale,
      supplierKey: nullableText(sale.supplierName),
      purchaseAgreedDate: parseDate(sale.purchaseAgreedAt),
      soldDate: parseDate(sale.soldAt),
    }))
    .sort((left, right) => left.saleRecordId - right.saleRecordId);
}

function salesByInbound(sales: PreparedSale[]) {
  const result = new Map<number, PreparedSale[]>();

  for (const sale of sales) {
    if (sale.purchaseInboundId === null) {
      continue;
    }
    const rows = result.get(sale.purchaseInboundId) ?? [];
    rows.push(sale);
    result.set(sale.purchaseInboundId, rows);
  }

  return result;
}

function saleConversionRate(
  purchases: PreparedInbound[],
  linkedSales: Map<number, PreparedSale[]>,
  cutoffExclusive: Date,
  days: number
) {
  const observationMs = days * DAY_MS;
  const mature = purchases.filter(
    (purchase) =>
      purchase.purchaseDate !== null &&
      cutoffExclusive.getTime() - purchase.purchaseDate.getTime() >=
        observationMs
  );
  let convertedCount = 0;

  for (const purchase of mature) {
    const purchaseTime = purchase.purchaseDate?.getTime();

    if (purchaseTime === undefined) {
      continue;
    }

    const firstNonNegativeSale =
      (linkedSales.get(purchase.inboundId) ?? [])
        .map((sale) => sale.soldDate)
        .filter((date): date is Date => date !== null)
        .filter((date) => date.getTime() >= purchaseTime)
        .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;

    if (
      firstNonNegativeSale &&
      firstNonNegativeSale.getTime() - purchaseTime <= observationMs
    ) {
      convertedCount += 1;
    }
  }

  return rateMetric(
    convertedCount,
    mature.length,
    `${days}일 관찰이 끝난 매입 회차가 없습니다.`
  );
}

function inspectionDefectRate(rows: PreparedInbound[]) {
  const inspected = rows.filter((row) => row.hasInspectionEvidence);
  return rateMetric(
    inspected.filter((row) => row.hasDefect).length,
    inspected.length,
    "연결된 입고 검수 표본이 없습니다."
  );
}

function supplierReturnRate(rows: PreparedInbound[]) {
  return rateMetric(
    rows.filter(
      (row) => row.inboundStatus === INBOUND_STATUS.supplierReturn
    ).length,
    rows.length,
    "종결된 입고 회차가 없습니다."
  );
}

function productPerformanceRows(
  inbounds: PreparedInbound[],
  linkedSales: Map<number, PreparedSale[]>,
  cutoffExclusive: Date
): PurchaseProductPerformanceRow[] {
  const groups = groupBy(inbounds, (inbound) =>
    [inbound.modelKey, inbound.storageKey, inbound.purchaseGradeKey].join(
      "\u001f"
    )
  );

  return Array.from(groups, ([key, rows]) => {
    const purchases = rows.filter(
      (row) => row.inboundStatus === INBOUND_STATUS.purchased
    );
    const purchaseAmount = amountMetric(
      purchases,
      (row) => row.purchasePrice
    );
    const first = rows[0];

    return {
      key,
      model: first?.modelKey ?? UNKNOWN_MODEL,
      storage: first?.storageKey ?? UNKNOWN_STORAGE,
      purchaseGrade: first?.purchaseGradeKey ?? UNKNOWN_GRADE,
      terminalOutcomeCount: rows.length,
      purchaseCount: purchases.length,
      purchaseAmount,
      averagePurchasePrice: averageAmount(purchaseAmount),
      supplierReturnRate: supplierReturnRate(rows),
      inspectionDefectRate: inspectionDefectRate(rows),
      saleConversion30Day: saleConversionRate(
        purchases,
        linkedSales,
        cutoffExclusive,
        30
      ),
      saleConversion60Day: saleConversionRate(
        purchases,
        linkedSales,
        cutoffExclusive,
        60
      ),
      saleConversion90Day: saleConversionRate(
        purchases,
        linkedSales,
        cutoffExclusive,
        90
      ),
    };
  }).sort(
    (left, right) =>
      right.purchaseCount - left.purchaseCount ||
      right.terminalOutcomeCount - left.terminalOutcomeCount ||
      left.key.localeCompare(right.key, "ko-KR")
  );
}

function supplierPerformanceRows(
  inbounds: PreparedInbound[],
  sales: PreparedSale[]
): PurchaseSupplierPerformanceRow[] {
  const inboundGroups = groupBy(inbounds, (inbound) => inbound.supplierKey);
  const salesWithSupplier = sales.filter(
    (sale): sale is PreparedSale & { supplierKey: string } =>
      sale.supplierKey !== null
  );
  const saleGroups = groupBy(salesWithSupplier, (sale) => sale.supplierKey);
  const supplierNames = new Set([
    ...inboundGroups.keys(),
    ...saleGroups.keys(),
  ]);

  return Array.from(supplierNames, (supplierName) => {
    const rows = inboundGroups.get(supplierName) ?? [];
    const purchases = rows.filter(
      (row) => row.inboundStatus === INBOUND_STATUS.purchased
    );
    const supplierSales = saleGroups.get(supplierName) ?? [];
    const purchaseAmount = amountMetric(
      purchases,
      (row) => row.purchasePrice
    );

    return {
      supplierName,
      terminalOutcomeCount: rows.length,
      purchaseCount: purchases.length,
      purchaseAmount,
      averagePurchasePrice: averageAmount(purchaseAmount),
      supplierReturnRate: supplierReturnRate(rows),
      inspectionDefectRate: inspectionDefectRate(rows),
      customerReturnConfirmationRate: rateMetric(
        supplierSales.filter((sale) => sale.saleStatus === "RETURNED").length,
        supplierSales.length,
        "판매 당시 원매입처가 기록된 판매 표본이 없습니다."
      ),
    };
  }).sort(
    (left, right) =>
      right.purchaseCount - left.purchaseCount ||
      right.terminalOutcomeCount - left.terminalOutcomeCount ||
      left.supplierName.localeCompare(right.supplierName, "ko-KR")
  );
}

function average(values: number[]) {
  return values.length === 0
    ? null
    : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function pricePolicyRows(
  purchases: PreparedInbound[]
): PurchasePricePolicyRow[] {
  return PRICE_POLICY_MODES.map((entryMode) => {
    const rows = purchases.filter(
      (purchase) => purchase.pricePolicyMode === entryMode
    );
    const purchaseAmount = amountMetric(rows, (row) => row.purchasePrice);
    const referencedRows = rows.filter(
      (row) =>
        validMoney(row.purchasePrice) &&
        validMoney(row.purchasePriceReferenceAmount)
    );
    const adjustments = referencedRows.map(
      (row) =>
        (row.purchasePrice ?? 0) - (row.purchasePriceReferenceAmount ?? 0)
    );
    const adjustmentPercents = referencedRows.flatMap((row) =>
      (row.purchasePriceReferenceAmount ?? 0) > 0
        ? [
            (((row.purchasePrice ?? 0) -
              (row.purchasePriceReferenceAmount ?? 0)) /
              (row.purchasePriceReferenceAmount ?? 1)) *
              100,
          ]
        : []
    );

    return {
      entryMode,
      purchaseCount: rows.length,
      purchaseAmount,
      averagePurchasePrice: averageAmount(purchaseAmount),
      referenceAvailableCount: referencedRows.length,
      referenceCoveragePercent: percentage(referencedRows.length, rows.length),
      averageAdjustmentAmount: average(adjustments),
      averageAdjustmentPercent: average(adjustmentPercents),
      increasedCount: adjustments.filter((value) => value > 0).length,
      unchangedCount: adjustments.filter((value) => value === 0).length,
      decreasedCount: adjustments.filter((value) => value < 0).length,
    };
  });
}

function monthlyTrend(inbounds: PreparedInbound[]) {
  const months = new Map<string, MonthlyAccumulator>();

  for (const inbound of inbounds) {
    if (!inbound.terminalDate) {
      continue;
    }

    const month = monthKey(inbound.terminalDate);
    const row = months.get(month) ?? {
      purchaseCount: 0,
      purchaseAmount: 0,
      pricedPurchaseCount: 0,
      missingPurchasePriceCount: 0,
      supplierReturnCount: 0,
      inspectionDefectOutcomeCount: 0,
    };

    if (inbound.inboundStatus === INBOUND_STATUS.purchased) {
      row.purchaseCount += 1;
      if (validMoney(inbound.purchasePrice)) {
        row.purchaseAmount += inbound.purchasePrice;
        row.pricedPurchaseCount += 1;
      } else {
        row.missingPurchasePriceCount += 1;
      }
    } else {
      row.supplierReturnCount += 1;
    }

    if (inbound.hasDefect) {
      row.inspectionDefectOutcomeCount += 1;
    }

    months.set(month, row);
  }

  return Array.from(months, ([month, row]) => ({
    month,
    purchaseCount: row.purchaseCount,
    purchaseAmount:
      row.pricedPurchaseCount === 0 ? null : row.purchaseAmount,
    pricedPurchaseCount: row.pricedPurchaseCount,
    missingPurchasePriceCount: row.missingPurchasePriceCount,
    supplierReturnCount: row.supplierReturnCount,
    inspectionDefectOutcomeCount: row.inspectionDefectOutcomeCount,
  })).sort((left, right) => left.month.localeCompare(right.month));
}

function countInvalidTimestamps(
  inbounds: PreparedInbound[],
  sales: PreparedSale[]
) {
  let count = 0;

  const countValue = (value: string | null | undefined) => {
    if (nullableText(value) && parseDate(value) === null) {
      count += 1;
    }
  };

  for (const inbound of inbounds) {
    countValue(inbound.receivedAt);
    countValue(inbound.priceAgreedAt);
    countValue(inbound.supplierReturnedAt);
    for (const inspection of inbound.inspections) {
      for (const value of inspectionDateCandidates(inspection)) {
        countValue(value);
      }
    }
  }

  for (const sale of sales) {
    countValue(sale.soldAt);
  }

  return count;
}

function leadTimes(inbounds: PreparedInbound[]) {
  const receivedToInspection: number[] = [];
  const inspectionToOutcome: number[] = [];
  const receivedToOutcome: number[] = [];
  let receivedToInspectionAnomalies = 0;
  let inspectionToOutcomeAnomalies = 0;
  let receivedToOutcomeAnomalies = 0;

  const pushDuration = (
    start: Date | null,
    end: Date | null,
    values: number[],
    anomaly: () => void
  ) => {
    if (!start || !end) {
      return;
    }
    const hours = (end.getTime() - start.getTime()) / HOUR_MS;
    if (hours < 0) {
      anomaly();
    } else {
      values.push(hours);
    }
  };

  for (const inbound of inbounds) {
    pushDuration(
      inbound.receivedDate,
      inbound.lastInspectionDate,
      receivedToInspection,
      () => {
        receivedToInspectionAnomalies += 1;
      }
    );
    pushDuration(
      inbound.lastInspectionDate,
      inbound.terminalDate,
      inspectionToOutcome,
      () => {
        inspectionToOutcomeAnomalies += 1;
      }
    );
    pushDuration(
      inbound.receivedDate,
      inbound.terminalDate,
      receivedToOutcome,
      () => {
        receivedToOutcomeAnomalies += 1;
      }
    );
  }

  return {
    summary: {
      receivedToLastInspection: durationMetric(
        receivedToInspection,
        receivedToInspectionAnomalies
      ),
      lastInspectionToTerminalOutcome: durationMetric(
        inspectionToOutcome,
        inspectionToOutcomeAnomalies
      ),
      receivedToTerminalOutcome: durationMetric(
        receivedToOutcome,
        receivedToOutcomeAnomalies
      ),
    },
    negativeDurationCount:
      receivedToInspectionAnomalies +
      inspectionToOutcomeAnomalies +
      receivedToOutcomeAnomalies,
  };
}

function saleBeforePurchaseCount(
  inbounds: PreparedInbound[],
  sales: PreparedSale[]
) {
  const purchaseDateByInboundId = new Map(
    inbounds
      .filter(
        (inbound): inbound is PreparedInbound & { purchaseDate: Date } =>
          inbound.purchaseDate !== null
      )
      .map((inbound) => [inbound.inboundId, inbound.purchaseDate])
  );

  return sales.filter((sale) => {
    if (sale.purchaseInboundId === null || sale.soldDate === null) {
      return false;
    }
    const purchaseDate = purchaseDateByInboundId.get(sale.purchaseInboundId);
    return (
      purchaseDate !== undefined &&
      sale.soldDate.getTime() < purchaseDate.getTime()
    );
  }).length;
}

export function aggregatePurchaseStatistics(
  input: PurchaseStatisticsAggregateInput,
  options: {
    now?: Date;
    period?: StatisticsPeriodContext;
  } = {}
): PurchaseStatisticsData {
  const now = options.now ?? quickHackClock.nowDate();
  const period =
    options.period ?? resolveClosedStatisticsPeriod({ now });
  const periodBounds = statisticsDateTimeBounds(period.range);
  const cutoffExclusive = statisticsDateTimeBounds({
    fromDate: period.dataCutoffDate,
    toDate: period.dataCutoffDate,
  }).toExclusive;
  const allInbounds = prepareInbounds(input);
  const allSales = prepareSales(input);
  const datedBeforeCutoffInbounds = allInbounds.filter(
    (inbound): inbound is PreparedInbound & { terminalDate: Date } =>
      inbound.terminalDate !== null &&
      inbound.terminalDate.getTime() < cutoffExclusive.getTime()
  );
  const periodInbounds = datedBeforeCutoffInbounds.filter(
    (inbound) =>
      inbound.terminalDate.getTime() >=
        periodBounds.fromInclusive.getTime() &&
      inbound.terminalDate.getTime() < periodBounds.toExclusive.getTime()
  );
  const periodInboundIds = new Set(
    periodInbounds.map((inbound) => inbound.inboundId)
  );
  const potentialRelevantSales = allSales.filter((sale) => {
    if (sale.purchaseInboundId !== null) {
      return periodInboundIds.has(sale.purchaseInboundId);
    }

    return (
      sale.purchaseAgreedDate !== null &&
      sale.purchaseAgreedDate.getTime() >=
        periodBounds.fromInclusive.getTime() &&
      sale.purchaseAgreedDate.getTime() <
        periodBounds.toExclusive.getTime()
    );
  });
  const relevantSales = potentialRelevantSales.filter(
    (sale): sale is PreparedSale & { soldDate: Date } =>
      sale.soldDate !== null &&
      sale.soldDate.getTime() < cutoffExclusive.getTime()
  );
  const inbounds = periodInbounds;
  const sales = relevantSales;
  const purchases = inbounds.filter(
    (inbound) => inbound.inboundStatus === INBOUND_STATUS.purchased
  );
  const supplierReturns = inbounds.filter(
    (inbound) => inbound.inboundStatus === INBOUND_STATUS.supplierReturn
  );
  const purchaseAmount = amountMetric(
    purchases,
    (purchase) => purchase.purchasePrice
  );
  const inspected = inbounds.filter(
    (inbound) => inbound.hasInspectionEvidence
  );
  const defects = inspected.filter((inbound) => inbound.hasDefect);
  const knownInboundIds = new Set(
    allInbounds.map((inbound) => inbound.inboundId)
  );
  const linkedSaleCount = sales.filter(
    (sale) =>
      sale.purchaseInboundId !== null &&
      knownInboundIds.has(sale.purchaseInboundId)
  ).length;
  const salesWithSupplier = sales.filter(
    (sale) => sale.supplierKey !== null
  );
  const policyEvidenceCount = purchases.filter(
    (purchase) => purchase.pricePolicyMode !== "UNKNOWN"
  ).length;
  const referenceEvidenceCount = purchases.filter(
    (purchase) =>
      validMoney(purchase.purchasePriceReferenceAmount) &&
      (purchase.pricePolicyMode === "RATE" ||
        purchase.pricePolicyMode === "OVERRIDE")
  ).length;
  const linkedSales = salesByInbound(sales);
  const durationResult = leadTimes(inbounds);
  const negativeSaleDurations = saleBeforePurchaseCount(inbounds, sales);

  return {
    generatedAt: now.toISOString(),
    calculation: liveStatisticsCalculationMetadata(period),
    source: {
      loadedTerminalInboundCount: allInbounds.length,
      periodEligibleInboundCount: periodInbounds.length,
      outsidePeriodInboundCount:
        datedBeforeCutoffInbounds.length - periodInbounds.length,
      terminalInboundCount: inbounds.length,
      purchaseCount: purchases.length,
      supplierReturnCount: supplierReturns.length,
      pricedPurchaseCount: purchaseAmount.pricedCount,
      missingPurchasePriceCount:
        purchases.length - purchaseAmount.pricedCount,
      namedSupplierOutcomeCount: inbounds.filter(
        (inbound) => nullableText(inbound.supplierName) !== null
      ).length,
      missingSupplierOutcomeCount: inbounds.filter(
        (inbound) => nullableText(inbound.supplierName) === null
      ).length,
      datedPurchaseCount: purchases.filter(
        (purchase) => purchase.purchaseDate !== null
      ).length,
      datedSupplierReturnCount: supplierReturns.filter(
        (supplierReturn) => supplierReturn.supplierReturnDate !== null
      ).length,
      linkedInspectionOutcomeCount: inspected.length,
      missingInspectionOutcomeCount: inbounds.length - inspected.length,
      inspectionLinkCoveragePercent: percentage(
        inspected.length,
        inbounds.length
      ),
      knownPurchaseGradeOutcomeCount: inbounds.filter(
        (inbound) => inbound.purchaseGrade !== null
      ).length,
      missingPurchaseGradeOutcomeCount: inbounds.filter(
        (inbound) => inbound.purchaseGrade === null
      ).length,
      pricePolicyEvidenceCount: policyEvidenceCount,
      priceReferenceEvidenceCount: referenceEvidenceCount,
      pricePolicyCoveragePercent: percentage(
        policyEvidenceCount,
        purchases.length
      ),
      salesRecordCount: sales.length,
      purchaseInboundLinkedSaleCount: linkedSaleCount,
      missingPurchaseInboundSaleCount: sales.length - linkedSaleCount,
      salesLinkCoveragePercent: percentage(linkedSaleCount, sales.length),
      supplierSnapshotSaleCount: salesWithSupplier.length,
      missingSupplierSnapshotSaleCount:
        sales.length - salesWithSupplier.length,
      supplierSnapshotCoveragePercent: percentage(
        salesWithSupplier.length,
        sales.length
      ),
      returnedSaleCount: sales.filter(
        (sale) => sale.saleStatus === "RETURNED"
      ).length,
      invalidTimestampCount: countInvalidTimestamps(
        inbounds,
        potentialRelevantSales
      ),
      negativeDurationCount:
        durationResult.negativeDurationCount + negativeSaleDurations,
    },
    summary: {
      purchaseCount: purchases.length,
      purchaseAmount,
      averagePurchasePrice: averageAmount(purchaseAmount),
      supplierCount: new Set(
        inbounds.flatMap((inbound) =>
          nullableText(inbound.supplierName)
            ? [nullableText(inbound.supplierName) as string]
            : []
        )
      ).size,
      missingPurchasePriceCount:
        purchases.length - purchaseAmount.pricedCount,
      supplierReturnRate: supplierReturnRate(inbounds),
    },
    monthlyTrend: monthlyTrend(inbounds),
    productRows: productPerformanceRows(
      inbounds,
      linkedSales,
      cutoffExclusive
    ),
    supplierRows: supplierPerformanceRows(inbounds, sales),
    pricePolicyRows: pricePolicyRows(purchases),
    inspectionQuality: {
      inspectedOutcomeCount: inspected.length,
      defectOutcomeCount: defects.length,
      defectRate: inspectionDefectRate(inbounds),
      appearanceDefects: countGroups(
        inbounds.flatMap((inbound) => inbound.appearanceDefects)
      ),
      functionDefects: countGroups(
        inbounds.flatMap((inbound) => inbound.functionDefects)
      ),
    },
    leadTimes: durationResult.summary,
  };
}

export async function loadPurchaseStatisticsInput(
  prisma: PrismaClient
): Promise<PurchaseStatisticsAggregateInput> {
  const salesPromise = loadStatisticsCursorPages({
    loadPage: (cursor, take) =>
      prisma.sales_records.findMany({
        where: {
          sale_status: { in: ["SOLD", "RETURNED"] },
        },
        select: {
          sale_record_id: true,
          allocation_id: true,
          pg_no: true,
          purchase_inbound_id: true,
          supplier_name: true,
          purchase_agreed_at: true,
          purchase_price: true,
          sold_at: true,
          sale_status: true,
          model: true,
          storage: true,
          color: true,
          sale_grade: true,
        },
        orderBy: { sale_record_id: "asc" },
        take,
        ...(cursor === undefined
          ? {}
          : {
              cursor: { sale_record_id: cursor },
              skip: 1,
            }),
      }),
    getCursor: (row) => row.sale_record_id,
  });
  const inboundsPromise = loadStatisticsCursorPages({
    loadPage: (cursor, take) =>
      prisma.inbounds.findMany({
        where: {
          inbound_status: {
            in: [INBOUND_STATUS.purchased, INBOUND_STATUS.supplierReturn],
          },
        },
        select: purchaseStatisticsInboundSelect,
        orderBy: { inbound_id: "asc" },
        take,
        ...(cursor === undefined
          ? {}
          : {
              cursor: { inbound_id: cursor },
              skip: 1,
            }),
      }),
    getCursor: (row) => row.inbound_id,
  });

  const [inbounds, sales] = await Promise.all([
    inboundsPromise,
    salesPromise,
  ]);

  return {
    inbounds: inbounds.map((inbound) => ({
      inboundId: inbound.inbound_id,
      pgNo: inbound.pg_no,
      inboundStatus: inbound.inbound_status,
      supplierName: inbound.supplier_name,
      purchasePrice: inbound.purchase_price,
      purchasePriceReferenceAmount:
        inbound.purchase_price_reference_amount,
      purchasePriceEntryMode: inbound.purchase_price_entry_mode,
      receivedAt: apiDateTime(inbound.received_at),
      priceAgreedAt: apiDateTime(inbound.price_agreed_at),
      supplierReturnedAt: apiDateTime(inbound.supplier_returned_at),
      batchDate: apiDate(inbound.inbound_batch?.batch_date),
      batchNo: inbound.inbound_batch?.batch_no ?? null,
      imei: inbound.devices.imei,
      model: inbound.devices.model,
      storage: inbound.devices.storage,
      color: inbound.devices.color,
      inspections: inbound.inspections.map((inspection) => ({
        inspectionId: inspection.inspection_id,
        inspectionType: inspection.inspection_type,
        checkedAt: apiDateTime(inspection.checked_at),
        appearanceCheckedAt: apiDateTime(inspection.appearance_checked_at),
        functionCheckedAt: apiDateTime(inspection.function_checked_at),
        appearanceGrade: inspection.appearance_grade,
        appearanceDefect: inspection.appearance_defect,
        functionDefect: inspection.function_defect,
        returnYn: inspection.return_yn,
      })),
    })),
    sales: sales.map((sale) => ({
      saleRecordId: sale.sale_record_id,
      allocationId: sale.allocation_id,
      pgNo: sale.pg_no,
      purchaseInboundId: sale.purchase_inbound_id,
      supplierName: sale.supplier_name,
      purchaseAgreedAt: apiDateTime(sale.purchase_agreed_at),
      purchasePrice: sale.purchase_price,
      soldAt: requiredApiDateTime(sale.sold_at),
      saleStatus: sale.sale_status,
      model: sale.model,
      storage: sale.storage,
      color: sale.color,
      saleGrade: sale.sale_grade,
    })),
  };
}

export async function getPurchaseStatisticsData(
  prisma: PrismaClient,
  options: { now?: Date; period?: StatisticsPeriodContext } = {}
) {
  const input = await loadPurchaseStatisticsInput(prisma);
  return aggregatePurchaseStatistics(input, {
    now: options.now,
    period: options.period,
  });
}
