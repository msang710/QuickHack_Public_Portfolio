import assert from "node:assert/strict";
import {
  formatSalesAmount,
  formatSalesAveragePrice,
  formatSalesGrossProfit,
  formatSalesLeadTime,
  formatSalesRate,
  formatSalesStatisticsMonth,
} from "../../quickhack_client/components/statistics/sales-statistics-presentation.ts";

assert.deepEqual(
  formatSalesRate({ value: 0, numerator: 0, denominator: 4 }),
  { value: "0%", detail: "0 / 4건" }
);
assert.equal(
  formatSalesRate({
    value: null,
    numerator: 0,
    denominator: 0,
  }).value,
  "-"
);

assert.deepEqual(
  formatSalesAmount({
    amount: 0,
    pricedCount: 2,
    totalCount: 2,
    coveragePercent: 100,
  }),
  {
    value: "₩0",
    detail: "가격 확인 2 / 2건 · 100%",
  }
);
assert.equal(
  formatSalesAmount({
    amount: null,
    pricedCount: 0,
    totalCount: 3,
    coveragePercent: 0,
  }).value,
  "-"
);
assert.deepEqual(formatSalesAveragePrice(0, 1, 2), {
  value: "₩0",
  detail: "가격 확인 1 / 2건",
});
assert.equal(formatSalesAveragePrice(null, 0, 2).value, "-");

assert.deepEqual(
  formatSalesGrossProfit({
    amount: -100_000,
    salesAmount: 300_000,
    purchaseCostAmount: 400_000,
    comparableCount: 1,
    totalCount: 2,
    coveragePercent: 50,
    marginPercent: -33.33,
  }),
  {
    value: "-₩100,000",
    detail: "이익률 -33.3% · 비교 1 / 2건 · 50%",
  }
);
assert.equal(
  formatSalesGrossProfit({
    amount: null,
    salesAmount: null,
    purchaseCostAmount: null,
    comparableCount: 0,
    totalCount: 2,
    coveragePercent: 0,
    marginPercent: null,
  }).value,
  "-"
);

assert.deepEqual(
  formatSalesLeadTime({
    averageDays: 35.25,
    sampleCount: 2,
    totalCount: 4,
    coveragePercent: 50,
    excludedAnomalyCount: 1,
    buckets: [],
  }),
  {
    value: "35.3일",
    detail: "표본 2 / 4건 · 50% · 이상 1건 제외",
  }
);
assert.equal(
  formatSalesLeadTime({
    averageDays: null,
    sampleCount: 0,
    totalCount: 3,
    coveragePercent: 0,
    excludedAnomalyCount: 0,
    buckets: [],
  }).value,
  "-"
);
assert.equal(formatSalesStatisticsMonth("2026-07"), "2026년 7월");

console.log("Sales statistics presentation contracts verified.");
