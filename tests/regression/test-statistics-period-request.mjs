import assert from "node:assert/strict";
import {
  liveStatisticsCalculationMetadata,
  resolveStatisticsPeriodRequest,
  statisticsPeriodErrorMessage,
  statisticsSearchUnsupportedMessage,
} from "../../quickhack_server/statistics/statistics-period-request.ts";

const NOW = new Date("2026-07-29T03:00:00.000Z");
const defaultPeriod = resolveStatisticsPeriodRequest({ now: NOW });

assert.deepEqual(defaultPeriod.range, {
  fromDate: "2026-04-30",
  toDate: "2026-07-28",
});
assert.deepEqual(liveStatisticsCalculationMetadata(defaultPeriod), {
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

const direct = resolveStatisticsPeriodRequest({
  now: NOW,
  fromDate: "2026-07-01",
  toDate: "2026-07-20",
});
assert.equal(direct.isDefault, false);
assert.equal(direct.dayCount, 20);

for (const [input, expectedMessage] of [
  [
    { fromDate: "2026-07-01" },
    "통계 시작일과 종료일을 함께 입력해야 합니다.",
  ],
  [
    { fromDate: "2026-07-00", toDate: "2026-07-20" },
    "통계 기간은 YYYY-MM-DD 형식의 올바른 날짜여야 합니다.",
  ],
  [
    { fromDate: "2026-07-20", toDate: "2026-07-01" },
    "통계 시작일은 종료일보다 늦을 수 없습니다.",
  ],
  [
    { fromDate: "2026-07-01", toDate: "2026-07-29" },
    "통계 종료일은 한국 시간 기준 어제까지만 지정할 수 있습니다.",
  ],
]) {
  assert.throws(
    () => resolveStatisticsPeriodRequest({ now: NOW, ...input }),
    (error) => statisticsPeriodErrorMessage(error) === expectedMessage
  );
}

assert.equal(statisticsPeriodErrorMessage(new Error("unexpected")), null);
assert.equal(
  statisticsSearchUnsupportedMessage(new URLSearchParams()),
  null
);
for (const queryString of ["q=", "q=SKU", "q=%20"]) {
  assert.match(
    statisticsSearchUnsupportedMessage(
      new URLSearchParams(queryString)
    ),
    /통계 검색은 지원하지 않습니다/
  );
}

console.log(
  "Statistics period request, unsupported-search, error mapping, and LIVE metadata contracts verified."
);
