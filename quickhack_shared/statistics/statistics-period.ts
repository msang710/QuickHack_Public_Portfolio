import {
  formatKstDate,
  parseKstSqlDateTime,
} from "@/quickhack_shared/core/time";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STATISTICS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_STATISTICS_LOOKBACK_DAYS = 90;

export type StatisticsDateRange = {
  fromDate: string;
  toDate: string;
};

export type StatisticsDateTimeBounds = {
  fromInclusive: Date;
  toExclusive: Date;
};

export type StatisticsPeriodContext = {
  range: StatisticsDateRange;
  previousRange: StatisticsDateRange;
  dataCutoffDate: string;
  dayCount: number;
  isDefault: boolean;
};

export type StatisticsPeriodSelection =
  | { kind: "default" }
  | {
      kind: "custom";
      fromDate: string;
      toDate: string;
    };

export const DEFAULT_STATISTICS_PERIOD_SELECTION: StatisticsPeriodSelection =
  {
    kind: "default",
  };

export type StatisticsPeriodErrorCode =
  | "STATISTICS_PERIOD_INVALID_DATE"
  | "STATISTICS_PERIOD_INCOMPLETE_RANGE"
  | "STATISTICS_PERIOD_REVERSED_RANGE"
  | "STATISTICS_PERIOD_OPEN_DATE_NOT_ALLOWED";

export class StatisticsPeriodError extends Error {
  readonly code: StatisticsPeriodErrorCode;

  constructor(code: StatisticsPeriodErrorCode, message: string) {
    super(message);
    this.name = "StatisticsPeriodError";
    this.code = code;
  }
}

export function statisticsPeriodErrorCode(error: unknown) {
  return error instanceof StatisticsPeriodError
    ? error.code
    : null;
}

function parseStatisticsDate(value: string) {
  if (!STATISTICS_DATE_PATTERN.test(value)) {
    return null;
  }

  const parsed = parseKstSqlDateTime(`${value} 00:00:00`);

  if (!parsed || formatKstDate(parsed) !== value) {
    return null;
  }

  return parsed;
}

export function normalizeStatisticsDate(
  value: unknown,
  fieldName = "date"
) {
  const normalized = String(value ?? "").trim();

  if (!parseStatisticsDate(normalized)) {
    throw new StatisticsPeriodError(
      "STATISTICS_PERIOD_INVALID_DATE",
      `${fieldName} must be a valid YYYY-MM-DD date.`
    );
  }

  return normalized;
}

export function addKstCalendarDays(date: string, days: number) {
  const parsed = parseStatisticsDate(date);

  if (!parsed) {
    throw new StatisticsPeriodError(
      "STATISTICS_PERIOD_INVALID_DATE",
      "date must be a valid YYYY-MM-DD date."
    );
  }

  if (!Number.isInteger(days)) {
    throw new TypeError("days must be an integer.");
  }

  return formatKstDate(new Date(parsed.getTime() + days * MS_PER_DAY));
}

export function statisticsDateRangeDayCount(range: StatisticsDateRange) {
  const fromDate = normalizeStatisticsDate(range.fromDate, "fromDate");
  const toDate = normalizeStatisticsDate(range.toDate, "toDate");

  if (fromDate > toDate) {
    throw new StatisticsPeriodError(
      "STATISTICS_PERIOD_REVERSED_RANGE",
      "fromDate must be on or before toDate."
    );
  }

  const fromMs = parseStatisticsDate(fromDate)?.getTime() ?? Number.NaN;
  const toMs = parseStatisticsDate(toDate)?.getTime() ?? Number.NaN;

  return Math.floor((toMs - fromMs) / MS_PER_DAY) + 1;
}

export function previousEqualStatisticsDateRange(
  range: StatisticsDateRange
): StatisticsDateRange {
  const dayCount = statisticsDateRangeDayCount(range);
  const toDate = addKstCalendarDays(range.fromDate, -1);

  return {
    fromDate: addKstCalendarDays(toDate, -(dayCount - 1)),
    toDate,
  };
}

export function statisticsDateTimeBounds(
  range: StatisticsDateRange
): StatisticsDateTimeBounds {
  statisticsDateRangeDayCount(range);
  const fromInclusive = parseStatisticsDate(range.fromDate);
  const toExclusive = parseStatisticsDate(
    addKstCalendarDays(range.toDate, 1)
  );

  if (!fromInclusive || !toExclusive) {
    throw new StatisticsPeriodError(
      "STATISTICS_PERIOD_INVALID_DATE",
      "Statistics range contains an invalid date."
    );
  }

  return {
    fromInclusive,
    toExclusive,
  };
}

export function resolveClosedStatisticsPeriod(input: {
  now?: Date;
  fromDate?: unknown;
  toDate?: unknown;
} = {}): StatisticsPeriodContext {
  const now = input.now ?? new Date();
  const today = formatKstDate(now);
  const dataCutoffDate = addKstCalendarDays(today, -1);
  const hasFromDate =
    input.fromDate !== undefined &&
    input.fromDate !== null &&
    String(input.fromDate).trim() !== "";
  const hasToDate =
    input.toDate !== undefined &&
    input.toDate !== null &&
    String(input.toDate).trim() !== "";

  if (hasFromDate !== hasToDate) {
    throw new StatisticsPeriodError(
      "STATISTICS_PERIOD_INCOMPLETE_RANGE",
      "fromDate and toDate must be provided together."
    );
  }

  const isDefault = !hasFromDate;
  const toDate = isDefault
    ? dataCutoffDate
    : normalizeStatisticsDate(input.toDate, "toDate");
  const fromDate = isDefault
    ? addKstCalendarDays(
        toDate,
        -(DEFAULT_STATISTICS_LOOKBACK_DAYS - 1)
      )
    : normalizeStatisticsDate(input.fromDate, "fromDate");

  if (fromDate > toDate) {
    throw new StatisticsPeriodError(
      "STATISTICS_PERIOD_REVERSED_RANGE",
      "fromDate must be on or before toDate."
    );
  }

  if (toDate > dataCutoffDate) {
    throw new StatisticsPeriodError(
      "STATISTICS_PERIOD_OPEN_DATE_NOT_ALLOWED",
      "toDate must not be later than yesterday in Asia/Seoul."
    );
  }

  const range = { fromDate, toDate };

  return {
    range,
    previousRange: previousEqualStatisticsDateRange(range),
    dataCutoffDate,
    dayCount: statisticsDateRangeDayCount(range),
    isDefault,
  };
}

export function resolveStatisticsPeriodSelection(
  selection: StatisticsPeriodSelection,
  now?: Date
) {
  return selection.kind === "custom"
    ? resolveClosedStatisticsPeriod({
        now,
        fromDate: selection.fromDate,
        toDate: selection.toDate,
      })
    : resolveClosedStatisticsPeriod({ now });
}

export function statisticsPeriodSelectionKey(
  selection: StatisticsPeriodSelection
) {
  return selection.kind === "custom"
    ? `custom:${selection.fromDate}:${selection.toDate}`
    : "default";
}

export function appendStatisticsPeriodSearchParams(
  params: URLSearchParams,
  selection: StatisticsPeriodSelection
) {
  if (selection.kind === "custom") {
    params.set("fromDate", selection.fromDate);
    params.set("toDate", selection.toDate);
  }

  return params;
}

export function buildStatisticsPeriodRequestQuery(
  selection: StatisticsPeriodSelection
) {
  const params = new URLSearchParams();

  appendStatisticsPeriodSearchParams(params, selection);

  return params.toString();
}
