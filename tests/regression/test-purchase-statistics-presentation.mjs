import assert from "node:assert/strict";
import {
  formatPurchaseAdjustmentAmount,
  formatPurchaseAdjustmentPercent,
  formatPurchaseAmount,
  formatPurchaseAveragePrice,
  formatPurchaseDuration,
  formatPurchaseRate,
  formatPurchaseStatisticsDate,
  formatPurchaseStatisticsMonth,
  purchasePricePolicyLabel,
} from "../../quickhack_client/components/statistics/purchase-statistics-presentation.ts";

assert.deepEqual(
  formatPurchaseRate({ value: 0, numerator: 0, denominator: 5 }),
  { value: "0%", detail: "0 / 5건" },
  "실제 0%는 자료 없음으로 표시하면 안 됩니다."
);
assert.deepEqual(
  formatPurchaseRate(
    {
      value: null,
      numerator: 0,
      denominator: 0,
      unavailableReason: "30일 관찰이 끝난 매입 회차가 없습니다.",
    },
    { maturityPending: true }
  ),
  {
    value: "관찰 중",
    detail: "30일 관찰이 끝난 매입 회차가 없습니다.",
  }
);
assert.equal(
  formatPurchaseRate({
    value: null,
    numerator: 0,
    denominator: 0,
  }).value,
  "-"
);

assert.equal(
  formatPurchaseAmount({
    amount: null,
    pricedCount: 0,
    totalCount: 3,
    coveragePercent: 0,
  }).value,
  "-"
);
assert.deepEqual(
  formatPurchaseAmount({
    amount: 0,
    pricedCount: 2,
    totalCount: 2,
    coveragePercent: 100,
  }),
  {
    value: "₩0",
    detail: "가격 확인 2 / 2건 · 100%",
  },
  "가격 표본이 있는 실제 0원은 자료 없음과 구분해야 합니다."
);

assert.equal(formatPurchaseAveragePrice(null), "-");
assert.equal(formatPurchaseAveragePrice(0), "₩0");
assert.equal(formatPurchaseAdjustmentAmount(null), "-");
assert.equal(formatPurchaseAdjustmentAmount(0), "₩0");
assert.equal(formatPurchaseAdjustmentAmount(15000), "+₩15,000");
assert.equal(formatPurchaseAdjustmentAmount(-15000), "-₩15,000");
assert.equal(formatPurchaseAdjustmentPercent(null), "-");
assert.equal(formatPurchaseAdjustmentPercent(2.5), "+2.5%");
assert.equal(formatPurchaseAdjustmentPercent(-1.2), "-1.2%");

assert.equal(
  formatPurchaseDuration({
    sampleCount: 0,
    medianHours: null,
    p90Hours: null,
    excludedAnomalyCount: 0,
  }).value,
  "-"
);
assert.deepEqual(
  formatPurchaseDuration({
    sampleCount: 4,
    medianHours: 12.5,
    p90Hours: 30,
    excludedAnomalyCount: 1,
  }),
  {
    value: "12.5시간",
    detail: "P90 30시간 · 표본 4건 · 이상치 1건 제외",
  }
);

assert.equal(purchasePricePolicyLabel("RATE"), "기준가 적용");
assert.equal(purchasePricePolicyLabel("OVERRIDE"), "기준가 조정");
assert.equal(purchasePricePolicyLabel("MANUAL"), "수동 입력");
assert.equal(purchasePricePolicyLabel("UNKNOWN"), "과거 미기록");
assert.equal(formatPurchaseStatisticsMonth("2026-07"), "2026년 7월");
assert.equal(formatPurchaseStatisticsMonth("unknown"), "unknown");
assert.match(
  formatPurchaseStatisticsDate("2026-07-27T00:00:00.000Z"),
  /2026.*7.*27.*오전 9:00/
);
assert.equal(formatPurchaseStatisticsDate(null), "-");
assert.equal(formatPurchaseStatisticsDate("invalid"), "-");

console.log("Purchase statistics presentation semantics verified.");
