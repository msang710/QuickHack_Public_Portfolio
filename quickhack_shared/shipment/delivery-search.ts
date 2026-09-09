export const SHIPMENT_DELIVERY_DATE_BASIS = {
  orderedAt: "ORDERED_AT",
  outboundConfirmedAt: "OUTBOUND_CONFIRMED_AT",
  invoiceAllocatedAt: "INVOICE_ALLOCATED_AT",
  carrierRegisteredAt: "CARRIER_REGISTERED_AT",
  trackingScannedAt: "TRACKING_SCANNED_AT",
} as const;

export type ShipmentDeliveryDateBasis =
  (typeof SHIPMENT_DELIVERY_DATE_BASIS)[keyof typeof SHIPMENT_DELIVERY_DATE_BASIS];

export const SHIPMENT_DELIVERY_STAGE = {
  preparing: "PREPARING",
  invoiceAllocated: "INVOICE_ALLOCATED",
  registered: "REGISTERED",
  inTransit: "IN_TRANSIT",
  delivered: "DELIVERED",
  onHold: "ON_HOLD",
  exception: "EXCEPTION",
  closed: "CLOSED",
} as const;

export type ShipmentDeliveryStage =
  (typeof SHIPMENT_DELIVERY_STAGE)[keyof typeof SHIPMENT_DELIVERY_STAGE];

export const SHIPMENT_PACKING_TYPE = {
  single: "SINGLE",
  combined: "COMBINED",
} as const;

export type ShipmentPackingType =
  (typeof SHIPMENT_PACKING_TYPE)[keyof typeof SHIPMENT_PACKING_TYPE];

export type ShipmentDeliveryLastActivitySource =
  | "TRACKING"
  | "CARRIER"
  | "CHANNEL"
  | "PACKAGE_GROUP";

export type ShipmentDeliverySearchRow = {
  packageGroupId: number;
  deliveryStage: ShipmentDeliveryStage;
  groupStatus: string;
  channelStatuses: string[];
  reviewRequired: boolean;
  reviewCount: number;
  carrierShipmentId: number | null;
  carrierCode: string | null;
  trackingNumber: string | null;
  revisionNo: number | null;
  reissued: boolean;
  representativeOrderId: string;
  orderCount: number;
  shipmentBoxCount: number;
  representativeProductName: string;
  memberCount: number;
  packingType: ShipmentPackingType;
  splitShipment: boolean;
  outboundBatchLabel: string | null;
  printLineNumbers: number[];
  receiverName: string;
  receiverPostCode: string | null;
  receiverRegion: string;
  latestTrackingStatus: string | null;
  latestBranchName: string | null;
  latestTrackingAt: string | null;
  lastActivityAt: string;
  lastActivitySource: ShipmentDeliveryLastActivitySource;
};

export type ShipmentDeliverySearchResponse = {
  ok: boolean;
  message?: string;
  totalCount?: number;
  nextCursor?: string | null;
  hasMore?: boolean;
  coverage?: "COMPLETE" | "FILTERED";
  count?: number;
  items?: ShipmentDeliverySearchRow[];
};

export type ShipmentDeliveryMember = {
  allocationId: number;
  memberSequence: number;
  externalOrderId: string;
  externalShipmentId: string;
  productName: string;
  pgNo: string;
  uniqueNo: string;
  inventoryStatus: string | null;
  channelStatus: string | null;
  batchLabel: string | null;
  printLineNo: number | null;
};

export type ShipmentDeliveryRevision = {
  carrierShipmentId: number;
  isCurrent: boolean;
  carrierCode: string;
  trackingNumber: string;
  previousTrackingNumber: string | null;
  revisionNo: number;
  invoiceStatus: string;
  shipmentStatus: string;
  allocatedAt: string | null;
  carrierRegisteredAt: string | null;
  lastTrackedAt: string | null;
  createdAt: string;
};

export type ShipmentDeliveryWorkflow = {
  key:
    | "INVOICE_ISSUE"
    | "LABEL_PRINT"
    | "CHANNEL_WRITE"
    | "CARRIER_REGISTRATION"
    | "INVOICE_REPLACEMENT";
  status: string;
  occurredAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  relatedId: number | null;
};

export type ShipmentDeliveryTrackingEvent = {
  id: number;
  scanDate: string | null;
  scanTime: string | null;
  occurredAt: string | null;
  statusName: string;
  branchName: string | null;
  salesOfficeName: string | null;
  recipientTypeName: string | null;
};

export type ShipmentDeliveryReview = {
  id: number;
  source:
    | "CARRIER_RECONCILIATION"
    | "CHANNEL_WRITE"
    | "CARRIER_REGISTRATION"
    | "INVOICE_ISSUE"
    | "INVOICE_REPLACEMENT";
  operationType: string;
  status: string;
  reason: string | null;
  errorMessage: string | null;
  updatedAt: string;
};

export type ShipmentDeliverySearchDetail = {
  summary: ShipmentDeliverySearchRow;
  receiver: {
    name: string;
    maskedPhone: string;
    postCode: string | null;
    address1: string | null;
    address2: string | null;
    fullAddress: string;
    shippingMemo: string | null;
  };
  packageGroup: {
    groupStatus: string;
    splitFromGroupId: number | null;
    frozenAt: string | null;
    invalidatedAt: string | null;
    invalidationReason: string | null;
    createdAt: string;
    updatedAt: string;
  };
  members: ShipmentDeliveryMember[];
  revisions: ShipmentDeliveryRevision[];
  workflows: ShipmentDeliveryWorkflow[];
  trackingEvents: ShipmentDeliveryTrackingEvent[];
  trackingEventsTruncated: boolean;
  reviews: ShipmentDeliveryReview[];
};

export type ShipmentDeliverySearchDetailResponse = {
  ok: boolean;
  message?: string;
  detail?: ShipmentDeliverySearchDetail;
};
