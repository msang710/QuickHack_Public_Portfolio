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

export const SELLABLE_INVENTORY_STATUSES = new Set<string>([
  INVENTORY_STATUS.sellable,
]);
