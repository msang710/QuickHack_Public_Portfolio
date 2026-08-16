// QuickHack object: Actual stock states used after purchase confirmation.
export const INVENTORY_STATUS = {
  sellable: "SELLABLE",
  reserved: "RESERVED",
  packing: "PACKING",
  packed: "PACKED",
  departure: "DEPARTURE",
  delivering: "DELIVERING",
  finalDelivery: "FINAL_DELIVERY",
  noneTracking: "NONE_TRACKING",
  hold: "HOLD",
  defective: "DEFECTIVE",
  returnRequested: "RETURN_REQUESTED",
  exchangeRequested: "EXCHANGE_REQUESTED",
  returnCheck: "RETURN_CHECK",
} as const;

export type InventoryStatusCode =
  (typeof INVENTORY_STATUS)[keyof typeof INVENTORY_STATUS];

export const INVENTORY_STATUS_LABELS: Record<InventoryStatusCode, string> = {
  SELLABLE: "판매가능",
  RESERVED: "주문확인",
  PACKING: "포장중",
  PACKED: "포장완료",
  DEPARTURE: "배송지시",
  DELIVERING: "배송중",
  FINAL_DELIVERY: "배송완료",
  NONE_TRACKING: "추적불가",
  HOLD: "보류",
  DEFECTIVE: "불량",
  RETURN_REQUESTED: "반품요청",
  EXCHANGE_REQUESTED: "교환요청",
  RETURN_CHECK: "반품검수",
};

export const SELLABLE_INVENTORY_STATUSES = new Set<string>([
  INVENTORY_STATUS.sellable,
]);

export function inventoryStatusLabel(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  return INVENTORY_STATUS_LABELS[value as InventoryStatusCode] ?? value;
}
