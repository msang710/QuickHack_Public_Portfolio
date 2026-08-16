export type LatestInboundDeviceDto = {
  inboundId: number;
  pgNo: string;
  inboundBatchId: number | null;
  inboundStatus: string;
  receivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  inventorySkuId: number | null;
  model: string;
  storage: string | null;
  color: string | null;
  saleGrade: string | null;
};

export type InboundBatchReconciliationDto = {
  inboundBatchId: number;
  batchDate: string;
  batchNo: number;
  expectedQuantity: number;
  note: string | null;
  linkedQuantity: number;
  supplierReturnQuantity: number;
  normalInboundTargetQuantity: number;
  arrivalDifference: number;
  shortageQuantity: number;
  excessQuantity: number;
  statusCounts: Record<string, number>;
  devices: LatestInboundDeviceDto[];
};

export type InboundBatchPlanRowDto = Omit<
  InboundBatchReconciliationDto,
  "inboundBatchId" | "statusCounts" | "devices"
> & {
  id: number;
  revision: number;
  historicalInboundQuantity: number;
};

export type InboundReconciliationSummaryDto = {
  businessDate: string;
  unassignedPgQuantity: number;
  mismatchedBatchQuantity: number;
  shortageQuantity: number;
  excessQuantity: number;
  unassignedDevices: LatestInboundDeviceDto[];
  batches: InboundBatchReconciliationDto[];
};

export const INBOUND_RECONCILIATION_DETAIL_SCOPES = [
  "UNASSIGNED",
  "MISMATCHED",
  "SHORTAGE",
  "EXCESS",
] as const;

export type InboundReconciliationDetailScope =
  (typeof INBOUND_RECONCILIATION_DETAIL_SCOPES)[number];

export type InboundReconciliationDetailDto = {
  businessDate: string;
  scope: InboundReconciliationDetailScope;
  scopeQuantity: number;
  devices: LatestInboundDeviceDto[];
  batches: InboundBatchReconciliationDto[];
};
