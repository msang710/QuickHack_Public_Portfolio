export const SHIPMENT_PACKAGE_GROUP_STATUS = {
  draft: "DRAFT",
  frozen: "FROZEN",
  ready: "READY",
  onHold: "ON_HOLD",
  invalidated: "INVALIDATED",
  split: "SPLIT",
  canceled: "CANCELED",
  completed: "COMPLETED",
} as const;

export type ShipmentPackageGroupStatus =
  (typeof SHIPMENT_PACKAGE_GROUP_STATUS)[keyof typeof SHIPMENT_PACKAGE_GROUP_STATUS];

export const ACTIVE_SHIPMENT_PACKAGE_GROUP_STATUSES = [
  SHIPMENT_PACKAGE_GROUP_STATUS.draft,
  SHIPMENT_PACKAGE_GROUP_STATUS.frozen,
  SHIPMENT_PACKAGE_GROUP_STATUS.ready,
  SHIPMENT_PACKAGE_GROUP_STATUS.onHold,
] as const;

export function normalizeShipmentPackageGroupText(
  value: string | null | undefined
) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text === "-" ? "" : text;
}

export function shipmentPackageCandidateKey(input: {
  receiverName?: string | null;
  receiverAddress?: string | null;
  fallbackKey: string | number;
}) {
  const receiverName = normalizeShipmentPackageGroupText(input.receiverName);
  const receiverAddress = normalizeShipmentPackageGroupText(
    input.receiverAddress
  );

  return receiverName && receiverAddress
    ? `${receiverName}\n${receiverAddress}`
    : `fallback:${String(input.fallbackKey)}`;
}

export function shipmentPackageGroupRows<T>(
  rows: T[],
  keyOf: (row: T) => string
) {
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const key = keyOf(row);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }

  return groups;
}

export function firstShipmentPackageGroupRows<T>(
  rows: T[],
  keyOf: (row: T) => string,
  limit: number
) {
  const firstRows: T[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const key = keyOf(row);

    if (seen.has(key)) continue;
    seen.add(key);
    firstRows.push(row);

    if (firstRows.length >= limit) break;
  }

  return firstRows;
}
