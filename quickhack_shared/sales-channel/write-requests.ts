export const SALES_CHANNEL_WRITE_REQUEST_TYPE = {
  orderStatusInstruct: "ORDER_STATUS_INSTRUCT",
  coupangInvoiceUpload: "COUPANG_INVOICE_UPLOAD",
  coupangInvoiceUpdate: "COUPANG_INVOICE_UPDATE",
  returnStoppedShipment: "RETURN_STOPPED_SHIPMENT",
  returnReceiveConfirmation: "RETURN_RECEIVE_CONFIRMATION",
  returnApproval: "RETURN_APPROVAL",
  coupangInventoryQuantityUpdate: "COUPANG_INVENTORY_QUANTITY_UPDATE",
} as const;

export type SalesChannelWriteRequestType =
  (typeof SALES_CHANNEL_WRITE_REQUEST_TYPE)[keyof typeof SALES_CHANNEL_WRITE_REQUEST_TYPE];

export const SALES_CHANNEL_WRITE_REQUEST_STATUS = {
  pending: "PENDING",
  sending: "SENDING",
  verifying: "VERIFYING",
  localPending: "LOCAL_PENDING",
  completed: "COMPLETED",
  partiallyCompleted: "PARTIALLY_COMPLETED",
  reviewRequired: "REVIEW_REQUIRED",
  notApplied: "NOT_APPLIED",
  rejected: "REJECTED",
} as const;

export type SalesChannelWriteRequestStatus =
  (typeof SALES_CHANNEL_WRITE_REQUEST_STATUS)[keyof typeof SALES_CHANNEL_WRITE_REQUEST_STATUS];

export const SALES_CHANNEL_WRITE_FAILURE_STAGE = {
  writeTransport: "WRITE_TRANSPORT",
  writeResponse: "WRITE_RESPONSE",
  externalVerification: "EXTERNAL_VERIFICATION",
  localFinalization: "LOCAL_FINALIZATION",
} as const;

export const SALES_CHANNEL_WRITE_ATTEMPT_TYPE = {
  write: "WRITE",
  verifyRead: "VERIFY_READ",
  localFinalize: "LOCAL_FINALIZE",
} as const;

export const SALES_CHANNEL_WRITE_ATTEMPT_STATUS = {
  sending: "SENDING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  ambiguous: "AMBIGUOUS",
} as const;

export const SALES_CHANNEL_WRITE_MANUAL_VERIFICATION = {
  channelApplied: "CHANNEL_APPLIED",
  channelNotApplied: "CHANNEL_NOT_APPLIED",
  undecidable: "UNDECIDABLE",
} as const;

export const SALES_CHANNEL_WRITE_REVIEW_STATUSES = [
  SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
  SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
] as const;

export const SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS = {
  pending: "PENDING",
  succeeded: "SUCCEEDED",
  notApplied: "NOT_APPLIED",
  unknown: "UNKNOWN",
} as const;

export type SalesChannelWriteTargetExternalStatus =
  (typeof SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS)[keyof typeof SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS];

export const SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS = {
  pending: "PENDING",
  succeeded: "SUCCEEDED",
  notRequired: "NOT_REQUIRED",
  failed: "FAILED",
} as const;

export type SalesChannelWriteTargetLocalStatus =
  (typeof SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS)[keyof typeof SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS];

export type SalesChannelWriteTargetInput = {
  targetType: string;
  targetExternalId?: string | null;
  allocationId?: number | null;
  pgNo?: string | null;
  externalOrderId?: string | null;
  externalShipmentId?: string | null;
  externalVendorItemId?: string | null;
  packageGroupId?: number | null;
  carrierShipmentId?: number | null;
  deliveryCompanyCode?: string | null;
  invoiceNumberSnapshot?: string | null;
  splitShipping?: boolean | null;
  preSplitShipped?: boolean | null;
  estimatedShippingDate?: string | null;
  supplyConsumptionEventId?: number | null;
  quantity?: number | null;
  inventoryVerificationStateId?: number | null;
  inventoryDesiredVersionSnapshot?: number | null;
  inventoryMismatchSinceSnapshot?: string | null;
  inventoryProjectionBasisHashSnapshot?: string | null;
  inventoryLedgerQuantitySnapshot?: number | null;
  inventoryPendingOrderQuantitySnapshot?: number | null;
  inventoryExpectedChannelQuantitySnapshot?: number | null;
  inventoryObservedChannelQuantitySnapshot?: number | null;
  expectedBeforeStatus?: string | null;
  requestedAfterStatus?: string | null;
  inspectionResult?: string | null;
  appearanceGrade?: string | null;
  appearanceDefect?: string | null;
  functionDefect?: string | null;
  inspectionNote?: string | null;
};

type SalesChannelWriteCommandBase = {
  channel: "COUPANG";
  idempotencyKey: string;
  externalOrderId?: string | null;
  allocationId?: number | null;
  pgNo?: string | null;
  targetType?: string | null;
  targetExternalId?: string | null;
  packageGroupId?: number | null;
  carrierShipmentId?: number | null;
  cancelCount?: number | null;
  expectedBeforeStatus?: string | null;
  requestedAfterStatus?: string | null;
  sourceMenuKey: string;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceProjectionRevision?: number | null;
  sourceSnapshotDigest?: string | null;
  requestedByUserId?: number | null;
  workerJobId?: number | null;
  targets: SalesChannelWriteTargetInput[];
};

export type SalesChannelWriteCommand =
  | (SalesChannelWriteCommandBase & {
      requestType: "ORDER_STATUS_INSTRUCT";
      shipmentBoxIds: string[];
    })
  | (SalesChannelWriteCommandBase & {
      requestType: "COUPANG_INVOICE_UPLOAD";
      invoiceItems: Array<{
        shipmentBoxId: string;
        orderId: string;
        vendorItemId: string;
        deliveryCompanyCode: string;
        invoiceNumber: string;
        splitShipping: false;
        preSplitShipped: false;
        estimatedShippingDate: "";
      }>;
    })
  | (SalesChannelWriteCommandBase & {
      requestType: "COUPANG_INVOICE_UPDATE";
      invoiceItems: Array<{
        shipmentBoxId: string;
        orderId: string;
        vendorItemId: string;
        deliveryCompanyCode: string;
        invoiceNumber: string;
        splitShipping: false;
        preSplitShipped: false;
        estimatedShippingDate: "";
      }>;
    })
  | (SalesChannelWriteCommandBase & {
      requestType: "RETURN_STOPPED_SHIPMENT";
      receiptId: string;
      cancelCount: number;
    })
  | (SalesChannelWriteCommandBase & {
      requestType: "RETURN_RECEIVE_CONFIRMATION";
      receiptId: string;
    })
  | (SalesChannelWriteCommandBase & {
      requestType: "RETURN_APPROVAL";
      receiptId: string;
      cancelCount: number;
    })
  | (SalesChannelWriteCommandBase & {
      requestType: "COUPANG_INVENTORY_QUANTITY_UPDATE";
      verificationStateId: number;
      vendorItemId: string;
      desiredVersion: number;
      mismatchSince: string;
      projectionBasisHash: string;
      ledgerQuantity: number;
      pendingOrderQuantity: number;
      expectedChannelQuantity: number;
      observedChannelQuantity: number;
    });
