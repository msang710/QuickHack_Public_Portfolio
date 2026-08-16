const COUPANG_EXTERNAL_RESPONSE_CODE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

export function safeCoupangExternalResponseCode(value: unknown) {
  if (
    value === null ||
    value === undefined ||
    (typeof value !== "string" && typeof value !== "number")
  ) {
    return null;
  }

  const normalized = String(value).trim();
  return COUPANG_EXTERNAL_RESPONSE_CODE_PATTERN.test(normalized)
    ? normalized
    : null;
}
