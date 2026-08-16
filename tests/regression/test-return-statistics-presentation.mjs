import assert from "node:assert/strict";
import {
  formatReturnAmount,
  formatReturnDelta,
  formatReturnDuration,
  formatReturnRate,
  formatReturnStatisticsDate,
  formatReturnStatisticsMonth,
} from "../../quickhack_client/components/statistics/return-statistics-presentation.ts";

assert.deepEqual(
  formatReturnRate({ value: 0, numerator: 0, denominator: 5 }),
  { value: "0%", detail: "0 / 5건" },
  "실제 0%는 자료 없음으로 표시하면 안 됩니다."
);
assert.equal(
  formatReturnRate(
    {
      value: null,
      numerator: 0,
      denominator: 0,
      unavailableReason: "아직 성숙한 판매 cohort가 없습니다.",
    },
    { maturityPending: true }
  ).value,
  "집계 중"
);
assert.equal(
  formatReturnRate({
    value: null,
    numerator: 0,
    denominator: 0,
  }).value,
  "-"
);

assert.equal(formatReturnDelta(null).value, "비교 불가");
assert.equal(formatReturnDelta(0).value, "0%p");
assert.equal(formatReturnDelta(2.5).value, "+2.5%p");
assert.equal(formatReturnDelta(-1.2).value, "-1.2%p");

assert.equal(
  formatReturnAmount({
    amount: null,
    pricedCount: 0,
    totalCount: 3,
    coveragePercent: 0,
  }).value,
  "-"
);
assert.equal(
  formatReturnAmount({
    amount: 0,
    pricedCount: 2,
    totalCount: 2,
    coveragePercent: 100,
  }).value,
  "₩0",
  "가격 표본이 있는 실제 0원은 자료 없음과 구분해야 합니다."
);

assert.equal(
  formatReturnDuration({
    sampleCount: 0,
    medianHours: null,
    p90Hours: null,
    excludedAnomalyCount: 0,
  }).value,
  "-"
);
assert.deepEqual(
  formatReturnDuration({
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

assert.equal(formatReturnStatisticsMonth("2026-07"), "2026년 7월");
assert.equal(formatReturnStatisticsMonth("unknown"), "unknown");
assert.match(
  formatReturnStatisticsDate("2026-07-27T00:00:00.000Z"),
  /2026.*7.*27.*오전 9:00/
);
assert.equal(formatReturnStatisticsDate(null), "-");
assert.equal(formatReturnStatisticsDate("invalid"), "-");

console.log("Return statistics presentation semantics verified.");
