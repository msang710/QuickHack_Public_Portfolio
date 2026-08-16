// QuickHack note: Central clock utilities for QuickHack business timestamps.
export const KST_TIME_ZONE = "Asia/Seoul";

export type KstDateTimeParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

export type KstDayRange = {
  date: string;
  from: string;
  to: string;
};

/**
 * PostgreSQL/Prisma returns native Date values while external integrations and
 * legacy API inputs still use textual timestamps. Keep the accepted boundary
 * explicit instead of coercing database values back to strings globally.
 */
export type DateTimeInput = Date | string | null | undefined;

function datePartsInTimeZone(date: Date, timeZone: string): KstDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: parts.year ?? "0000",
    month: parts.month ?? "00",
    day: parts.day ?? "00",
    hour: parts.hour ?? "00",
    minute: parts.minute ?? "00",
    second: parts.second ?? "00",
  };
}

export function kstDateTimeParts(date = new Date()) {
  return datePartsInTimeZone(date, KST_TIME_ZONE);
}

export function formatKstSqlDateTime(date = new Date()) {
  const parts = kstDateTimeParts(date);

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatKstDate(date = new Date()) {
  const parts = kstDateTimeParts(date);

  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function nowKstSqlDateTime(date = new Date()) {
  return formatKstSqlDateTime(date);
}

export function todayKstDate(date = new Date()) {
  return formatKstDate(date);
}

export function kstDayRange(date = new Date()): KstDayRange {
  const day = formatKstDate(date);

  return {
    date: day,
    from: `${day} 00:00:00`,
    to: `${day} 23:59:59`,
  };
}

export function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000);
}

export function parseKstSqlDateTime(value: DateTimeInput) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  const normalized = String(value ?? "").trim().replace(" ", "T");

  if (!normalized) {
    return null;
  }

  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = new Date(hasExplicitOffset ? normalized : `${normalized}+09:00`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatApiKstDateTime(value: DateTimeInput) {
  const parsed = parseKstSqlDateTime(value);

  return parsed ? formatKstSqlDateTime(parsed) : null;
}

export function formatApiDate(value: DateTimeInput) {
  const parsed = parseKstSqlDateTime(value);

  return parsed ? formatKstDate(parsed) : null;
}

export function formatKstFilenameTimestamp(date = new Date()) {
  const parts = kstDateTimeParts(date);

  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

export function formatUtcIsoDateTime(date = new Date()) {
  return date.toISOString();
}

export function monotonicMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

export const quickHackClock = {
  timeZone: KST_TIME_ZONE,
  nowDate() {
    return new Date();
  },
  nowEpochMs() {
    return Date.now();
  },
  monotonicMs,
  addSeconds,
  formatKstSqlDateTime,
  nowKstSqlDateTime,
  formatKstDate,
  todayKstDate,
  kstDateTimeParts,
  kstDayRange,
  parseKstSqlDateTime,
  formatApiKstDateTime,
  formatApiDate,
  formatKstFilenameTimestamp,
  formatUtcIsoDateTime,
} as const;
