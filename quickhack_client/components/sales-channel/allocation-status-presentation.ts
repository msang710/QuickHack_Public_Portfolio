export const ALLOCATION_STATUS_CODES = [
  "ALLOCATED",
  "API_ACKED",
  "SHIPMENT_LIST_PRINTED",
  "CANCELED",
] as const;

export function allocationStatusLabel(
  status: string | null | undefined,
  translate: (key: never, values?: never) => string
) {
  const normalized = status ?? "";
  return (ALLOCATION_STATUS_CODES as readonly string[]).includes(normalized)
    ? translate(`allocationStatus.${normalized}` as never)
    : translate("allocationStatus.unknown" as never, {
        code: normalized || "-",
      } as never);
}
