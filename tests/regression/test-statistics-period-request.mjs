import assert from "node:assert/strict";
import {
  liveStatisticsCalculationMetadata,
  resolveStatisticsPeriodRequest,
  statisticsPeriodErrorCode,
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

for (const [input, expectedCode] of [
  [
    { fromDate: "2026-07-01" },
    "STATISTICS_PERIOD_INCOMPLETE_RANGE",
  ],
  [
    { fromDate: "2026-07-00", toDate: "2026-07-20" },
    "STATISTICS_PERIOD_INVALID_DATE",
  ],
  [
    { fromDate: "2026-07-20", toDate: "2026-07-01" },
    "STATISTICS_PERIOD_REVERSED_RANGE",
  ],
  [
    { fromDate: "2026-07-01", toDate: "2026-07-29" },
    "STATISTICS_PERIOD_OPEN_DATE_NOT_ALLOWED",
  ],
]) {
  assert.throws(
    () => resolveStatisticsPeriodRequest({ now: NOW, ...input }),
    (error) => statisticsPeriodErrorCode(error) === expectedCode
  );
}

assert.equal(statisticsPeriodErrorCode(new Error("unexpected")), null);
assert.equal(
  statisticsSearchUnsupportedMessage(new URLSearchParams()),
  null
);
for (const queryString of ["q=", "q=SKU", "q=%20"]) {
  assert.equal(
    statisticsSearchUnsupportedMessage(new URLSearchParams(queryString)),
    "STATISTICS_SEARCH_UNSUPPORTED"
  );
}

console.log(
  "Statistics period request, unsupported-search, error mapping, and LIVE metadata contracts verified."
);
