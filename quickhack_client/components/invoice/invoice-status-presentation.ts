const INVOICE_OPERATION_STATUS_CODES = new Set([
  "ALLOCATED", "PRINTED", "REGISTERED", "FAILED", "REPLACED", "VOID_LOCAL",
  "PENDING", "PREPARED", "SUBMITTING", "RECONCILING", "BLOCKED",
  "REVIEW_REQUIRED", "SENDING", "VERIFYING", "LOCAL_PENDING", "COMPLETED",
  "PARTIALLY_COMPLETED", "NOT_APPLIED", "REJECTED", "NOT_PRINTED",
  "SPOOLED", "PARTIAL", "CONFIRMED", "UNKNOWN",
]);

export function invoiceOperationStatusLabel(
  value: string | null | undefined,
  fallback: string,
  translate: (key: never, values?: never) => string
) {
  if (!value) return fallback;
  return INVOICE_OPERATION_STATUS_CODES.has(value)
    ? translate(`statusCode.${value}` as never)
    : translate("statusCode.unrecognized" as never, { code: value } as never);
}
