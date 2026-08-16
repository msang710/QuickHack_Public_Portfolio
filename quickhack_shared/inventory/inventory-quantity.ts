import type { LatestInboundDeviceDto } from "@/quickhack_shared/inbound/inbound-reconciliation";

export type InventoryQuantityBalanceDto = {
  balanceId: number;
  inventorySkuId: number;
  skuCode: string;
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
  inventoryStatus: string;
  quantity: number;
  version: number;
  skuActive: boolean;
  lastMovementAt: string | null;
  updatedAt: string;
};

export type InventoryQuantityMovementDto = {
  movementId: number;
  balanceId: number;
  inventorySkuId: number;
  skuCode: string;
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
  inventoryStatus: string;
  pgNo: string | null;
  movementType: string;
  quantityDelta: number;
  beforeQuantity: number;
  afterQuantity: number;
  sourceType: string;
  sourceId: string | null;
  reason: string | null;
  actorUserId: number | null;
  actorName: string | null;
  workerJobId: number | null;
  occurredAt: string;
};

export type InventoryLedgerAvailability =
  | "READY"
  | "EMPTY"
  | "PARTIAL";

export type InventoryQuantityMatrixCellDto = {
  balanceId: number | null;
  inventoryStatus: string;
  quantity: number | null;
  version: number | null;
  lastMovementAt: string | null;
  updatedAt: string | null;
};

export type InventoryQuantityPrePurchaseDto = {
  inspectingQuantity: number;
  inspectedQuantity: number;
  devices: LatestInboundDeviceDto[];
};

export type InventoryQuantityMatrixRowDto = {
  rowKind: "SKU" | "UNCLASSIFIED_INBOUND";
  rowKey: string;
  inventorySkuId: number | null;
  skuCode: string | null;
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
  skuActive: boolean | null;
  cells: InventoryQuantityMatrixCellDto[];
  prePurchase: InventoryQuantityPrePurchaseDto;
};

export type InventoryQuantityMatrixSummaryDto = {
  skuCount: number;
  unclassifiedRowCount: number;
  sellableQuantity: number | null;
  todayOrderQuantity: number | null;
  prePurchaseQuantity: number;
  ledgerTotalQuantity: number | null;
  primaryTotalQuantity: number | null;
};

export type InventoryQuantityReconciliationOverviewDto = {
  businessDate: string;
  unassignedPgQuantity: number;
  mismatchedBatchQuantity: number;
  shortageQuantity: number;
  excessQuantity: number;
};

export type InventoryQuantityMatrixPayload = {
  availability: InventoryLedgerAvailability;
  summary: InventoryQuantityMatrixSummaryDto;
  rows: InventoryQuantityMatrixRowDto[];
  reconciliation: InventoryQuantityReconciliationOverviewDto;
};

export type InventoryQuantityMovementPageDto = {
  balance: InventoryQuantityBalanceDto;
  items: InventoryQuantityMovementDto[];
  nextCursor: number | null;
};
