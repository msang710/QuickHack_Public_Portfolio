import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  aggregateSalesStatistics,
  loadSalesStatisticsInput,
} from "../../quickhack_server/statistics/sales-statistics-service.ts";
import { resolveClosedStatisticsPeriod } from "../../quickhack_shared/statistics/statistics-period.ts";
import { SALES_STATISTICS_PRICE_BANDS } from "../../quickhack_shared/statistics/statistics.ts";

const NOW = new Date("2026-07-29T03:00:00.000Z");

function sale({
  id,
  status = "SOLD",
  soldAt = "2026-07-20 12:00:00",
  purchaseAgreedAt = "2026-07-01 12:00:00",
  salesPrice = 500_000,
  purchasePrice = 300_000,
  skuCode = "S24-256-BLK-A",
  channel = "COUPANG",
  model = "Galaxy S24",
  storage = "256GB",
  color = "Black",
  saleGrade = "A",
  warrantyGroup = "12개월",
}) {
  return {
    saleRecordId: id,
    skuCode,
    channel,
    soldAt,
    saleStatus: status,
    salesPrice,
    purchasePrice,
    purchaseAgreedAt,
    model,
    storage,
    color,
    saleGrade,
    warrantyGroup,
  };
}

const input = {
  sales: [
    sale({
      id: 1,
      soldAt: "2026-05-21 12:00:00",
      purchaseAgreedAt: "2026-05-01 12:00:00",
    }),
    sale({
      id: 2,
      status: "RETURNED",
      soldAt: "2026-06-30 12:00:00",
      purchaseAgreedAt: "2026-05-01 12:00:00",
      salesPrice: 0,
      purchasePrice: 100_000,
      color: "Blue",
      saleGrade: "B",
      skuCode: "S24-256-BLU-B",
    }),
    sale({
      id: 3,
      soldAt: "2026-07-10 12:00:00",
      purchaseAgreedAt: null,
      salesPrice: null,
      purchasePrice: 200_000,
      storage: "512GB",
      skuCode: "S24-512-BLK-A",
    }),
    sale({
      id: 4,
      soldAt: "2026-07-20 12:00:00",
      purchaseAgreedAt: "2026-07-21 12:00:00",
      salesPrice: 700_000,
      purchasePrice: null,
      model: "Galaxy S25",
      skuCode: "S25-256-BLK-A",
    }),
    sale({
      id: 5,
      status: "PENDING",
      model: "Pending Model",
      skuCode: "PENDING-SKU",
    }),
    sale({
      id: 6,
      soldAt: "not-a-date",
      model: "Invalid Date Model",
      skuCode: "INVALID-DATE-SKU",
    }),
    sale({
      id: 7,
      soldAt: "2026-08-01 12:00:00",
      model: "Future Model",
      skuCode: "FUTURE-SKU",
    }),
  ],
};

const result = aggregateSalesStatistics(input, { now: NOW });

assert.equal(result.source.loadedSaleRecordCount, 7);
assert.equal(result.source.periodEligibleSaleRecordCount, 4);
assert.equal(result.source.outsidePeriodSaleRecordCount, 0);
assert.equal(result.source.cutoffExcludedSaleRecordCount, 1);
assert.equal(result.source.eligibleSaleRecordCount, 4);
assert.equal(result.source.soldSaleRecordCount, 3);
assert.equal(result.source.returnedSaleRecordCount, 1);
assert.equal(result.source.excludedStatusCount, 1);
assert.equal(result.source.invalidSoldAtCount, 1);
assert.equal(result.source.futureSoldAtCount, 1);
assert.deepEqual(result.calculation, {
  mode: "LIVE",
  period: {
    fromDate: "2026-04-30",
    toDate: "2026-07-28",
    dayCount: 90,
  },
  comparisonPeriod: {
    fromDate: "2026-01-30",
    toDate: "2026-04-29",
    dayCount: 90,
  },
  dataCutoffDate: "2026-07-28",
  isDefaultPeriod: true,
});

assert.equal(result.summary.saleCount, 4);
assert.deepEqual(result.summary.salesAmount, {
  amount: 1_200_000,
  pricedCount: 3,
  totalCount: 4,
  coveragePercent: 75,
});
assert.equal(result.summary.averageSalesPrice, 400_000);
assert.deepEqual(result.summary.purchaseCost, {
  amount: 600_000,
  pricedCount: 3,
  totalCount: 4,
  coveragePercent: 75,
});
assert.deepEqual(result.summary.grossProfit, {
  amount: 100_000,
  salesAmount: 500_000,
  purchaseCostAmount: 400_000,
  comparableCount: 2,
  totalCount: 4,
  coveragePercent: 50,
  marginPercent: 20,
});
assert.equal(
  result.summary.grossProfit.amount,
  100_000,
  "0원 판매의 음수 상품 매출총이익도 사실 그대로 합산해야 합니다."
);
assert.equal(result.summary.leadTime.averageDays, 40);
assert.equal(result.summary.leadTime.sampleCount, 2);
assert.equal(result.summary.leadTime.totalCount, 4);
assert.equal(result.summary.leadTime.coveragePercent, 50);
assert.equal(result.summary.leadTime.excludedAnomalyCount, 1);
assert.deepEqual(
  result.summary.leadTime.buckets.map((bucket) => bucket.count),
  [1, 0, 1, 0]
);
assert.equal(result.source.missingPurchaseAgreedAtCount, 1);
assert.equal(result.source.invalidLeadTimeCount, 1);

assert.deepEqual(
  result.monthlyTrend.map((row) => [row.month, row.saleCount]),
  [
    ["2026-05", 1],
    ["2026-06", 1],
    ["2026-07", 2],
  ]
);
assert.equal(result.productRows.length, 4);
assert.equal(
  result.productRows.find((row) => row.skuCode === "S24-256-BLU-B")
    ?.grossProfit.amount,
  -100_000
);
assert.equal(
  result.dimensionRows.filter((row) => row.dimension === "MODEL").length,
  2
);
assert.deepEqual(
  result.priceGradeRows.map((row) => row.priceBand),
  SALES_STATISTICS_PRICE_BANDS
);
assert.deepEqual(result.priceGradeColumns, ["A", "B"]);
assert.equal(
  result.priceGradeRows.find((row) => row.priceBand === "PRICE_UNKNOWN")
    ?.totalCount,
  1
);
assert.equal(result.channelRows.length, 1);

const directPeriod = resolveClosedStatisticsPeriod({
  now: NOW,
  fromDate: "2026-07-01",
  toDate: "2026-07-10",
});
const boundaryResult = aggregateSalesStatistics(
  {
    sales: [
      sale({ id: 101, soldAt: "2026-07-01 00:00:00", model: "Boundary" }),
      sale({ id: 102, soldAt: "2026-07-10 23:59:59", model: "Boundary" }),
      sale({ id: 103, soldAt: "2026-06-30 23:59:59", model: "Boundary" }),
      sale({ id: 104, soldAt: "2026-07-11 00:00:00", model: "Boundary" }),
      sale({ id: 105, soldAt: "2026-07-29 00:00:00", model: "Boundary" }),
    ],
  },
  {
    now: NOW,
    period: directPeriod,
  }
);
assert.equal(boundaryResult.summary.saleCount, 2);
assert.equal(boundaryResult.source.periodEligibleSaleRecordCount, 2);
assert.equal(boundaryResult.source.outsidePeriodSaleRecordCount, 2);
assert.equal(boundaryResult.source.cutoffExcludedSaleRecordCount, 1);
assert.equal(boundaryResult.calculation.isDefaultPeriod, false);

const pagedRows = Array.from({ length: 501 }, (_, index) => ({
  sale_record_id: index + 1,
  channel: "COUPANG",
  sold_at: "2026-07-20 12:00:00",
  sale_status: "SOLD",
  sales_price: 500_000,
  purchase_price: 300_000,
  purchase_agreed_at: "2026-07-01 12:00:00",
  model: "Galaxy S24",
  storage: "256GB",
  color: "Black",
  sale_grade: "A",
  warranty_group: "12개월",
  inventory_sku: { sku_code: `SKU-${index + 1}` },
}));
const pageCalls = [];
const pagedInput = await loadSalesStatisticsInput({
  sales_records: {
    async findMany(args) {
      pageCalls.push(args);
      const start = args.cursor
        ? pagedRows.findIndex(
            (row) =>
              row.sale_record_id === args.cursor.sale_record_id
          ) + args.skip
        : 0;
      return pagedRows.slice(start, start + args.take);
    },
  },
});
assert.equal(pagedInput.sales.length, 501);
assert.equal(pageCalls.length, 2);
assert.equal(pagedInput.sales[500].skuCode, "SKU-501");

const benchmarkInput = {
  sales: Array.from({ length: 10_000 }, (_, index) =>
    sale({
      id: index + 1,
      soldAt: `2026-${String((index % 7) + 1).padStart(
        2,
        "0"
      )}-${String((index % 27) + 1).padStart(2, "0")} 12:00:00`,
      purchaseAgreedAt: "2025-12-01 12:00:00",
      model: `Model ${index % 25}`,
      storage: `${128 * ((index % 4) + 1)}GB`,
      color: `Color ${index % 6}`,
      saleGrade: ["A", "A-", "B+", "B"][index % 4],
      warrantyGroup: `${(index % 3) + 1}년`,
      skuCode: `SKU-${index % 300}`,
      channel: index % 4 === 0 ? "OFFLINE" : "COUPANG",
    })
  ),
};
const startedAt = performance.now();
const benchmarkResult = aggregateSalesStatistics(benchmarkInput, {
  now: NOW,
  period: resolveClosedStatisticsPeriod({
    now: NOW,
    fromDate: "2026-01-01",
    toDate: "2026-07-28",
  }),
});
const elapsedMs = performance.now() - startedAt;
assert.equal(benchmarkResult.summary.saleCount, 10_000);
assert.ok(
  elapsedMs < 5_000,
  `10,000-row sales aggregation exceeded 5 seconds: ${elapsedMs.toFixed(
    1
  )}ms`
);

console.log(
  `Sales ledger aggregation, coverage, period boundaries, pagination, and 10,000-row performance verified in ${elapsedMs.toFixed(
    1
  )}ms.`
);
