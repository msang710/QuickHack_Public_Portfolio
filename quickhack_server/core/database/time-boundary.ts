import {
  formatApiDate,
  formatApiKstDateTime,
  parseKstSqlDateTime,
  quickHackClock,
  type DateTimeInput,
} from "@/quickhack_shared/core/time";

export type DatabaseDateTime = Date;

export function databaseNow() {
  return quickHackClock.nowDate();
}

export function databaseDateTime(value: DateTimeInput) {
  const parsed = parseKstSqlDateTime(value);
  if (!parsed) {
    throw new TypeError("Expected a valid database timestamp input.");
  }
  return parsed;
}

export function databaseDateTimeOrNull(value: DateTimeInput) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  return databaseDateTime(value);
}

export function databaseDate(value: DateTimeInput) {
  const text = typeof value === "string" ? value.trim() : "";
  const dateText = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? text
    : formatApiDate(value);
  if (!dateText) {
    throw new TypeError("Expected a valid database date input.");
  }
  return new Date(`${dateText}T00:00:00.000Z`);
}

export function apiDateTime(value: DateTimeInput) {
  return formatApiKstDateTime(value);
}

export function requiredApiDateTime(value: DateTimeInput) {
  const formatted = apiDateTime(value);

  if (!formatted) {
    throw new TypeError("Expected a valid database timestamp.");
  }

  return formatted;
}

export function apiDate(value: DateTimeInput) {
  return formatApiDate(value);
}

export function requiredApiDate(value: DateTimeInput) {
  const formatted = apiDate(value);

  if (!formatted) {
    throw new TypeError("Expected a valid database date.");
  }

  return formatted;
}

export function dateTimeEpoch(value: DateTimeInput) {
  return parseKstSqlDateTime(value)?.getTime() ?? Number.NaN;
}

export function compareDateTimes(left: DateTimeInput, right: DateTimeInput) {
  return dateTimeEpoch(left) - dateTimeEpoch(right);
}
