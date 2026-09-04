// QuickHack service: aggregate-only sales statistics from the confirmed PG-level sales ledger.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import {
  parseKstSqlDateTime,
  quickHackClock,
} from "@/quickhack_shared/core/time";
import type {
  SalesAmountMetric,
  SalesChannelPerformanceRow,
  SalesDimensionKey,
  SalesDimensionPerformanceRow,
  SalesGrossProfitMetric,
  SalesLeadTimeBucket,
  SalesLeadTimeMetric,
  SalesMonthlyTrendRow,
  SalesPriceGradeRow,
  SalesProductPerformanceRow,
  SalesRateMetric,
  SalesStatisticsData,
} from "@/quickhack_shared/statistics/statistics";
import {
  SALES_STATISTICS_PRICE_BANDS,
  SALES_STATISTICS_UNKNOWN,
} from "@/quickhack_shared/statistics/statistics";
import {
  resolveClosedStatisticsPeriod,
  statisticsDateTimeBounds,
  type StatisticsPeriodContext,
} from "@/quickhack_shared/statistics/statistics-period";
import { loadStatisticsCursorPages } from "@/quickhack_server/statistics/statistics-loader";
import { liveStatisticsCalculationMetadata } from "@/quickhack_server/statistics/statistics-period-request";

const DAY_MS = 24 * 60 * 60 * 1000;
const ELIGIBLE_SALE_STATUSES = new Set(["SOLD", "RETURNED"]);
const LEAD_TIME_BUCKETS = [
  {
    key: "DAYS_0_29",
    fromDays: 0,
    toDays: 30,
  },
  {
    key: "DAYS_30_59",
    fromDays: 30,
    toDays: 60,
  },
  {
    key: "DAYS_60_89",
    fromDays: 60,
    toDays: 90,
  },
  {
    key: "DAYS_90_PLUS",
    fromDays: 90,
    toDays: null,
  },
] as const;
const DIMENSIONS: Array<{
  key: SalesDimensionKey;
  value: (row: PreparedSale) => string;
}> = [
  { key: "MODEL", value: (row) => row.modelKey },
  { key: "STORAGE", value: (row) => row.storageKey },
  { key: "COLOR", value: (row) => row.colorKey },
  { key: "SALE_GRADE", value: (row) => row.saleGradeKey },
  { key: "WARRANTY_GROUP", value: (row) => row.warrantyGroupKey },
  { key: "CHANNEL", value: (row) => row.channelKey },
];
const KST_MONTH_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
});

export type SalesStatisticsRecordInput = {
  saleRecordId: number;
  skuCode: string | null;
  channel: string | null;
  soldAt: string | null;
  saleStatus: string | null;
  salesPrice: number | null;
  purchasePrice: number | null;
  purchaseAgreedAt: string | null;
  model: string | null;
  storage: string | null;
  color: string | null;
  saleGrade: string | null;
  warrantyGroup: string | null;
};

export type SalesStatisticsAggregateInput = {
  sales: SalesStatisticsRecordInput[];
};

type PreparedSale = SalesStatisticsRecordInput & {
  normalizedStatus: string;
  soldDate: Date | null;
  purchaseAgreedDate: Date | null;
  skuCodeKey: string;
  channelKey: string;
  modelKey: string;
  storageKey: string;
  colorKey: string;
  saleGradeKey: string;
  warrantyGroupKey: string;
};

const salesStatisticsSelect = {
  sale_record_id: true,
  channel: true,
  sold_at: true,
  sale_status: true,
  sales_price: true,
  purchase_price: true,
  purchase_agreed_at: true,
  model: true,
  storage: true,
  color: true,
  sale_grade: true,
  warranty_group: true,
  inventory_sku: {
    select: {
      sku_code: true,
    },
  },
} satisfies Prisma.sales_recordsSelect;

function nullableText(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function parseDate(value: string | null | undefined) {
  const normalized = nullableText(value);

  if (!normalized) {
    return null;
  }

  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(normalized)) {
    return parseKstSqlDateTime(normalized);
  }

  const parsed = new Date(normalized);
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
  unavailableReasonCode: SalesRateMetric["unavailableReasonCode"] = "NO_DENOMINATOR"
): SalesRateMetric {
  if (denominator === 0) {
    return {
      value: null,
      numerator,
      denominator,
      unavailableReasonCode,
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

function amountMetric(
  rows: PreparedSale[],
  value: (row: PreparedSale) => number | null
): SalesAmountMetric {
  const amounts = rows.map(value).filter(validMoney);

  return {
    amount:
      amounts.length === 0
        ? null
        : amounts.reduce((sum, amount) => sum + amount, 0),
    pricedCount: amounts.length,
    totalCount: rows.length,
    coveragePercent: percentage(amounts.length, rows.length),
  };
}

function averageAmount(metric: SalesAmountMetric) {
  return metric.amount === null || metric.pricedCount === 0
    ? null
    : Math.round(metric.amount / metric.pricedCount);
}

function grossProfitMetric(rows: PreparedSale[]): SalesGrossProfitMetric {
  const comparable = rows.filter(
    (row) => validMoney(row.salesPrice) && validMoney(row.purchasePrice)
  );
  const salesAmount =
    comparable.length === 0
      ? null
      : comparable.reduce(
          (sum, row) => sum + (row.salesPrice as number),
          0
        );
  const purchaseCostAmount =
    comparable.length === 0
      ? null
      : comparable.reduce(
          (sum, row) => sum + (row.purchasePrice as number),
          0
        );
  const amount =
    salesAmount === null || purchaseCostAmount === null
      ? null
      : salesAmount - purchaseCostAmount;

  return {
    amount,
    salesAmount,
    purchaseCostAmount,
    comparableCount: comparable.length,
    totalCount: rows.length,
    coveragePercent: percentage(comparable.length, rows.length),
    marginPercent:
      amount === null || salesAmount === null || salesAmount === 0
        ? null
        : round((amount / salesAmount) * 100),
  };
}

function leadTimeDays(row: PreparedSale) {
  if (row.purchaseAgreedDate === null || row.soldDate === null) {
    return null;
  }

  const duration = (row.soldDate.getTime() - row.purchaseAgreedDate.getTime()) /
    DAY_MS;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function leadTimeMetric(rows: PreparedSale[]): SalesLeadTimeMetric {
  const values: number[] = [];
  let excludedAnomalyCount = 0;

  for (const row of rows) {
    if (!nullableText(row.purchaseAgreedAt)) {
      continue;
    }

    const duration = leadTimeDays(row);

    if (duration === null) {
      excludedAnomalyCount += 1;
      continue;
    }

    values.push(duration);
  }

  const buckets: SalesLeadTimeBucket[] = LEAD_TIME_BUCKETS.map((bucket) => ({
    key: bucket.key,
    count: values.filter(
      (value) =>
        value >= bucket.fromDays &&
        (bucket.toDays === null || value < bucket.toDays)
    ).length,
  }));

  return {
    averageDays:
      values.length === 0
        ? null
        : round(values.reduce((sum, value) => sum + value, 0) / values.length),
    sampleCount: values.length,
    totalCount: rows.length,
    coveragePercent: percentage(values.length, rows.length),
    excludedAnomalyCount,
    buckets,
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

function priceBandOf(price: number | null) {
  if (!validMoney(price)) {
    return "PRICE_UNKNOWN";
  }
  if (price < 100_000) return "PRICE_LT_100K";
  if (price < 200_000) return "PRICE_100K_199K";
  if (price < 300_000) return "PRICE_200K_299K";
  if (price < 400_000) return "PRICE_300K_399K";
  if (price < 500_000) return "PRICE_400K_499K";
  if (price < 600_000) return "PRICE_500K_599K";
  return "PRICE_600K_PLUS";
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

function performanceMetrics(rows: PreparedSale[]) {
  const salesAmount = amountMetric(rows, (row) => row.salesPrice);

  return {
    saleCount: rows.length,
    salesAmount,
    averageSalesPrice: averageAmount(salesAmount),
    grossProfit: grossProfitMetric(rows),
  };
}

function prepareSales(input: SalesStatisticsAggregateInput) {
  return input.sales
    .map<PreparedSale>((sale) => {
      const skuCodeKey = nullableText(sale.skuCode) ?? SALES_STATISTICS_UNKNOWN.sku;
      const channelKey = nullableText(sale.channel) ?? SALES_STATISTICS_UNKNOWN.channel;
      const modelKey = nullableText(sale.model) ?? SALES_STATISTICS_UNKNOWN.model;
      const storageKey = nullableText(sale.storage) ?? SALES_STATISTICS_UNKNOWN.storage;
      const colorKey = nullableText(sale.color) ?? SALES_STATISTICS_UNKNOWN.color;
      const saleGradeKey = nullableText(sale.saleGrade) ?? SALES_STATISTICS_UNKNOWN.grade;
      const warrantyGroupKey =
        nullableText(sale.warrantyGroup) ?? SALES_STATISTICS_UNKNOWN.warranty;

      return {
        ...sale,
        normalizedStatus: nullableText(sale.saleStatus)?.toUpperCase() ?? "",
        soldDate: parseDate(sale.soldAt),
        purchaseAgreedDate: parseDate(sale.purchaseAgreedAt),
        skuCodeKey,
        channelKey,
        modelKey,
        storageKey,
        colorKey,
        saleGradeKey,
        warrantyGroupKey,
      };
    })
    .sort((left, right) => left.saleRecordId - right.saleRecordId);
}

function monthlyTrend(rows: PreparedSale[]): SalesMonthlyTrendRow[] {
  return Array.from(groupBy(rows, (row) => monthKey(row.soldDate as Date)))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, monthRows]) => ({
      month,
      ...performanceMetrics(monthRows),
    }));
}

function productRows(rows: PreparedSale[]): SalesProductPerformanceRow[] {
  const groups = groupBy(rows, (row) =>
    [
      row.skuCodeKey,
      row.modelKey,
      row.storageKey,
      row.colorKey,
      row.saleGradeKey,
      row.warrantyGroupKey,
    ].join("\u001f")
  );

  return Array.from(groups, ([key, productSales]) => {
    const first = productSales[0] as PreparedSale;
    const metrics = performanceMetrics(productSales);
    const leadTime = leadTimeMetric(productSales);

    return {
      key,
      skuCode: first.skuCodeKey,
      model: first.modelKey,
      storage: first.storageKey,
      color: first.colorKey,
      saleGrade: first.saleGradeKey,
      warrantyGroup: first.warrantyGroupKey,
      ...metrics,
      saleShare: rateMetric(productSales.length, rows.length),
      leadTime,
      longTermSaleCount:
        leadTime.buckets.find((bucket) => bucket.key === "DAYS_90_PLUS")
          ?.count ?? 0,
    };
  }).sort(
    (left, right) =>
      right.saleCount - left.saleCount ||
      left.model.localeCompare(right.model, "ko-KR") ||
      left.storage.localeCompare(right.storage, "ko-KR") ||
      left.color.localeCompare(right.color, "ko-KR") ||
      left.saleGrade.localeCompare(right.saleGrade, "ko-KR")
  );
}

function dimensionRows(
  rows: PreparedSale[]
): SalesDimensionPerformanceRow[] {
  return DIMENSIONS.flatMap((dimension) =>
    Array.from(groupBy(rows, dimension.value), ([label, groupRows]) => ({
      dimension: dimension.key,
      label,
      ...performanceMetrics(groupRows),
      saleShare: rateMetric(groupRows.length, rows.length),
    })).sort(
      (left, right) =>
        right.saleCount - left.saleCount ||
        left.label.localeCompare(right.label, "ko-KR")
    )
  );
}

function gradeOrder(value: string) {
  const preferred = ["S", "A+", "A", "A-", "B+", "B", "B-", "C"];
  const index = preferred.indexOf(value.toUpperCase());
  return index === -1 ? preferred.length : index;
}

function priceGradeMatrix(rows: PreparedSale[]) {
  const priceGradeColumns = Array.from(
    new Set(rows.map((row) => row.saleGradeKey))
  ).sort(
    (left, right) =>
      gradeOrder(left) - gradeOrder(right) ||
      left.localeCompare(right, "ko-KR")
  );
  const priceGradeRows: SalesPriceGradeRow[] = SALES_STATISTICS_PRICE_BANDS.map((priceBand) => {
    const bandRows = rows.filter(
      (row) => priceBandOf(row.salesPrice) === priceBand
    );
    return {
      priceBand,
      totalCount: bandRows.length,
      gradeCounts: Object.fromEntries(
        priceGradeColumns.map((grade) => [
          grade,
          bandRows.filter((row) => row.saleGradeKey === grade).length,
        ])
      ),
    };
  });

  return { priceGradeColumns, priceGradeRows };
}

function channelRows(rows: PreparedSale[]): SalesChannelPerformanceRow[] {
  return Array.from(groupBy(rows, (row) => row.channelKey), ([channel, sales]) => ({
    channel,
    ...performanceMetrics(sales),
    saleShare: rateMetric(sales.length, rows.length),
    leadTime: leadTimeMetric(sales),
  })).sort(
    (left, right) =>
      right.saleCount - left.saleCount ||
      left.channel.localeCompare(right.channel, "ko-KR")
  );
}

export function aggregateSalesStatistics(
  input: SalesStatisticsAggregateInput,
  options: {
    now?: Date;
    period?: StatisticsPeriodContext;
  } = {}
): SalesStatisticsData {
  const now = options.now ?? quickHackClock.nowDate();
  const period =
    options.period ?? resolveClosedStatisticsPeriod({ now });
  const periodBounds = statisticsDateTimeBounds(period.range);
  const cutoffExclusive = statisticsDateTimeBounds({
    fromDate: period.dataCutoffDate,
    toDate: period.dataCutoffDate,
  }).toExclusive;
  const loaded = prepareSales(input);
  const statusEligible = loaded.filter((row) =>
    ELIGIBLE_SALE_STATUSES.has(row.normalizedStatus)
  );
  const invalidSoldAtCount = statusEligible.filter(
    (row) => row.soldDate === null
  ).length;
  const cutoffExcludedSaleRecordCount = statusEligible.filter(
    (row) =>
      row.soldDate !== null &&
      row.soldDate.getTime() >= cutoffExclusive.getTime()
  ).length;
  const validBeforeCutoff = statusEligible.filter(
    (row): row is PreparedSale & { soldDate: Date } =>
      row.soldDate !== null &&
      row.soldDate.getTime() < cutoffExclusive.getTime()
  );
  const periodEligible = validBeforeCutoff.filter(
    (row) =>
      row.soldDate.getTime() >= periodBounds.fromInclusive.getTime() &&
      row.soldDate.getTime() < periodBounds.toExclusive.getTime()
  );
  const eligible = periodEligible;
  const salesAmount = amountMetric(eligible, (row) => row.salesPrice);
  const purchaseCost = amountMetric(eligible, (row) => row.purchasePrice);
  const grossProfit = grossProfitMetric(eligible);
  const leadTime = leadTimeMetric(eligible);
  const missingPurchaseAgreedAtCount = eligible.filter(
    (row) => nullableText(row.purchaseAgreedAt) === null
  ).length;
  const { priceGradeColumns, priceGradeRows } = priceGradeMatrix(eligible);

  return {
    generatedAt: now.toISOString(),
    calculation: liveStatisticsCalculationMetadata(period),
    source: {
      loadedSaleRecordCount: loaded.length,
      periodEligibleSaleRecordCount: periodEligible.length,
      outsidePeriodSaleRecordCount:
        validBeforeCutoff.length - periodEligible.length,
      cutoffExcludedSaleRecordCount,
      eligibleSaleRecordCount: eligible.length,
      soldSaleRecordCount: eligible.filter(
        (row) => row.normalizedStatus === "SOLD"
      ).length,
      returnedSaleRecordCount: eligible.filter(
        (row) => row.normalizedStatus === "RETURNED"
      ).length,
      excludedStatusCount: loaded.filter(
        (row) => !ELIGIBLE_SALE_STATUSES.has(row.normalizedStatus)
      ).length,
      invalidSoldAtCount,
      futureSoldAtCount: cutoffExcludedSaleRecordCount,
      pricedSaleCount: salesAmount.pricedCount,
      salesPriceCoveragePercent: salesAmount.coveragePercent,
      purchasePricedSaleCount: purchaseCost.pricedCount,
      purchasePriceCoveragePercent: purchaseCost.coveragePercent,
      comparableProfitCount: grossProfit.comparableCount,
      profitCoveragePercent: grossProfit.coveragePercent,
      leadTimeSampleCount: leadTime.sampleCount,
      missingPurchaseAgreedAtCount,
      invalidLeadTimeCount: leadTime.excludedAnomalyCount,
    },
    summary: {
      saleCount: eligible.length,
      salesAmount,
      averageSalesPrice: averageAmount(salesAmount),
      purchaseCost,
      grossProfit,
      leadTime,
    },
    monthlyTrend: monthlyTrend(eligible),
    productRows: productRows(eligible),
    dimensionRows: dimensionRows(eligible),
    priceGradeColumns,
    priceGradeRows,
    channelRows: channelRows(eligible),
  };
}

export async function loadSalesStatisticsInput(
  prisma: PrismaClient
): Promise<SalesStatisticsAggregateInput> {
  const rows = await loadStatisticsCursorPages({
    loadPage: (cursor, take) =>
      prisma.sales_records.findMany({
        select: salesStatisticsSelect,
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

  return {
    sales: rows.map((sale) => ({
      saleRecordId: sale.sale_record_id,
      skuCode: sale.inventory_sku?.sku_code ?? null,
      channel: sale.channel,
      soldAt: requiredApiDateTime(sale.sold_at),
      saleStatus: sale.sale_status,
      salesPrice: sale.sales_price,
      purchasePrice: sale.purchase_price,
      purchaseAgreedAt: apiDateTime(sale.purchase_agreed_at),
      model: sale.model,
      storage: sale.storage,
      color: sale.color,
      saleGrade: sale.sale_grade,
      warrantyGroup: sale.warranty_group,
    })),
  };
}

export async function getSalesStatisticsData(
  prisma: PrismaClient,
  options: { now?: Date; period?: StatisticsPeriodContext } = {}
) {
  const input = await loadSalesStatisticsInput(prisma);
  return aggregateSalesStatistics(input, {
    now: options.now,
    period: options.period,
  });
}
