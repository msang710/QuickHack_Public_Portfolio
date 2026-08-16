// QuickHack service: aggregate-only current inventory statistics and ledger coverage.
import type { PrismaClient } from "@/generated/prisma/client";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import {
  parseKstSqlDateTime,
  quickHackClock,
} from "@/quickhack_shared/core/time";
import {
  INVENTORY_STATUS,
  INVENTORY_STATUS_LABELS,
  type InventoryStatusCode,
} from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_QUANTITY_MOVEMENT_TYPE } from "@/quickhack_shared/inventory/inventory-quantity-movement";
import type { InventoryLedgerAvailability } from "@/quickhack_shared/inventory/inventory-quantity";
import type {
  InventoryStatisticsAgeBucket,
  InventoryStatisticsAgeBucketKey,
  InventoryStatisticsAgingIssue,
  InventoryStatisticsAgingIssueCode,
  InventoryStatisticsCurrentGroup,
  InventoryStatisticsData,
  InventoryStatisticsIntegrityIssue,
  InventoryStatisticsIntegrityIssueCode,
  InventoryStatisticsPeriodData,
  InventoryStatisticsPeriodDailyPoint,
  InventoryStatisticsPeriodIssue,
  InventoryStatisticsPeriodIssueCode,
  InventoryStatisticsPeriodPreset,
  InventoryStatisticsPeriodSkuRow,
  InventoryStatisticsPeriodTransitionRow,
  InventoryStatisticsPurchaseCostMetric,
  InventoryStatisticsSkuBurdenRow,
  InventoryStatisticsStatusGroupKey,
  InventoryStatisticsTurnoverMetric,
  StatisticsCalculationMetadata,
} from "@/quickhack_shared/statistics/statistics";
import {
  addKstCalendarDays,
  previousEqualStatisticsDateRange,
  resolveClosedStatisticsPeriod,
  statisticsDateRangeDayCount,
  statisticsDateTimeBounds,
  type StatisticsPeriodContext,
} from "@/quickhack_shared/statistics/statistics-period";
import {
  foldInventoryMovementOperations,
  INVENTORY_STATISTICS_WAREHOUSE_STATUSES,
  resolveCurrentHoldingCycle,
  type InventoryStatisticsMovementOperation,
  type InventoryStatisticsMovementInput,
} from "@/quickhack_server/statistics/inventory-statistics-ledger-history";
import { loadStatisticsCursorPages } from "@/quickhack_server/statistics/statistics-loader";

export {
  INVENTORY_STATISTICS_WAREHOUSE_STATUSES,
  resolveCurrentHoldingCycle,
} from "@/quickhack_server/statistics/inventory-statistics-ledger-history";
export type {
  InventoryStatisticsHoldingCycleResolution,
  InventoryStatisticsMovementInput,
} from "@/quickhack_server/statistics/inventory-statistics-ledger-history";

export type InventoryStatisticsSkuInput = {
  skuCode: string;
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
};

export type InventoryStatisticsInventoryInput = {
  inventoryId: number;
  pgNo?: string;
  inventorySkuId: number | null;
  inventoryStatus: string;
  sku?: InventoryStatisticsSkuInput | null;
  purchasePrice?: number | null;
  purchasePriceUpdatedAt?: string | null;
};

export type InventoryStatisticsBalanceInput = {
  balanceId: number;
  inventorySkuId: number;
  inventoryStatus: string;
  quantity: number;
  sku?: InventoryStatisticsSkuInput | null;
};

export type InventoryStatisticsAggregateInput = {
  inventory: InventoryStatisticsInventoryInput[];
  balances: InventoryStatisticsBalanceInput[];
  movementCount: number;
  movements?: InventoryStatisticsMovementInput[];
  sales?: InventoryStatisticsSaleInput[];
};

export type InventoryStatisticsSaleInput = {
  saleRecordId: number;
  pgNo: string;
  inventorySkuId: number | null;
  soldAt: string;
  saleStatus: string;
  sku?: InventoryStatisticsSkuInput | null;
};

type InventoryStatisticsStatusGroupDefinition = {
  key: InventoryStatisticsStatusGroupKey;
  label: string;
  statuses: readonly InventoryStatusCode[];
};

export const INVENTORY_STATISTICS_STATUS_GROUPS = [
  {
    key: "SELLABLE",
    label: "판매 가능",
    statuses: [INVENTORY_STATUS.sellable],
  },
  {
    key: "ORDER_ALLOCATED",
    label: "주문 배정",
    statuses: [
      INVENTORY_STATUS.reserved,
      INVENTORY_STATUS.packing,
      INVENTORY_STATUS.packed,
      INVENTORY_STATUS.departure,
    ],
  },
  {
    key: "SALES_RESTRICTED",
    label: "판매 제한·점검",
    statuses: [
      INVENTORY_STATUS.hold,
      INVENTORY_STATUS.defective,
      INVENTORY_STATUS.returnCheck,
    ],
  },
  {
    key: "DELIVERING",
    label: "배송 중",
    statuses: [INVENTORY_STATUS.delivering],
  },
  {
    key: "TRACKING_EXCEPTION",
    label: "배송 추적 예외",
    statuses: [INVENTORY_STATUS.noneTracking],
  },
  {
    key: "FINAL_DELIVERY",
    label: "판매 종결",
    statuses: [INVENTORY_STATUS.finalDelivery],
  },
  {
    key: "CLAIM_LOCATION_UNKNOWN",
    label: "고객 클레임 진행·물류 위치 미확정",
    statuses: [
      INVENTORY_STATUS.returnRequested,
      INVENTORY_STATUS.exchangeRequested,
    ],
  },
] as const satisfies readonly InventoryStatisticsStatusGroupDefinition[];

const STATUS_GROUP_BY_STATUS = {
  SELLABLE: "SELLABLE",
  RESERVED: "ORDER_ALLOCATED",
  PACKING: "ORDER_ALLOCATED",
  PACKED: "ORDER_ALLOCATED",
  DEPARTURE: "ORDER_ALLOCATED",
  DELIVERING: "DELIVERING",
  FINAL_DELIVERY: "FINAL_DELIVERY",
  NONE_TRACKING: "TRACKING_EXCEPTION",
  HOLD: "SALES_RESTRICTED",
  DEFECTIVE: "SALES_RESTRICTED",
  RETURN_REQUESTED: "CLAIM_LOCATION_UNKNOWN",
  EXCHANGE_REQUESTED: "CLAIM_LOCATION_UNKNOWN",
  RETURN_CHECK: "SALES_RESTRICTED",
} as const satisfies Record<
  InventoryStatusCode,
  InventoryStatisticsStatusGroupKey
>;

const KNOWN_INVENTORY_STATUSES = new Set<string>(
  Object.keys(STATUS_GROUP_BY_STATUS)
);

export const INVENTORY_STATISTICS_LONG_TERM_STATUSES = new Set<string>([
  INVENTORY_STATUS.sellable,
  INVENTORY_STATUS.hold,
  INVENTORY_STATUS.defective,
  INVENTORY_STATUS.returnCheck,
]);

const INVENTORY_STATISTICS_AGE_BUCKETS = [
  {
    key: "DAYS_0_29",
    label: "0~29일",
    fromDays: 0,
    toDays: 29,
  },
  {
    key: "DAYS_30_59",
    label: "30~59일",
    fromDays: 30,
    toDays: 59,
  },
  {
    key: "DAYS_60_89",
    label: "60~89일",
    fromDays: 60,
    toDays: 89,
  },
  {
    key: "DAYS_90_PLUS",
    label: "90일 이상",
    fromDays: 90,
    toDays: null,
  },
] as const satisfies readonly {
  key: InventoryStatisticsAgeBucketKey;
  label: string;
  fromDays: number;
  toDays: number | null;
}[];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const INVENTORY_STATISTICS_PERIOD_PRESETS =
  new Set<InventoryStatisticsPeriodPreset>(["30d", "90d", "1y", "all"]);

export class InventoryStatisticsPeriodError extends Error {
  readonly code = "INVALID_INVENTORY_STATISTICS_PERIOD";

  constructor() {
    super("재고 통계 기간은 30d, 90d, 1y, all 중 하나여야 합니다.");
    this.name = "InventoryStatisticsPeriodError";
  }
}

export function normalizeInventoryStatisticsPeriod(
  value: unknown
): InventoryStatisticsPeriodPreset {
  const normalized = String(value ?? "").trim().toLocaleLowerCase();

  if (!normalized) {
    return "90d";
  }

  if (
    INVENTORY_STATISTICS_PERIOD_PRESETS.has(
      normalized as InventoryStatisticsPeriodPreset
    )
  ) {
    return normalized as InventoryStatisticsPeriodPreset;
  }

  throw new InventoryStatisticsPeriodError();
}

function inventoryBucketKey(inventorySkuId: number, inventoryStatus: string) {
  return `${inventorySkuId}\u0000${inventoryStatus}`;
}

function increment(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function addIssue(
  issues: InventoryStatisticsIntegrityIssue[],
  code: InventoryStatisticsIntegrityIssueCode,
  count: number
) {
  if (count > 0) {
    issues.push({ code, count });
  }
}

function addAgingIssue(
  issues: InventoryStatisticsAgingIssue[],
  code: InventoryStatisticsAgingIssueCode,
  count: number
) {
  if (count > 0) {
    issues.push({ code, count });
  }
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function round(value: number, digits = 1) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function displayDimension(value: string | null | undefined) {
  return text(value) || "미정";
}

function kstCalendarDayNumber(date: Date) {
  const parts = quickHackClock.kstDateTimeParts(date);
  return (
    Date.UTC(
      Number.parseInt(parts.year, 10),
      Number.parseInt(parts.month, 10) - 1,
      Number.parseInt(parts.day, 10)
    ) / MS_PER_DAY
  );
}

function purchaseCostMetric(
  rows: readonly InventoryStatisticsInventoryInput[],
  exposesQuantity: boolean
): InventoryStatisticsPurchaseCostMetric {
  if (!exposesQuantity) {
    return {
      amount: null,
      pricedQuantity: null,
      totalQuantity: null,
      missingPriceQuantity: null,
      coveragePercent: null,
    };
  }

  const prices = rows
    .map((row) => row.purchasePrice)
    .filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value >= 0
    );

  return {
    amount:
      prices.length === 0
        ? null
        : prices.reduce((sum, value) => sum + value, 0),
    pricedQuantity: prices.length,
    totalQuantity: rows.length,
    missingPriceQuantity: rows.length - prices.length,
    coveragePercent:
      rows.length === 0 ? 0 : round((prices.length / rows.length) * 100),
  };
}

function ageBucketDefinition(ageDays: number) {
  return INVENTORY_STATISTICS_AGE_BUCKETS.find(
    (bucket) =>
      ageDays >= bucket.fromDays &&
      (bucket.toDays === null || ageDays <= bucket.toDays)
  );
}

function statusQuantities(
  balances: readonly InventoryStatisticsBalanceInput[]
) {
  const quantities = new Map<InventoryStatusCode, number>();

  for (const status of Object.keys(
    STATUS_GROUP_BY_STATUS
  ) as InventoryStatusCode[]) {
    quantities.set(status, 0);
  }

  for (const balance of balances) {
    if (!KNOWN_INVENTORY_STATUSES.has(balance.inventoryStatus)) {
      continue;
    }

    const status = balance.inventoryStatus as InventoryStatusCode;
    quantities.set(status, (quantities.get(status) ?? 0) + balance.quantity);
  }

  return quantities;
}

function currentGroups(
  balances: readonly InventoryStatisticsBalanceInput[],
  exposesQuantity: boolean
): InventoryStatisticsCurrentGroup[] {
  const quantities = statusQuantities(balances);

  return INVENTORY_STATISTICS_STATUS_GROUPS.map((group) => {
    const statuses = group.statuses.map((status) => ({
      status,
      label: INVENTORY_STATUS_LABELS[status],
      quantity: exposesQuantity ? quantities.get(status) ?? 0 : null,
    }));

    return {
      key: group.key,
      label: group.label,
      quantity: exposesQuantity
        ? statuses.reduce(
            (sum, status) => sum + (status.quantity ?? 0),
            0
          )
        : null,
      statuses,
    };
  });
}

type InventoryStatisticsResolvedAgeRow = {
  inventory: InventoryStatisticsInventoryInput;
  ageDays: number;
  bucketKey: InventoryStatisticsAgeBucketKey;
};

function emptyAgeBuckets(
  exposesQuantity: boolean
): InventoryStatisticsAgeBucket[] {
  return INVENTORY_STATISTICS_AGE_BUCKETS.map((bucket) => ({
    ...bucket,
    quantity: exposesQuantity ? 0 : null,
    purchaseCost: purchaseCostMetric([], exposesQuantity),
  }));
}

function agingStatistics(
  input: InventoryStatisticsAggregateInput,
  currentAvailability: InventoryLedgerAvailability,
  now: Date
): InventoryStatisticsData["aging"] {
  const warehouseRows = input.inventory.filter((row) =>
    INVENTORY_STATISTICS_WAREHOUSE_STATUSES.has(row.inventoryStatus)
  );

  if (currentAvailability === "PARTIAL") {
    return {
      integrity: {
        availability: currentAvailability,
        issues: [],
      },
      warehouseQuantity: null,
      resolvedCycleQuantity: 0,
      missingCycleQuantity: 0,
      longTermQuantity: null,
      longTermPurchaseCost: purchaseCostMetric([], false),
      buckets: emptyAgeBuckets(false),
      skuRows: [],
    };
  }

  if (warehouseRows.length === 0) {
    return {
      integrity: {
        availability: "EMPTY",
        issues: [],
      },
      warehouseQuantity: 0,
      resolvedCycleQuantity: 0,
      missingCycleQuantity: 0,
      longTermQuantity: 0,
      longTermPurchaseCost: purchaseCostMetric([], true),
      buckets: emptyAgeBuckets(true),
      skuRows: [],
    };
  }

  const movementRowsByPg = new Map<
    string,
    InventoryStatisticsMovementInput[]
  >();

  for (const movement of input.movements ?? []) {
    const rows = movementRowsByPg.get(movement.pgNo) ?? [];
    rows.push(movement);
    movementRowsByPg.set(movement.pgNo, rows);
  }

  const issueCounts = new Map<InventoryStatisticsAgingIssueCode, number>();
  const resolvedRows: InventoryStatisticsResolvedAgeRow[] = [];
  const nowDay = kstCalendarDayNumber(now);

  for (const row of warehouseRows) {
    const pgNo = text(row.pgNo);
    const resolution = resolveCurrentHoldingCycle({
      pgNo,
      currentStatus: row.inventoryStatus,
      movements: pgNo ? movementRowsByPg.get(pgNo) ?? [] : [],
    });

    if (resolution.issueCode) {
      issueCounts.set(
        resolution.issueCode,
        (issueCounts.get(resolution.issueCode) ?? 0) + 1
      );
      continue;
    }

    const startedAt = parseKstSqlDateTime(resolution.startedAt);

    if (!startedAt) {
      issueCounts.set(
        "INVALID_MOVEMENT_TIMESTAMP",
        (issueCounts.get("INVALID_MOVEMENT_TIMESTAMP") ?? 0) + 1
      );
      continue;
    }

    if (startedAt.getTime() > now.getTime()) {
      issueCounts.set(
        "FUTURE_HOLDING_CYCLE_START",
        (issueCounts.get("FUTURE_HOLDING_CYCLE_START") ?? 0) + 1
      );
      continue;
    }

    const ageDays = nowDay - kstCalendarDayNumber(startedAt);

    if (ageDays < 0) {
      issueCounts.set(
        "FUTURE_HOLDING_CYCLE_START",
        (issueCounts.get("FUTURE_HOLDING_CYCLE_START") ?? 0) + 1
      );
      continue;
    }

    const bucket = ageBucketDefinition(ageDays);

    if (!bucket) {
      issueCounts.set(
        "INVALID_MOVEMENT_TIMESTAMP",
        (issueCounts.get("INVALID_MOVEMENT_TIMESTAMP") ?? 0) + 1
      );
      continue;
    }

    resolvedRows.push({
      inventory: row,
      ageDays,
      bucketKey: bucket.key,
    });
  }

  const issues: InventoryStatisticsAgingIssue[] = [];

  for (const code of [
    "MISSING_PG_MOVEMENT_HISTORY",
    "INVALID_PG_MOVEMENT_GROUP",
    "INVALID_MOVEMENT_TIMESTAMP",
    "CURRENT_STATUS_HISTORY_MISMATCH",
    "FUTURE_HOLDING_CYCLE_START",
  ] as const) {
    addAgingIssue(issues, code, issueCounts.get(code) ?? 0);
  }

  if (issues.length > 0) {
    return {
      integrity: {
        availability: "PARTIAL",
        issues,
      },
      warehouseQuantity: null,
      resolvedCycleQuantity: resolvedRows.length,
      missingCycleQuantity: warehouseRows.length - resolvedRows.length,
      longTermQuantity: null,
      longTermPurchaseCost: purchaseCostMetric([], false),
      buckets: emptyAgeBuckets(false),
      skuRows: [],
    };
  }

  const burdenRows = resolvedRows.filter((row) =>
    INVENTORY_STATISTICS_LONG_TERM_STATUSES.has(
      row.inventory.inventoryStatus
    )
  );
  const longTermRows = burdenRows.filter((row) => row.ageDays >= 30);
  const buckets = INVENTORY_STATISTICS_AGE_BUCKETS.map((bucket) => {
    const rows = burdenRows.filter((row) => row.bucketKey === bucket.key);
    const inventoryRows = rows.map((row) => row.inventory);

    return {
      ...bucket,
      quantity: rows.length,
      purchaseCost: purchaseCostMetric(inventoryRows, true),
    };
  });
  const rowsBySku = new Map<string, InventoryStatisticsResolvedAgeRow[]>();

  for (const row of burdenRows) {
    const skuCode =
      text(row.inventory.sku?.skuCode) ||
      `SKU-${row.inventory.inventorySkuId ?? "UNCLASSIFIED"}`;
    const rows = rowsBySku.get(skuCode) ?? [];
    rows.push(row);
    rowsBySku.set(skuCode, rows);
  }

  const skuRows: InventoryStatisticsSkuBurdenRow[] = Array.from(
    rowsBySku.entries()
  )
    .map(([skuCode, rows]) => {
      const sample = rows[0]?.inventory;
      const sku = sample?.sku;
      const longTermQuantity = rows.filter(
        (row) => row.ageDays >= 30
      ).length;

      return {
        skuCode,
        model: displayDimension(sku?.model),
        storage: displayDimension(sku?.storage),
        color: displayDimension(sku?.color),
        saleGrade: displayDimension(sku?.saleGrade),
        quantity: rows.length,
        longTermQuantity,
        ageBuckets: INVENTORY_STATISTICS_AGE_BUCKETS.map((bucket) => {
          const bucketRows = rows.filter(
            (row) => row.bucketKey === bucket.key
          );

          return {
            ...bucket,
            quantity: bucketRows.length,
            purchaseCost: purchaseCostMetric(
              bucketRows.map((row) => row.inventory),
              true
            ),
          };
        }),
        purchaseCost: purchaseCostMetric(
          rows.map((row) => row.inventory),
          true
        ),
      };
    })
    .sort(
      (left, right) =>
        (right.longTermQuantity ?? 0) - (left.longTermQuantity ?? 0) ||
        (right.quantity ?? 0) - (left.quantity ?? 0) ||
        left.skuCode.localeCompare(right.skuCode, "ko")
    );

  return {
    integrity: {
      availability: "READY",
      issues: [],
    },
    warehouseQuantity: warehouseRows.length,
    resolvedCycleQuantity: resolvedRows.length,
    missingCycleQuantity: 0,
    longTermQuantity: longTermRows.length,
    longTermPurchaseCost: purchaseCostMetric(
      longTermRows.map((row) => row.inventory),
      true
    ),
    buckets,
    skuRows,
  };
}

type InventoryStatisticsPeriodRange = {
  preset: InventoryStatisticsPeriodPreset | "custom";
  fromDate: string;
  toDate: string;
  fromMs: number;
  toMs: number;
  dates: string[];
  context: StatisticsPeriodContext;
};

function parseStatisticsDate(value: string | null | undefined) {
  const normalized = text(value);

  if (!normalized) {
    return null;
  }

  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  return parseKstSqlDateTime(normalized);
}

function kstDateStartMs(date: string) {
  return parseKstSqlDateTime(`${date} 00:00:00`)?.getTime() ?? Number.NaN;
}

function kstDateAfter(date: string, days: number) {
  const startMs = kstDateStartMs(date);
  return quickHackClock.formatKstDate(
    new Date(startMs + days * MS_PER_DAY)
  );
}

function inclusiveKstDates(fromDate: string, toDate: string) {
  const fromMs = kstDateStartMs(fromDate);
  const toMs = kstDateStartMs(toDate);
  const dates: string[] = [];

  for (let cursor = fromMs; cursor <= toMs; cursor += MS_PER_DAY) {
    dates.push(quickHackClock.formatKstDate(new Date(cursor)));
  }

  return dates;
}

export function resolveInventoryStatisticsPeriod(input: {
  preset: InventoryStatisticsPeriodPreset;
  now: Date;
  sourceDates?: readonly Date[];
}): InventoryStatisticsPeriodRange {
  const defaultContext = resolveClosedStatisticsPeriod({ now: input.now });
  const toDate = defaultContext.dataCutoffDate;
  const cutoffExclusiveMs =
    statisticsDateTimeBounds(defaultContext.range).toExclusive.getTime();
  let fromDate: string;

  if (input.preset === "all") {
    const earliest = (input.sourceDates ?? [])
      .filter(
        (date) =>
          Number.isFinite(date.getTime()) &&
          date.getTime() < cutoffExclusiveMs
      )
      .sort((left, right) => left.getTime() - right.getTime())[0];
    fromDate = earliest
      ? quickHackClock.formatKstDate(earliest)
      : toDate;
  } else {
    const days =
      input.preset === "30d" ? 30 : input.preset === "90d" ? 90 : 365;
    fromDate = addKstCalendarDays(toDate, -(days - 1));
  }

  const range = { fromDate, toDate };
  const context: StatisticsPeriodContext = {
    range,
    previousRange: previousEqualStatisticsDateRange(range),
    dataCutoffDate: defaultContext.dataCutoffDate,
    dayCount: statisticsDateRangeDayCount(range),
    isDefault: input.preset === "90d",
  };
  const bounds = statisticsDateTimeBounds(range);

  return {
    preset: input.preset,
    fromDate,
    toDate,
    fromMs: bounds.fromInclusive.getTime(),
    toMs: bounds.toExclusive.getTime() - 1,
    dates: inclusiveKstDates(fromDate, toDate),
    context,
  };
}

function inventoryStatisticsPeriodRangeFromContext(
  context: StatisticsPeriodContext
): InventoryStatisticsPeriodRange {
  const bounds = statisticsDateTimeBounds(context.range);

  return {
    preset: context.isDefault ? "90d" : "custom",
    fromDate: context.range.fromDate,
    toDate: context.range.toDate,
    fromMs: bounds.fromInclusive.getTime(),
    toMs: bounds.toExclusive.getTime() - 1,
    dates: inclusiveKstDates(
      context.range.fromDate,
      context.range.toDate
    ),
    context,
  };
}

function addPeriodIssue(
  issues: InventoryStatisticsPeriodIssue[],
  code: InventoryStatisticsPeriodIssueCode,
  count: number
) {
  if (count > 0) {
    issues.push({ code, count });
  }
}

function validateBalanceMovementChains(input: {
  balances: readonly InventoryStatisticsBalanceInput[];
  movements: readonly InventoryStatisticsMovementInput[];
}) {
  const balanceById = new Map(
    input.balances.map((balance) => [balance.balanceId, balance])
  );
  const rowsByBalanceId = new Map<number, InventoryStatisticsMovementInput[]>();
  let chainMismatchCount = 0;
  let tailMismatchCount = 0;

  for (const row of input.movements) {
    if (
      !Number.isInteger(row.balanceId) ||
      !Number.isInteger(row.beforeQuantity) ||
      !Number.isInteger(row.afterQuantity)
    ) {
      chainMismatchCount += 1;
      continue;
    }

    const balanceId = row.balanceId as number;
    const rows = rowsByBalanceId.get(balanceId) ?? [];
    rows.push(row);
    rowsByBalanceId.set(balanceId, rows);

    if (!balanceById.has(balanceId)) {
      chainMismatchCount += 1;
    }
  }

  for (const balance of input.balances) {
    const rows = (rowsByBalanceId.get(balance.balanceId) ?? []).sort(
      (left, right) => left.movementId - right.movementId
    );

    if (rows.length === 0) {
      if (balance.quantity !== 0) {
        tailMismatchCount += 1;
      }
      continue;
    }

    let previousAfter: number | null = null;
    let previousOccurredAtMs: number | null = null;

    for (const row of rows) {
      const occurredAtMs = parseKstSqlDateTime(row.occurredAt)?.getTime();

      if (
        row.beforeQuantity === undefined ||
        row.afterQuantity === undefined ||
        row.beforeQuantity + row.quantityDelta !== row.afterQuantity ||
        (previousAfter !== null && row.beforeQuantity !== previousAfter) ||
        (previousOccurredAtMs !== null &&
          occurredAtMs !== undefined &&
          occurredAtMs !== null &&
          occurredAtMs < previousOccurredAtMs)
      ) {
        chainMismatchCount += 1;
      }

      previousAfter = row.afterQuantity ?? null;
      previousOccurredAtMs = occurredAtMs ?? previousOccurredAtMs;
    }

    if (previousAfter !== balance.quantity) {
      tailMismatchCount += 1;
    }
  }

  return { chainMismatchCount, tailMismatchCount };
}

function validatePgMovementHistory(input: {
  inventory: readonly InventoryStatisticsInventoryInput[];
  operations: readonly InventoryStatisticsMovementOperation[];
}) {
  const currentByPg = new Map(
    input.inventory.map((row) => [
      text(row.pgNo),
      {
        status: row.inventoryStatus,
        inventorySkuId: row.inventorySkuId,
      },
    ])
  );
  const stateByPg = new Map<
    string,
    { status: string; inventorySkuId: number }
  >();
  let mismatchCount = 0;

  for (const operation of input.operations) {
    const state = stateByPg.get(operation.pgNo) ?? null;
    const incoming = operation.inMovement;
    const outgoing = operation.outMovement;

    if (
      operation.movementType ===
      INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated
    ) {
      if (state || !incoming) {
        mismatchCount += 1;
        continue;
      }

      stateByPg.set(operation.pgNo, {
        status: incoming.inventoryStatus,
        inventorySkuId: incoming.inventorySkuId,
      });
      continue;
    }

    if (
      operation.movementType ===
      INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryRemoved
    ) {
      if (
        !state ||
        !outgoing ||
        state.status !== outgoing.inventoryStatus ||
        state.inventorySkuId !== outgoing.inventorySkuId
      ) {
        mismatchCount += 1;
        continue;
      }

      stateByPg.delete(operation.pgNo);
      continue;
    }

    if (
      !state ||
      !incoming ||
      !outgoing ||
      state.status !== outgoing.inventoryStatus ||
      state.inventorySkuId !== outgoing.inventorySkuId
    ) {
      mismatchCount += 1;
      continue;
    }

    stateByPg.set(operation.pgNo, {
      status: incoming.inventoryStatus,
      inventorySkuId: incoming.inventorySkuId,
    });
  }

  for (const [pgNo, state] of stateByPg) {
    const current = currentByPg.get(pgNo);

    if (
      !current ||
      current.status !== state.status ||
      current.inventorySkuId !== state.inventorySkuId
    ) {
      mismatchCount += 1;
    }
  }

  for (const [pgNo, current] of currentByPg) {
    if (
      !pgNo ||
      current.inventorySkuId === null ||
      !stateByPg.has(pgNo)
    ) {
      mismatchCount += 1;
    }
  }

  return mismatchCount;
}

function periodTurnover(
  soldQuantity: number,
  averageWarehouseQuantity: number | null,
  reason?: string
): InventoryStatisticsTurnoverMetric {
  if (reason) {
    return {
      value: null,
      soldQuantity,
      averageWarehouseQuantity,
      unavailableReason: reason,
    };
  }

  if (averageWarehouseQuantity === null) {
    return {
      value: null,
      soldQuantity,
      averageWarehouseQuantity,
      unavailableReason: "기간 재고 원장을 복원할 수 없습니다.",
    };
  }

  if (averageWarehouseQuantity === 0) {
    return soldQuantity === 0
      ? {
          value: null,
          soldQuantity,
          averageWarehouseQuantity,
          unavailableReason: "선택 기간에 창고 재고와 판매가 없습니다.",
        }
      : {
          value: null,
          soldQuantity,
          averageWarehouseQuantity,
          unavailableReason:
            "판매 완료는 있지만 창고 보유 재고 분모가 0입니다.",
        };
  }

  return {
    value: round(soldQuantity / averageWarehouseQuantity, 3),
    soldQuantity,
    averageWarehouseQuantity,
  };
}

function statusGroupKey(status: string) {
  return STATUS_GROUP_BY_STATUS[
    status as keyof typeof STATUS_GROUP_BY_STATUS
  ] as InventoryStatisticsStatusGroupKey | undefined;
}

function transitionKey(
  fromGroup: InventoryStatisticsStatusGroupKey | null,
  toGroup: InventoryStatisticsStatusGroupKey | null
) {
  return `${fromGroup ?? ""}\u0000${toGroup ?? ""}`;
}

function periodStatistics(
  input: InventoryStatisticsAggregateInput,
  currentAvailability: InventoryLedgerAvailability,
  range: InventoryStatisticsPeriodRange
): InventoryStatisticsPeriodData {
  const movements = input.movements ?? [];
  const sales = input.sales ?? [];
  const parsedMovementDates = movements.flatMap((row) => {
    const parsed = parseKstSqlDateTime(row.occurredAt);
    return parsed ? [parsed] : [];
  });
  const parsedSales = sales.map((sale) => ({
    sale,
    soldDate: parseStatisticsDate(sale.soldAt),
  }));
  const issues: InventoryStatisticsPeriodIssue[] = [];
  const futureMovementCount = parsedMovementDates.filter(
    (date) => date.getTime() > range.toMs
  ).length;
  const invalidSaleTimestampCount = parsedSales.filter(
    (row) => row.soldDate === null
  ).length;
  const futureSaleTimestampCount = parsedSales.filter(
    (row) => (row.soldDate?.getTime() ?? 0) > range.toMs
  ).length;

  if (currentAvailability === "PARTIAL") {
    addPeriodIssue(issues, "CURRENT_LEDGER_NOT_READY", 1);
  }
  addPeriodIssue(issues, "FUTURE_MOVEMENT", futureMovementCount);
  addPeriodIssue(
    issues,
    "INVALID_SALE_TIMESTAMP",
    invalidSaleTimestampCount
  );
  addPeriodIssue(
    issues,
    "FUTURE_SALE_TIMESTAMP",
    futureSaleTimestampCount
  );

  const folded = foldInventoryMovementOperations(movements);
  const operations = folded.operations ?? [];

  if (folded.issueCode === "INVALID_MOVEMENT_TIMESTAMP") {
    addPeriodIssue(issues, "INVALID_MOVEMENT_TIMESTAMP", 1);
  } else if (folded.issueCode === "INVALID_MOVEMENT_QUANTITY") {
    addPeriodIssue(issues, "INVALID_MOVEMENT_QUANTITY", 1);
  } else if (folded.issueCode) {
    addPeriodIssue(issues, "INVALID_MOVEMENT_GROUP", 1);
  }

  const chain = validateBalanceMovementChains({
    balances: input.balances,
    movements,
  });
  addPeriodIssue(
    issues,
    "BALANCE_MOVEMENT_CHAIN_MISMATCH",
    chain.chainMismatchCount
  );
  addPeriodIssue(
    issues,
    "CURRENT_BALANCE_TAIL_MISMATCH",
    chain.tailMismatchCount
  );

  if (!folded.issueCode) {
    addPeriodIssue(
      issues,
      "PG_STATUS_HISTORY_MISMATCH",
      validatePgMovementHistory({
        inventory: input.inventory,
        operations,
      })
    );
  }

  const periodOperations = operations.filter(
    (operation) =>
      operation.occurredAtMs >= range.fromMs &&
      operation.occurredAtMs <= range.toMs
  );
  const validSales = parsedSales.filter(
    (
      row
    ): row is {
      sale: InventoryStatisticsSaleInput;
      soldDate: Date;
    } =>
      row.soldDate !== null && row.soldDate.getTime() <= range.toMs
  );
  const periodSales = validSales.filter(
    (row) => row.soldDate.getTime() >= range.fromMs
  );
  const salesByPg = new Map<string, number[]>();

  for (const row of validSales) {
    const pgNo = text(row.sale.pgNo);
    const times = salesByPg.get(pgNo) ?? [];
    times.push(row.soldDate.getTime());
    salesByPg.set(pgNo, times);
  }

  const movementIssueCodes = new Set<InventoryStatisticsPeriodIssueCode>([
    "CURRENT_LEDGER_NOT_READY",
    "INVALID_MOVEMENT_GROUP",
    "INVALID_MOVEMENT_TIMESTAMP",
    "INVALID_MOVEMENT_QUANTITY",
    "BALANCE_MOVEMENT_CHAIN_MISMATCH",
    "CURRENT_BALANCE_TAIL_MISMATCH",
    "PG_STATUS_HISTORY_MISMATCH",
    "FUTURE_MOVEMENT",
  ]);
  const ledgerReady = !issues.some((issue) =>
    movementIssueCodes.has(issue.code)
  );
  const salesReady =
    invalidSaleTimestampCount === 0 && futureSaleTimestampCount === 0;
  const dailyByDate = new Map<
    string,
    InventoryStatisticsPeriodDailyPoint
  >(
    range.dates.map((date) => [
      date,
      {
        date,
        closingWarehouseQuantity: ledgerReady ? 0 : null,
        newInventoryQuantity: ledgerReady ? 0 : null,
        warehouseReentryQuantity: ledgerReady ? 0 : null,
        customerReturnReentryQuantity: ledgerReady ? 0 : null,
        otherWarehouseReentryQuantity: ledgerReady ? 0 : null,
        warehouseExitQuantity: ledgerReady ? 0 : null,
        removedQuantity: ledgerReady ? 0 : null,
        salesCompletedQuantity: 0,
      },
    ])
  );

  for (const row of periodSales) {
    const date = quickHackClock.formatKstDate(row.soldDate);
    const point = dailyByDate.get(date);

    if (point) {
      point.salesCompletedQuantity += 1;
    }
  }

  const transitionCounts = new Map<
    string,
    {
      fromGroup: InventoryStatisticsStatusGroupKey | null;
      toGroup: InventoryStatisticsStatusGroupKey | null;
      quantity: number;
    }
  >();

  if (ledgerReady) {
    for (const operation of periodOperations) {
      const point = dailyByDate.get(
        quickHackClock.formatKstDate(new Date(operation.occurredAtMs))
      );

      if (!point) {
        continue;
      }

      const incoming = operation.inMovement;
      const outgoing = operation.outMovement;

      if (
        operation.movementType ===
        INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated
      ) {
        if (
          incoming &&
          INVENTORY_STATISTICS_WAREHOUSE_STATUSES.has(
            incoming.inventoryStatus as InventoryStatusCode
          )
        ) {
          point.newInventoryQuantity =
            (point.newInventoryQuantity ?? 0) + 1;
        }
      } else if (
        operation.movementType ===
          INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer &&
        incoming &&
        outgoing
      ) {
        const fromWarehouse = INVENTORY_STATISTICS_WAREHOUSE_STATUSES.has(
          outgoing.inventoryStatus as InventoryStatusCode
        );
        const toWarehouse = INVENTORY_STATISTICS_WAREHOUSE_STATUSES.has(
          incoming.inventoryStatus as InventoryStatusCode
        );

        if (!fromWarehouse && toWarehouse) {
          point.warehouseReentryQuantity =
            (point.warehouseReentryQuantity ?? 0) + 1;
          const hasPriorSale = (salesByPg.get(operation.pgNo) ?? []).some(
            (soldAtMs) => soldAtMs <= operation.occurredAtMs
          );

          if (hasPriorSale) {
            point.customerReturnReentryQuantity =
              (point.customerReturnReentryQuantity ?? 0) + 1;
          } else {
            point.otherWarehouseReentryQuantity =
              (point.otherWarehouseReentryQuantity ?? 0) + 1;
          }
        } else if (fromWarehouse && !toWarehouse) {
          point.warehouseExitQuantity =
            (point.warehouseExitQuantity ?? 0) + 1;
        }
      } else if (
        operation.movementType ===
          INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryRemoved &&
        outgoing
      ) {
        point.removedQuantity = (point.removedQuantity ?? 0) + 1;
      }

      if (
        operation.movementType ===
        INVENTORY_QUANTITY_MOVEMENT_TYPE.skuReclassification
      ) {
        continue;
      }

      const fromGroup = outgoing
        ? statusGroupKey(outgoing.inventoryStatus) ?? null
        : null;
      const toGroup = incoming
        ? statusGroupKey(incoming.inventoryStatus) ?? null
        : null;
      const key = transitionKey(fromGroup, toGroup);
      const transition = transitionCounts.get(key) ?? {
        fromGroup,
        toGroup,
        quantity: 0,
      };
      transition.quantity += 1;
      transitionCounts.set(key, transition);
    }
  }

  const skuMetadataById = new Map<number, InventoryStatisticsSkuInput>();

  for (const balance of input.balances) {
    if (balance.sku) {
      skuMetadataById.set(balance.inventorySkuId, balance.sku);
    }
  }
  for (const row of input.inventory) {
    if (row.inventorySkuId && row.sku) {
      skuMetadataById.set(row.inventorySkuId, row.sku);
    }
  }
  for (const row of sales) {
    if (row.inventorySkuId && row.sku) {
      skuMetadataById.set(row.inventorySkuId, row.sku);
    }
  }

  const skuClosingSums = new Map<number, number>();
  let closingWarehouseSum = 0;

  if (ledgerReady) {
    const quantityByBucket = new Map(
      input.balances.map((balance) => [
        inventoryBucketKey(
          balance.inventorySkuId,
          balance.inventoryStatus
        ),
        balance.quantity,
      ])
    );
    const parsedMovements = movements
      .flatMap((row) => {
        const occurredAt = parseKstSqlDateTime(row.occurredAt);
        return occurredAt
          ? [{ row, occurredAtMs: occurredAt.getTime() }]
          : [];
      })
      .sort(
        (left, right) =>
          right.occurredAtMs - left.occurredAtMs ||
          right.row.movementId - left.row.movementId
      );
    let movementIndex = 0;

    for (let index = range.dates.length - 1; index >= 0; index -= 1) {
      const date = range.dates[index] as string;
      const thresholdMs =
        date === range.toDate
          ? range.toMs
          : kstDateStartMs(kstDateAfter(date, 1)) - 1;

      while (
        movementIndex < parsedMovements.length &&
        (parsedMovements[movementIndex]?.occurredAtMs ?? 0) > thresholdMs
      ) {
        const movement = parsedMovements[movementIndex]
          ?.row as InventoryStatisticsMovementInput;
        const key = inventoryBucketKey(
          movement.inventorySkuId,
          movement.inventoryStatus
        );
        quantityByBucket.set(
          key,
          (quantityByBucket.get(key) ?? 0) - movement.quantityDelta
        );
        movementIndex += 1;
      }

      let closingWarehouseQuantity = 0;
      const closingBySku = new Map<number, number>();

      for (const [key, quantity] of quantityByBucket) {
        const [skuIdText, status] = key.split("\u0000");

        if (
          !INVENTORY_STATISTICS_WAREHOUSE_STATUSES.has(
            status as InventoryStatusCode
          )
        ) {
          continue;
        }

        const skuId = Number(skuIdText);
        closingWarehouseQuantity += quantity;
        closingBySku.set(
          skuId,
          (closingBySku.get(skuId) ?? 0) + quantity
        );
      }

      const point = dailyByDate.get(date);
      if (point) {
        point.closingWarehouseQuantity = closingWarehouseQuantity;
      }
      closingWarehouseSum += closingWarehouseQuantity;

      for (const [skuId, quantity] of closingBySku) {
        skuClosingSums.set(
          skuId,
          (skuClosingSums.get(skuId) ?? 0) + quantity
        );
      }
    }
  }

  const salesCompletedQuantity = periodSales.length;
  const averageWarehouseQuantity = ledgerReady
    ? round(closingWarehouseSum / range.dates.length, 2)
    : null;

  if (
    ledgerReady &&
    salesReady &&
    averageWarehouseQuantity === 0 &&
    salesCompletedQuantity > 0
  ) {
    addPeriodIssue(issues, "SALE_WITHOUT_WAREHOUSE_DENOMINATOR", 1);
  }

  const turnover = periodTurnover(
    salesCompletedQuantity,
    averageWarehouseQuantity,
    salesReady ? undefined : "판매 원장 시각을 검증할 수 없습니다."
  );
  const periodSalesBySku = new Map<number, number>();

  for (const row of periodSales) {
    if (row.sale.inventorySkuId) {
      periodSalesBySku.set(
        row.sale.inventorySkuId,
        (periodSalesBySku.get(row.sale.inventorySkuId) ?? 0) + 1
      );
    }
  }

  const skuIds = new Set([
    ...skuClosingSums.keys(),
    ...periodSalesBySku.keys(),
  ]);
  const skuRows: InventoryStatisticsPeriodSkuRow[] = Array.from(skuIds)
    .map((skuId) => {
      const sku = skuMetadataById.get(skuId);
      const soldQuantity = periodSalesBySku.get(skuId) ?? 0;
      const average = ledgerReady
        ? round((skuClosingSums.get(skuId) ?? 0) / range.dates.length, 2)
        : null;

      return {
        skuCode: sku?.skuCode ?? `SKU-${skuId}`,
        model: sku?.model ?? "미기록",
        storage: sku?.storage ?? "미기록",
        color: sku?.color ?? "미기록",
        saleGrade: sku?.saleGrade ?? "미기록",
        averageWarehouseQuantity: average,
        salesCompletedQuantity: soldQuantity,
        turnover: periodTurnover(
          soldQuantity,
          average,
          salesReady ? undefined : "판매 원장 시각을 검증할 수 없습니다."
        ),
      };
    })
    .sort(
      (left, right) =>
        right.salesCompletedQuantity - left.salesCompletedQuantity ||
        left.skuCode.localeCompare(right.skuCode, "ko")
    );

  const movementRowsInPeriod = movements.filter((row) => {
    const occurredAtMs = parseKstSqlDateTime(row.occurredAt)?.getTime();
    return (
      occurredAtMs !== undefined &&
      occurredAtMs !== null &&
      occurredAtMs >= range.fromMs &&
      occurredAtMs <= range.toMs
    );
  });
  const hasAnyData =
    input.balances.some((balance) => balance.quantity !== 0) ||
    movements.length > 0 ||
    sales.length > 0;
  const availability: InventoryLedgerAvailability = !hasAnyData
    ? "EMPTY"
    : issues.length > 0
      ? "PARTIAL"
      : "READY";

  return {
    preset: range.preset,
    fromDate: range.fromDate,
    toDate: range.toDate,
    dayCount: range.dates.length,
    integrity: {
      availability,
      issues,
    },
    source: {
      movementRowCount: movementRowsInPeriod.length,
      operationCount: periodOperations.length,
      skuReclassificationOperationCount: periodOperations.filter(
        (operation) =>
          operation.movementType ===
          INVENTORY_QUANTITY_MOVEMENT_TYPE.skuReclassification
      ).length,
      saleRecordCount: periodSales.length,
      classifiedSaleRecordCount: periodSales.filter(
        (row) => row.sale.inventorySkuId !== null
      ).length,
      unclassifiedSaleRecordCount: periodSales.filter(
        (row) => row.sale.inventorySkuId === null
      ).length,
      returnedSaleRecordCount: periodSales.filter(
        (row) => row.sale.saleStatus === "RETURNED"
      ).length,
      invalidSaleTimestampCount,
    },
    summary: {
      newInventoryQuantity: ledgerReady
        ? Array.from(dailyByDate.values()).reduce(
            (sum, point) => sum + (point.newInventoryQuantity ?? 0),
            0
          )
        : null,
      warehouseReentryQuantity: ledgerReady
        ? Array.from(dailyByDate.values()).reduce(
            (sum, point) => sum + (point.warehouseReentryQuantity ?? 0),
            0
          )
        : null,
      customerReturnReentryQuantity: ledgerReady
        ? Array.from(dailyByDate.values()).reduce(
            (sum, point) =>
              sum + (point.customerReturnReentryQuantity ?? 0),
            0
          )
        : null,
      otherWarehouseReentryQuantity: ledgerReady
        ? Array.from(dailyByDate.values()).reduce(
            (sum, point) =>
              sum + (point.otherWarehouseReentryQuantity ?? 0),
            0
          )
        : null,
      warehouseExitQuantity: ledgerReady
        ? Array.from(dailyByDate.values()).reduce(
            (sum, point) => sum + (point.warehouseExitQuantity ?? 0),
            0
          )
        : null,
      removedQuantity: ledgerReady
        ? Array.from(dailyByDate.values()).reduce(
            (sum, point) => sum + (point.removedQuantity ?? 0),
            0
          )
        : null,
      salesCompletedQuantity,
      averageWarehouseQuantity,
      turnover,
    },
    daily: Array.from(dailyByDate.values()),
    transitions: ledgerReady
      ? (Array.from(transitionCounts.values()).sort(
          (left, right) =>
            `${left.fromGroup ?? ""}:${left.toGroup ?? ""}`.localeCompare(
              `${right.fromGroup ?? ""}:${right.toGroup ?? ""}`
            )
        ) as InventoryStatisticsPeriodTransitionRow[])
      : [],
    skuRows,
  };
}

type InventoryStatisticsProjectionResult = {
  input: InventoryStatisticsAggregateInput;
  cutoffExcludedMovementCount: number;
  cutoffExcludedSaleRecordCount: number;
  asOfPriceExcludedCount: number;
  asOfReconstructionIssueCount: number;
};

function movementMatchesInventory(
  row: InventoryStatisticsInventoryInput,
  movement: InventoryStatisticsMovementInput
) {
  return (
    row.inventorySkuId === movement.inventorySkuId &&
    row.inventoryStatus === movement.inventoryStatus
  );
}

function projectInventoryStatisticsInputAsOf(
  input: InventoryStatisticsAggregateInput,
  cutoffExclusiveMs: number
): InventoryStatisticsProjectionResult {
  const movements = input.movements ?? [];
  const preCutoffMovements: InventoryStatisticsMovementInput[] = [];
  const postCutoffMovements: InventoryStatisticsMovementInput[] = [];
  let asOfReconstructionIssueCount = 0;

  for (const movement of movements) {
    const occurredAt = parseKstSqlDateTime(movement.occurredAt);

    if (!occurredAt) {
      preCutoffMovements.push(movement);
      asOfReconstructionIssueCount += 1;
    } else if (occurredAt.getTime() < cutoffExclusiveMs) {
      preCutoffMovements.push(movement);
    } else {
      postCutoffMovements.push(movement);
    }
  }

  const projectedBalances = input.balances.map((balance) => ({
    ...balance,
  }));
  const projectedBalanceById = new Map(
    projectedBalances.map((balance) => [balance.balanceId, balance])
  );
  for (const movement of postCutoffMovements) {
    const balance =
      movement.balanceId === undefined
        ? undefined
        : projectedBalanceById.get(movement.balanceId);

    if (!balance) {
      asOfReconstructionIssueCount += 1;
      continue;
    }

    balance.quantity -= movement.quantityDelta;
  }

  const skuMetadataById = new Map<number, InventoryStatisticsSkuInput>();

  for (const balance of input.balances) {
    if (balance.sku) {
      skuMetadataById.set(balance.inventorySkuId, balance.sku);
    }
  }
  for (const row of input.inventory) {
    if (row.inventorySkuId && row.sku) {
      skuMetadataById.set(row.inventorySkuId, row.sku);
    }
  }

  const projectedInventoryByPg = new Map<
    string,
    InventoryStatisticsInventoryInput
  >();
  const inventoryWithoutPg: InventoryStatisticsInventoryInput[] = [];

  for (const row of input.inventory) {
    const projectedRow = { ...row };

    const pgNo = text(row.pgNo);

    if (pgNo) {
      projectedInventoryByPg.set(pgNo, projectedRow);
    } else {
      inventoryWithoutPg.push(projectedRow);
    }
  }

  const foldedPostCutoff = foldInventoryMovementOperations(
    postCutoffMovements
  );

  if (foldedPostCutoff.issueCode) {
    asOfReconstructionIssueCount += 1;
  } else {
    const operations = [...foldedPostCutoff.operations].sort(
      (left, right) =>
        right.occurredAtMs - left.occurredAtMs ||
        right.firstMovementId - left.firstMovementId
    );

    for (const operation of operations) {
      const current = projectedInventoryByPg.get(operation.pgNo);
      const incoming = operation.inMovement;
      const outgoing = operation.outMovement;

      if (
        operation.movementType ===
        INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated
      ) {
        if (!current || !incoming || !movementMatchesInventory(current, incoming)) {
          asOfReconstructionIssueCount += 1;
          continue;
        }

        projectedInventoryByPg.delete(operation.pgNo);
        continue;
      }

      if (
        operation.movementType ===
        INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryRemoved
      ) {
        if (current || !outgoing) {
          asOfReconstructionIssueCount += 1;
          continue;
        }

        projectedInventoryByPg.set(operation.pgNo, {
          inventoryId: -operation.firstMovementId,
          pgNo: operation.pgNo,
          inventorySkuId: outgoing.inventorySkuId,
          inventoryStatus: outgoing.inventoryStatus,
          sku: skuMetadataById.get(outgoing.inventorySkuId) ?? null,
          purchasePrice: null,
          purchasePriceUpdatedAt: null,
        });
        continue;
      }

      if (
        !current ||
        !incoming ||
        !outgoing ||
        !movementMatchesInventory(current, incoming)
      ) {
        asOfReconstructionIssueCount += 1;
        continue;
      }

      projectedInventoryByPg.set(operation.pgNo, {
        ...current,
        inventorySkuId: outgoing.inventorySkuId,
        inventoryStatus: outgoing.inventoryStatus,
        sku: skuMetadataById.get(outgoing.inventorySkuId) ?? current.sku,
      });
    }
  }

  const projectedSales = (input.sales ?? []).filter((sale) => {
    const soldAt = parseStatisticsDate(sale.soldAt);
    return !soldAt || soldAt.getTime() < cutoffExclusiveMs;
  });
  let asOfPriceExcludedCount = 0;
  const projectedInventory = [
    ...inventoryWithoutPg,
    ...projectedInventoryByPg.values(),
  ].map((row) => {
    const purchasePriceUpdatedAt = text(row.purchasePriceUpdatedAt);
    const parsedPriceUpdatedAt = purchasePriceUpdatedAt
      ? parseStatisticsDate(purchasePriceUpdatedAt)
      : null;
    const excludePrice =
      Boolean(purchasePriceUpdatedAt) &&
      (!parsedPriceUpdatedAt ||
        parsedPriceUpdatedAt.getTime() >= cutoffExclusiveMs);

    if (
      excludePrice &&
      row.purchasePrice !== null &&
      row.purchasePrice !== undefined
    ) {
      asOfPriceExcludedCount += 1;
    }

    return {
      ...row,
      purchasePrice: excludePrice ? null : row.purchasePrice,
    };
  });
  const projection = {
    cutoffExcludedMovementCount: postCutoffMovements.length,
    cutoffExcludedSaleRecordCount:
      (input.sales?.length ?? 0) - projectedSales.length,
    asOfPriceExcludedCount,
    asOfReconstructionIssueCount,
  };

  return {
    input: {
      inventory: projectedInventory,
      balances: projectedBalances,
      movementCount: Math.max(
        0,
        input.movementCount - postCutoffMovements.length
      ),
      movements:
        input.movements === undefined ? undefined : preCutoffMovements,
      sales: input.sales === undefined ? undefined : projectedSales,
    },
    ...projection,
  };
}

function inventoryStatisticsCalculationMetadata(
  context: StatisticsPeriodContext
): StatisticsCalculationMetadata {
  return {
    mode: "LIVE",
    period: {
      ...context.range,
      dayCount: context.dayCount,
    },
    comparisonPeriod: {
      ...context.previousRange,
      dayCount: statisticsDateRangeDayCount(context.previousRange),
    },
    dataCutoffDate: context.dataCutoffDate,
    isDefaultPeriod: context.isDefault,
  };
}

export function aggregateInventoryStatistics(
  input: InventoryStatisticsAggregateInput,
  options: {
    now?: Date;
    period?: InventoryStatisticsPeriodPreset;
    periodContext?: StatisticsPeriodContext;
  } = {}
): InventoryStatisticsData {
  const now = options.now ?? quickHackClock.nowDate();
  const periodPreset = options.period ?? "90d";
  const sourceDates = [
    ...(input.movements ?? []).flatMap((row) => {
      const parsed = parseKstSqlDateTime(row.occurredAt);
      return parsed ? [parsed] : [];
    }),
    ...(input.sales ?? []).flatMap((row) => {
      const parsed = parseStatisticsDate(row.soldAt);
      return parsed ? [parsed] : [];
    }),
  ];
  const range = options.periodContext
    ? inventoryStatisticsPeriodRangeFromContext(options.periodContext)
    : resolveInventoryStatisticsPeriod({
        preset: periodPreset,
        now,
        sourceDates,
      });
  const projection = projectInventoryStatisticsInputAsOf(
    input,
    range.toMs + 1
  );
  const projectedInput = projection.input;
  const asOfNow = new Date(range.toMs);
  const actualByBucket = new Map<string, number>();
  const balanceByBucket = new Map<string, number>();
  let classifiedInventoryRowCount = 0;
  let unclassifiedInventoryRowCount = 0;
  let unknownInventoryStatusCount = 0;
  let unknownBalanceStatusCount = 0;
  let negativeBalanceCount = 0;

  for (const row of projectedInput.inventory) {
    const hasKnownStatus = KNOWN_INVENTORY_STATUSES.has(row.inventoryStatus);
    const hasInventorySku =
      Number.isInteger(row.inventorySkuId) && (row.inventorySkuId ?? 0) > 0;

    if (!hasKnownStatus) {
      unknownInventoryStatusCount += 1;
    }

    if (!hasInventorySku) {
      unclassifiedInventoryRowCount += 1;
    }

    if (hasKnownStatus && hasInventorySku) {
      classifiedInventoryRowCount += 1;
      increment(
        actualByBucket,
        inventoryBucketKey(
          row.inventorySkuId as number,
          row.inventoryStatus
        )
      );
    }
  }

  for (const row of projectedInput.balances) {
    if (!KNOWN_INVENTORY_STATUSES.has(row.inventoryStatus)) {
      unknownBalanceStatusCount += 1;
    } else {
      increment(
        balanceByBucket,
        inventoryBucketKey(row.inventorySkuId, row.inventoryStatus),
        row.quantity
      );
    }

    if (!Number.isInteger(row.quantity) || row.quantity < 0) {
      negativeBalanceCount += 1;
    }
  }

  const allBucketKeys = new Set([
    ...actualByBucket.keys(),
    ...balanceByBucket.keys(),
  ]);
  const movementCount = Math.max(
    0,
    Math.trunc(projectedInput.movementCount)
  );
  const hasLedgerEvidence =
    projectedInput.balances.length > 0 || movementCount > 0;
  const skuStatusMismatchCount = hasLedgerEvidence
    ? Array.from(allBucketKeys).filter(
        (key) =>
          (actualByBucket.get(key) ?? 0) !==
          (balanceByBucket.get(key) ?? 0)
      ).length
    : 0;
  const balanceQuantity = projectedInput.balances.reduce(
    (sum, balance) => sum + balance.quantity,
    0
  );
  const ledgerHasNoRows =
    projectedInput.balances.length === 0 && movementCount === 0;
  const asOfIsEmpty =
    projectedInput.inventory.length === 0 &&
    balanceQuantity === 0 &&
    movementCount === 0;
  const ledgerIsOneSided =
    !asOfIsEmpty &&
    ((projectedInput.balances.length === 0 && movementCount > 0) ||
      (projectedInput.balances.length > 0 && movementCount === 0));
  const hasClassificationOrBalanceIssue =
    unclassifiedInventoryRowCount > 0 ||
    unknownInventoryStatusCount > 0 ||
    unknownBalanceStatusCount > 0 ||
    negativeBalanceCount > 0 ||
    skuStatusMismatchCount > 0 ||
    projection.asOfReconstructionIssueCount > 0;
  let availability: InventoryLedgerAvailability;

  if (asOfIsEmpty) {
    availability = hasClassificationOrBalanceIssue ? "PARTIAL" : "EMPTY";
  } else if (ledgerHasNoRows) {
    availability = "PARTIAL";
  } else if (ledgerIsOneSided || hasClassificationOrBalanceIssue) {
    availability = "PARTIAL";
  } else {
    availability = "READY";
  }

  const issues: InventoryStatisticsIntegrityIssue[] = [];
  addIssue(
    issues,
    "LEDGER_MISSING",
    ledgerHasNoRows && !asOfIsEmpty ? 1 : 0
  );
  addIssue(issues, "LEDGER_ONE_SIDED", ledgerIsOneSided ? 1 : 0);
  addIssue(
    issues,
    "UNCLASSIFIED_INVENTORY",
    unclassifiedInventoryRowCount
  );
  addIssue(
    issues,
    "UNKNOWN_INVENTORY_STATUS",
    unknownInventoryStatusCount
  );
  addIssue(issues, "UNKNOWN_BALANCE_STATUS", unknownBalanceStatusCount);
  addIssue(issues, "NEGATIVE_BALANCE", negativeBalanceCount);
  addIssue(issues, "SKU_STATUS_MISMATCH", skuStatusMismatchCount);
  addIssue(
    issues,
    "AS_OF_RECONSTRUCTION_FAILED",
    projection.asOfReconstructionIssueCount
  );

  const exposesQuantity =
    availability === "READY" || availability === "EMPTY";
  const groups = currentGroups(projectedInput.balances, exposesQuantity);
  const aging = agingStatistics(projectedInput, availability, asOfNow);
  const period = periodStatistics(projectedInput, availability, range);

  return {
    generatedAt: now.toISOString(),
    calculation: inventoryStatisticsCalculationMetadata(range.context),
    source: {
      inventoryRowCount: projectedInput.inventory.length,
      classifiedInventoryRowCount,
      unclassifiedInventoryRowCount,
      balanceRowCount: projectedInput.balances.length,
      balanceQuantity,
      movementCount,
      unknownInventoryStatusCount,
      unknownBalanceStatusCount,
      negativeBalanceCount,
      skuStatusMismatchCount,
      cutoffExcludedMovementCount:
        projection.cutoffExcludedMovementCount,
      cutoffExcludedSaleRecordCount:
        projection.cutoffExcludedSaleRecordCount,
      asOfPriceExcludedCount: projection.asOfPriceExcludedCount,
      asOfReconstructionIssueCount:
        projection.asOfReconstructionIssueCount,
    },
    integrity: {
      availability,
      issues,
    },
    asOf: {
      date: range.toDate,
      totalQuantity: exposesQuantity
        ? groups.reduce(
            (sum, group) => sum + (group.quantity ?? 0),
            0
          )
        : null,
      groups,
    },
    aging,
    period,
  };
}

export async function loadInventoryStatisticsInput(
  owner: PrismaClient
): Promise<InventoryStatisticsAggregateInput> {
  return runConsistentReadSnapshot(
    owner,
    "statistics.inventory.input",
    async (tx) => {
      const inventoryRows = await loadStatisticsCursorPages({
        loadPage: (cursor, take) =>
          tx.inventory.findMany({
            orderBy: { inventory_id: "asc" },
            take,
            ...(cursor === undefined
              ? {}
              : {
                  cursor: { inventory_id: cursor },
                  skip: 1,
                }),
            select: {
              inventory_id: true,
              pg_no: true,
              inventory_status: true,
              devices: {
                select: {
                  inventory_sku_id: true,
                  inventory_sku: {
                    select: {
                      sku_code: true,
                      model_option: { select: { label: true } },
                      storage_option: { select: { label: true } },
                      color_option: { select: { label: true } },
                      sale_grade_option: { select: { label: true } },
                    },
                  },
                  inbounds: {
                    where: { inbound_status: INBOUND_STATUS.purchased },
                    orderBy: { inbound_id: "desc" },
                    take: 1,
                    select: {
                      purchase_price: true,
                      purchase_price_updated_at: true,
                    },
                  },
                },
              },
            },
          }),
        getCursor: (row) => row.inventory_id,
      });
      const balanceRows = await loadStatisticsCursorPages({
        loadPage: (cursor, take) =>
          tx.inventory_quantity_balances.findMany({
            orderBy: { inventory_quantity_balance_id: "asc" },
            take,
            ...(cursor === undefined
              ? {}
              : {
                  cursor: { inventory_quantity_balance_id: cursor },
                  skip: 1,
                }),
            select: {
              inventory_quantity_balance_id: true,
              inventory_sku_id: true,
              inventory_status: true,
              quantity: true,
              inventory_sku: {
                select: {
                  sku_code: true,
                  model_option: { select: { label: true } },
                  storage_option: { select: { label: true } },
                  color_option: { select: { label: true } },
                  sale_grade_option: { select: { label: true } },
                },
              },
            },
          }),
        getCursor: (row) => row.inventory_quantity_balance_id,
      });
      const movementRows = await loadStatisticsCursorPages({
        loadPage: (cursor, take) =>
          tx.inventory_quantity_movements.findMany({
            orderBy: { inventory_quantity_movement_id: "asc" },
            take,
            ...(cursor === undefined
              ? {}
              : {
                  cursor: { inventory_quantity_movement_id: cursor },
                  skip: 1,
                }),
            select: {
              inventory_quantity_movement_id: true,
              inventory_quantity_balance_id: true,
              operation_key: true,
              movement_type: true,
              pg_no: true,
              quantity_delta: true,
              before_quantity: true,
              after_quantity: true,
              occurred_at: true,
              balance: {
                select: {
                  inventory_sku_id: true,
                  inventory_status: true,
                },
              },
            },
          }),
        getCursor: (row) => row.inventory_quantity_movement_id,
      });
      movementRows.sort(
        (left, right) =>
          left.occurred_at.getTime() - right.occurred_at.getTime() ||
          left.inventory_quantity_movement_id -
            right.inventory_quantity_movement_id
      );
      const saleRows = await loadStatisticsCursorPages({
        loadPage: (cursor, take) =>
          tx.sales_records.findMany({
            orderBy: { sale_record_id: "asc" },
            take,
            ...(cursor === undefined
              ? {}
              : {
                  cursor: { sale_record_id: cursor },
                  skip: 1,
                }),
            select: {
              sale_record_id: true,
              pg_no: true,
              inventory_sku_id: true,
              sold_at: true,
              sale_status: true,
              model: true,
              storage: true,
              color: true,
              sale_grade: true,
              inventory_sku: {
                select: {
                  sku_code: true,
                  model_option: { select: { label: true } },
                  storage_option: { select: { label: true } },
                  color_option: { select: { label: true } },
                  sale_grade_option: { select: { label: true } },
                },
              },
            },
          }),
        getCursor: (row) => row.sale_record_id,
      });
      saleRows.sort(
        (left, right) =>
          left.sold_at.getTime() - right.sold_at.getTime() ||
          left.sale_record_id - right.sale_record_id
      );

      return {
        inventory: inventoryRows.map((row) => {
          const sku = row.devices.inventory_sku;

          return {
            inventoryId: row.inventory_id,
            pgNo: row.pg_no,
            inventorySkuId: row.devices.inventory_sku_id,
            inventoryStatus: row.inventory_status,
            sku: sku
              ? {
                  skuCode: sku.sku_code,
                  model: sku.model_option.label,
                  storage: sku.storage_option.label,
                  color: sku.color_option.label,
                  saleGrade: sku.sale_grade_option.label,
                }
              : null,
            purchasePrice:
              row.devices.inbounds[0]?.purchase_price ?? null,
            purchasePriceUpdatedAt: apiDateTime(
              row.devices.inbounds[0]?.purchase_price_updated_at
            ),
          };
        }),
        balances: balanceRows.map((row) => ({
          balanceId: row.inventory_quantity_balance_id,
          inventorySkuId: row.inventory_sku_id,
          inventoryStatus: row.inventory_status,
          quantity: row.quantity,
          sku: {
            skuCode: row.inventory_sku.sku_code,
            model: row.inventory_sku.model_option.label,
            storage: row.inventory_sku.storage_option.label,
            color: row.inventory_sku.color_option.label,
            saleGrade: row.inventory_sku.sale_grade_option.label,
          },
        })),
        movementCount: movementRows.length,
        movements: movementRows.map((row) => ({
          movementId: row.inventory_quantity_movement_id,
          balanceId: row.inventory_quantity_balance_id,
          operationKey: row.operation_key,
          movementType: row.movement_type,
          pgNo: row.pg_no ?? "",
          inventorySkuId: row.balance.inventory_sku_id,
          inventoryStatus: row.balance.inventory_status,
          quantityDelta: row.quantity_delta,
          beforeQuantity: row.before_quantity,
          afterQuantity: row.after_quantity,
          occurredAt: requiredApiDateTime(row.occurred_at),
        })),
        sales: saleRows.map((row) => {
          const sku = row.inventory_sku;

          return {
            saleRecordId: row.sale_record_id,
            pgNo: row.pg_no,
            inventorySkuId: row.inventory_sku_id,
            soldAt: requiredApiDateTime(row.sold_at),
            saleStatus: row.sale_status,
            sku: sku
              ? {
                  skuCode: sku.sku_code,
                  model: row.model ?? sku.model_option.label,
                  storage: row.storage ?? sku.storage_option.label,
                  color: row.color ?? sku.color_option.label,
                  saleGrade:
                    row.sale_grade ?? sku.sale_grade_option.label,
                }
              : null,
          };
        }),
      };
    },
    { timeout: 60_000 }
  );
}

export async function getInventoryStatisticsData(
  prisma: PrismaClient,
  options: {
    now?: Date;
    period?: InventoryStatisticsPeriodPreset;
    periodContext?: StatisticsPeriodContext;
  } = {}
) {
  const input = await loadInventoryStatisticsInput(prisma);
  return aggregateInventoryStatistics(input, options);
}
