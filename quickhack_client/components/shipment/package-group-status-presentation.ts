import { SHIPMENT_PACKAGE_GROUP_STATUS } from "@/quickhack_shared/shipment/package-group";

const PACKAGE_GROUP_STATUS_CODES = new Set<string>(
  Object.values(SHIPMENT_PACKAGE_GROUP_STATUS)
);

export function packageGroupStatusLabel(
  status: string | null | undefined,
  translate: (key: never, values?: never) => string
) {
  const normalized = status ?? "";
  return PACKAGE_GROUP_STATUS_CODES.has(normalized)
    ? translate(normalized as never)
    : translate("unknown" as never, { code: normalized || "-" } as never);
}
