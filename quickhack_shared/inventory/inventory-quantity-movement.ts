// QuickHack policy: append-only inventory quantity ledger movement types.
export const INVENTORY_QUANTITY_MOVEMENT_TYPE = {
  inventoryCreated: "INVENTORY_CREATED",
  statusTransfer: "STATUS_TRANSFER",
  skuReclassification: "SKU_RECLASSIFICATION",
  inventoryRemoved: "INVENTORY_REMOVED",
} as const;

export type InventoryQuantityMovementType =
  (typeof INVENTORY_QUANTITY_MOVEMENT_TYPE)[keyof typeof INVENTORY_QUANTITY_MOVEMENT_TYPE];
