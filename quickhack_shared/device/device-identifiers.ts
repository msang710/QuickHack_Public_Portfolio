const IMEI_PATTERN = /^\d{15}$/;

export function normalizeOptionalImei(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!IMEI_PATTERN.test(normalized)) {
    throw new TypeError("IMEI는 숫자 15자리 형식이어야 합니다.");
  }
  return normalized;
}
