const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

function validDateParts(year: number, month: number, day: number) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

export function strictOptionalDatabaseDate(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "0000-00-00") return null;
  const match = normalized.match(DATE_PATTERN);
  if (!match) throw new TypeError("Expected YYYY-MM-DD.");
  const [year, month, day] = match.slice(1).map(Number);
  if (!validDateParts(year, month, day)) {
    throw new TypeError("Expected a real calendar date.");
  }
  return new Date(`${normalized}T00:00:00.000Z`);
}

export function strictOptionalKstDateTime(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const match = normalized.match(DATE_TIME_PATTERN);
  if (!match) throw new TypeError("Expected YYYY-MM-DD HH:mm:ss.");
  const [year, month, day, hour, minute, second = 0] = match.slice(1).map(Number);
  if (
    !validDateParts(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new TypeError("Expected a real KST date-time.");
  }
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${String(second).padStart(2, "0")}+09:00`;
  const parsed = new Date(canonical);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("Expected a real KST date-time.");
  return parsed;
}
