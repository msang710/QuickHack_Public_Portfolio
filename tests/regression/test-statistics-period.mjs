import assert from "node:assert/strict";
import {
  DEFAULT_STATISTICS_LOOKBACK_DAYS,
  DEFAULT_STATISTICS_PERIOD_SELECTION,
  StatisticsPeriodError,
  addKstCalendarDays,
  appendStatisticsPeriodSearchParams,
  buildStatisticsPeriodRequestQuery,
  normalizeStatisticsDate,
  previousEqualStatisticsDateRange,
  resolveClosedStatisticsPeriod,
  resolveStatisticsPeriodSelection,
  statisticsDateRangeDayCount,
  statisticsDateTimeBounds,
  statisticsPeriodErrorCode,
  statisticsPeriodSelectionKey,
} from "../../quickhack_shared/statistics/statistics-period.ts";

const DEFAULT_NOW = new Date("2026-07-29T03:00:00.000Z");
const defaultPeriod = resolveClosedStatisticsPeriod({ now: DEFAULT_NOW });

assert.equal(DEFAULT_STATISTICS_LOOKBACK_DAYS, 90);
assert.deepEqual(defaultPeriod.range, {
  fromDate: "2026-04-30",
  toDate: "2026-07-28",
});
assert.equal(defaultPeriod.dayCount, 90);
assert.equal(defaultPeriod.dataCutoffDate, "2026-07-28");
assert.equal(defaultPeriod.isDefault, true);
assert.equal(
  statisticsDateRangeDayCount(defaultPeriod.previousRange),
  defaultPeriod.dayCount
);
assert.equal(defaultPeriod.previousRange.toDate, "2026-04-29");
assert.deepEqual(DEFAULT_STATISTICS_PERIOD_SELECTION, {
  kind: "default",
});
assert.equal(
  statisticsPeriodSelectionKey(DEFAULT_STATISTICS_PERIOD_SELECTION),
  "default"
);
assert.deepEqual(
  resolveStatisticsPeriodSelection(
    DEFAULT_STATISTICS_PERIOD_SELECTION,
    DEFAULT_NOW
  ),
  defaultPeriod
);

const customSelection = {
  kind: "custom",
  fromDate: "2026-07-01",
  toDate: "2026-07-28",
};
assert.equal(
  statisticsPeriodSelectionKey(customSelection),
  "custom:2026-07-01:2026-07-28"
);
assert.equal(
  buildStatisticsPeriodRequestQuery(customSelection),
  "fromDate=2026-07-01&toDate=2026-07-28"
);
assert.equal(
  buildStatisticsPeriodRequestQuery(DEFAULT_STATISTICS_PERIOD_SELECTION),
  ""
);
const customParams = appendStatisticsPeriodSearchParams(
  new URLSearchParams(),
  customSelection
);
assert.equal(customParams.has("q"), false);
assert.equal(customParams.get("fromDate"), "2026-07-01");
assert.equal(customParams.get("toDate"), "2026-07-28");

assert.deepEqual(
  resolveClosedStatisticsPeriod({
    now: DEFAULT_NOW,
    fromDate: "2026-07-01",
    toDate: "2026-07-28",
  }),
  {
    range: {
      fromDate: "2026-07-01",
      toDate: "2026-07-28",
    },
    previousRange: {
      fromDate: "2026-06-03",
      toDate: "2026-06-30",
    },
    dataCutoffDate: "2026-07-28",
    dayCount: 28,
    isDefault: false,
  }
);

assert.equal(addKstCalendarDays("2024-02-28", 1), "2024-02-29");
assert.equal(addKstCalendarDays("2024-02-29", 1), "2024-03-01");
assert.equal(addKstCalendarDays("2025-12-31", 1), "2026-01-01");
assert.equal(normalizeStatisticsDate("2026-01-09"), "2026-01-09");
assert.equal(
  statisticsDateRangeDayCount({
    fromDate: "2024-02-28",
    toDate: "2024-03-01",
  }),
  3
);

assert.deepEqual(
  previousEqualStatisticsDateRange({
    fromDate: "2026-07-01",
    toDate: "2026-07-10",
  }),
  {
    fromDate: "2026-06-21",
    toDate: "2026-06-30",
  }
);

const bounds = statisticsDateTimeBounds({
  fromDate: "2026-07-01",
  toDate: "2026-07-28",
});
assert.equal(bounds.fromInclusive.toISOString(), "2026-06-30T15:00:00.000Z");
assert.equal(bounds.toExclusive.toISOString(), "2026-07-28T15:00:00.000Z");

assert.deepEqual(
  resolveClosedStatisticsPeriod({
    now: new Date("2026-07-28T14:59:59.999Z"),
  }).range,
  {
    fromDate: "2026-04-29",
    toDate: "2026-07-27",
  }
);
assert.deepEqual(
  resolveClosedStatisticsPeriod({
    now: new Date("2026-07-28T15:00:00.000Z"),
  }).range,
  {
    fromDate: "2026-04-30",
    toDate: "2026-07-28",
  }
);

function assertPeriodError(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof StatisticsPeriodError);
    assert.equal(error.code, code);
    return true;
  });
}

assertPeriodError("STATISTICS_PERIOD_INVALID_DATE", () =>
  normalizeStatisticsDate("2026-02-30")
);
assertPeriodError("STATISTICS_PERIOD_INCOMPLETE_RANGE", () =>
  resolveClosedStatisticsPeriod({
    now: DEFAULT_NOW,
    fromDate: "2026-07-01",
  })
);
assertPeriodError("STATISTICS_PERIOD_REVERSED_RANGE", () =>
  resolveClosedStatisticsPeriod({
    now: DEFAULT_NOW,
    fromDate: "2026-07-20",
    toDate: "2026-07-10",
  })
);
assertPeriodError("STATISTICS_PERIOD_OPEN_DATE_NOT_ALLOWED", () =>
  resolveClosedStatisticsPeriod({
    now: DEFAULT_NOW,
    fromDate: "2026-07-01",
    toDate: "2026-07-29",
  })
);
assert.equal(
  statisticsPeriodErrorCode(
    new StatisticsPeriodError(
      "STATISTICS_PERIOD_REVERSED_RANGE",
      "test"
    )
  ),
  "STATISTICS_PERIOD_REVERSED_RANGE"
);
assert.equal(statisticsPeriodErrorCode(new Error("test")), null);

console.log("Statistics period contract checks passed.");
