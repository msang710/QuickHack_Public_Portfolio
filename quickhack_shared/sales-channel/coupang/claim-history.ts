// QuickHack contract: normalized, PII-minimized Coupang claim history snapshots.

export const COUPANG_CLAIM_SOURCE_TABLE = {
  returns: "coupang_return_raw",
  exchanges: "coupang_exchange_raw",
} as const;

export const COUPANG_CLAIM_EVENT_TYPE = {
  returnObserved: "COUPANG_RETURN_OBSERVED",
  returnChanged: "COUPANG_RETURN_CHANGED",
  returnWithdrawn: "COUPANG_RETURN_WITHDRAWN",
  exchangeObserved: "COUPANG_EXCHANGE_OBSERVED",
  exchangeChanged: "COUPANG_EXCHANGE_CHANGED",
} as const;

export const COUPANG_RETURN_HISTORY_FIELDS = [
  "external_created_at",
  "external_modified_at",
  "external_completed_at",
  "external_completion_type",
  "receipt_type",
  "receipt_status",
  "release_status",
  "fault_by_type",
  "reason_code",
  "reason_label",
  "reason_category",
  "reason_detail",
  "cancel_count",
  "items_json",
] as const;

export const COUPANG_EXCHANGE_HISTORY_FIELDS = [
  "external_created_at",
  "external_modified_at",
  "exchange_status",
  "fault_by_type",
  "reason_code",
  "reason_label",
  "reason_detail",
] as const;

export const COUPANG_RETURN_WITHDRAWAL_FIELDS = [
  "external_withdrawn_at",
  "refund_delivery_duty",
  "vendor_item_ids",
] as const;

export type CoupangReturnHistoryField =
  (typeof COUPANG_RETURN_HISTORY_FIELDS)[number];
export type CoupangExchangeHistoryField =
  (typeof COUPANG_EXCHANGE_HISTORY_FIELDS)[number];
export type CoupangReturnWithdrawalField =
  (typeof COUPANG_RETURN_WITHDRAWAL_FIELDS)[number];
export type CoupangClaimHistoryField =
  | CoupangReturnHistoryField
  | CoupangExchangeHistoryField
  | CoupangReturnWithdrawalField;

export type CoupangReturnHistorySnapshot = Record<
  CoupangReturnHistoryField,
  string | null
>;
export type CoupangExchangeHistorySnapshot = Record<
  CoupangExchangeHistoryField,
  string | null
>;
export type CoupangReturnWithdrawalSnapshot = Record<
  CoupangReturnWithdrawalField,
  string | null
>;
export type CoupangClaimHistorySnapshot =
  | CoupangReturnHistorySnapshot
  | CoupangExchangeHistorySnapshot
  | CoupangReturnWithdrawalSnapshot;

export type NormalizedExternalTimestamp = {
  value: string | null;
  invalid: boolean;
};

const CLAIM_REASON_DETAIL_MAX_LENGTH = 500;
const KNOWN_FAULT_TYPES = new Set([
  "VENDOR",
  "CUSTOMER",
  "COUPANG",
  "WMS",
  "GENERAL",
]);
const PHONE_PATTERN =
  /(?<!\d)(?:01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}|0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4})(?!\d)/g;
const EMAIL_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function nullableText(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function unknownCode(value: string) {
  return `UNKNOWN:${value}`;
}

export function normalizeExternalClaimTimestamp(
  value: unknown
): NormalizedExternalTimestamp {
  const text = nullableText(value);

  if (!text) {
    return { value: null, invalid: false };
  }

  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(text);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const isLocalDateTime =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text);
  const candidate = hasTimezone
    ? text
    : isDateOnly
      ? `${text}T00:00:00+09:00`
      : isLocalDateTime
        ? `${text}+09:00`
        : text;
  const parsed = new Date(candidate);

  if (!Number.isFinite(parsed.getTime())) {
    return { value: null, invalid: true };
  }

  return { value: parsed.toISOString(), invalid: false };
}

export function normalizeCoupangReceiptType(value: unknown) {
  const text = nullableText(value)?.toUpperCase() ?? null;

  if (!text) {
    return null;
  }

  return text === "RETURN" || text === "CANCEL" ? text : unknownCode(text);
}

export function normalizeCoupangClaimFault(value: unknown) {
  const text = nullableText(value)?.toUpperCase() ?? null;

  if (!text) {
    return null;
  }

  return KNOWN_FAULT_TYPES.has(text) ? text : unknownCode(text);
}

export function normalizeCoupangRefundDeliveryDuty(value: unknown) {
  const text = nullableText(value)?.toUpperCase() ?? null;

  if (!text) {
    return null;
  }

  if (text === "COM") return "VENDOR";
  if (text === "CUS") return "CUSTOMER";
  if (text === "COU") return "COUPANG";
  return unknownCode(text);
}

export function normalizeCoupangClaimReasonDetail(value: unknown) {
  const text = nullableText(value);

  if (!text) {
    return null;
  }

  return text
    .normalize("NFKC")
    .replace(EMAIL_PATTERN, "[EMAIL]")
    .replace(PHONE_PATTERN, "[PHONE]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CLAIM_REASON_DETAIL_MAX_LENGTH);
}

export function normalizeCoupangWithdrawalVendorItemIds(value: unknown) {
  const values = Array.isArray(value) ? value : [];
  const normalized = Array.from(
    new Set(
      values
        .map(nullableText)
        .filter((item): item is string => Boolean(item))
    )
  ).sort((left, right) =>
    left.localeCompare(right, "en", { numeric: true })
  );

  return JSON.stringify(normalized);
}
