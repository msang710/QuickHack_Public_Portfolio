export type InvoiceReplacementNextAction = {
  code: string;
};

export type InvoiceReplacement = {
  replacementWorkId: number;
  sourceType: string;
  status: string;
  stage: string;
  oldInvoiceHandlingStatus: string;
  executionState: "IDLE" | "RUNNING" | "STALE";
  packageGroupId: number;
  packageGroupStatus: string;
  shipmentAddressChangeWorkId: number | null;
  issueBatchId: number | null;
  shipmentListPrintBatchId: number | null;
  shipmentListPrintTabKey: string | null;
  shipmentListPrintBatchLabel: string | null;
  oldCarrierShipmentId: number;
  oldTrackingNumber: string;
  oldShipmentStatus: string;
  candidateCarrierShipmentId: number | null;
  candidateTrackingNumber: string | null;
  candidateInvoiceStatus: string | null;
  reasonCode: string;
  reasonNote: string | null;
  beforeReceiver: {
    name: string | null;
    phone: string;
    postCode: string | null;
    address1: string | null;
    address2: string | null;
    shippingMemo: string | null;
  };
  afterReceiver: {
    name: string | null;
    phone: string;
    postCode: string | null;
    address1: string | null;
    address2: string | null;
    shippingMemo: string | null;
  };
  memberCount: number;
  members: Array<{
    allocationId: number;
    externalOrderId: string;
    externalShipmentId: string;
    pgNo: string;
    inventoryStatus: string | null;
  }>;
  carrierRegistration: {
    workId: number;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    registeredAt: string | null;
  } | null;
  labelPrintStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestedBy: string;
  resolvedBy: string | null;
  requestedAt: string;
  heldAt: string | null;
  oldInvoiceHandledAt: string | null;
  channelUpdatedAt: string | null;
  carrierRegisteredAt: string | null;
  labelConfirmedAt: string | null;
  completedAt: string | null;
  reviewRequiredAt: string | null;
  failedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
  nextAction: InvoiceReplacementNextAction;
};

export type InvoiceHistoryRow = {
  carrierShipmentId: number;
  packageGroupId: number | null;
  isCurrent: boolean;
  carrierCode: string;
  sourceType: string;
  revisionNo: number;
  trackingNumber: string;
  previousTrackingNumber: string | null;
  invoiceStatus: string;
  shipmentStatus: string;
  channel: string | null;
  externalOrderId: string | null;
  externalShipmentId: string | null;
  pgNo: string | null;
  packageGroupStatus: string | null;
  receiverName: string;
  receiverAddress: string;
  memberCount: number;
  members: Array<{
    allocationId: number;
    externalOrderId: string;
    externalShipmentId: string;
    pgNo: string;
    inventoryStatus: string | null;
  }>;
  issue: {
    issueBatchId: number;
    issueItemId: number | null;
    issueType: string;
    batchStatus: string;
    itemStatus: string | null;
    issueSequence: number | null;
    requestedAt: string;
    completedAt: string | null;
    labelPrintStatus: string;
    labelConfirmedAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  } | null;
  channelWrite: {
    requestId: number;
    requestType: string;
    requestTypeLabel: string;
    status: string;
    failureStage: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    requestedAt: string;
    completedAt: string | null;
  } | null;
  registration: {
    workId: number;
    status: string;
    attemptCount: number;
    fixTakeNo: string;
    takeDate: string;
    receiverBranchCode: string | null;
    classificationCode: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    registeredAt: string | null;
  } | null;
  replacement: {
    replacementWorkId: number;
    status: string;
    stage: string;
    sourceType: string;
  } | null;
  trackingEvents: Array<{
    id: number;
    scanDate: string | null;
    scanTime: string | null;
    statusName: string;
    branchName: string | null;
  }>;
  allocatedAt: string | null;
  carrierRegisteredAt: string | null;
  lastTrackedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceManualCandidate = {
  issueBatchId: number;
  shipmentListPrintBatchId: number;
  shipmentListPrintBatchLabel: string;
  issueType: string;
  status: string;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
  replacementWorkId: number | null;
  replacementStatus: string | null;
  replacementStage: string | null;
  nextAction: { code: string };
  items: Array<{
    issueItemId: number;
    packageGroupId: number;
    status: string;
    trackingNumber: string | null;
    resultCode: string | null;
    resultMessage: string | null;
    registrationStatus: string | null;
    registrationError: string | null;
    orders: Array<{
      externalOrderId: string;
      externalShipmentId: string;
      pgNo: string;
    }>;
  }>;
};
