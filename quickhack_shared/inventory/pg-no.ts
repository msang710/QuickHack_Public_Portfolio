const PG_NO_PATTERN = /^[A-Z]{2}\d{10}$/;

export function normalizePgNo(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function requireCanonicalPgNo(value: unknown) {
  const pgNo = normalizePgNo(value);
  if (!PG_NO_PATTERN.test(pgNo)) {
    throw new Error("PG는 알파벳 2자리 + 숫자 10자리 형식이어야 합니다.");
  }
  return pgNo;
}

export function compareCanonicalPgNo(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalPgNos(values: readonly unknown[]) {
  return [...new Set(values.map(requireCanonicalPgNo))].sort(
    compareCanonicalPgNo
  );
}
