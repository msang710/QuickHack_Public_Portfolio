import assert from "node:assert/strict";

const schedule = await import("@/quickhack_server/workers/schedule");

assert.equal(
  schedule.nextDailyKstRunAt(
    new Date("2026-07-29T18:29:59.000Z"),
    "03:30"
  ).toISOString(),
  "2026-07-29T18:30:00.000Z"
);
assert.equal(
  schedule.nextDailyKstRunAt(
    new Date("2026-07-29T18:30:00.000Z"),
    "03:30"
  ).toISOString(),
  "2026-07-30T18:30:00.000Z",
  "An exact schedule boundary must advance to the next day."
);
assert.equal(
  schedule.nextDailyKstRunAt(
    new Date("2026-01-31T18:30:01.000Z"),
    "03:30"
  ).toISOString(),
  "2026-02-01T18:30:00.000Z",
  "Daily schedules must cross month boundaries in KST."
);
assert.equal(
  schedule.nextDailyKstRunAt(
    new Date("2028-02-27T18:30:00.000Z"),
    "03:30"
  ).toISOString(),
  "2028-02-28T18:30:00.000Z",
  "Daily schedules must preserve leap-day calendar behavior."
);

const dailyWorker = {
  key: "daily",
  name: "Daily",
  type: "TEST",
  defaultIntervalSeconds: 17,
  dailyScheduleKstTime: "03:30",
  async run() {},
};
const intervalWorker = {
  key: "interval",
  name: "Interval",
  type: "TEST",
  defaultIntervalSeconds: 60,
  async run() {},
};
const manualWorker = {
  key: "manual",
  name: "Manual",
  type: "TEST",
  async run() {},
};
const deferredDailyWorker = {
  ...dailyWorker,
  key: "deferred-daily",
  dailyScheduleKstTime: "04:10",
  initialScheduleMode: "NEXT_SCHEDULE",
};

assert.equal(
  schedule.registeredWorkerIntervalSeconds(dailyWorker),
  86_400
);
assert.equal(
  schedule.registeredWorkerScheduleKind(dailyWorker),
  "DAILY_KST"
);
assert.equal(
  schedule.registeredWorkerScheduleLabel(dailyWorker),
  "매일 03:30 KST"
);
assert.equal(
  schedule.nextRegisteredWorkerRunAt(
    intervalWorker,
    new Date("2026-07-30T00:00:00.000Z")
  ).toISOString(),
  "2026-07-30T00:01:00.000Z"
);
assert.equal(
  schedule.registeredWorkerScheduleKind(manualWorker),
  "MANUAL"
);
assert.equal(
  schedule.nextRegisteredWorkerRunAt(
    manualWorker,
    new Date("2026-07-30T00:00:00.000Z")
  ),
  null
);
assert.equal(
  schedule.nextRegisteredWorkerRunAt(
    deferredDailyWorker,
    new Date("2026-07-30T18:00:00.000Z")
  ).toISOString(),
  "2026-07-30T19:10:00.000Z"
);
assert.throws(
  () =>
    schedule.nextDailyKstRunAt(
      new Date("2026-07-30T00:00:00.000Z"),
      "24:00"
    ),
  /Invalid worker daily KST schedule time/
);

console.log(
  "Worker daily KST schedule boundaries and interval compatibility verified."
);
