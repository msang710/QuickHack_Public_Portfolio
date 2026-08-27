export const CARRIER_INVOICE_ISSUE_BATCH_STATUS = {
  pending: "PENDING",
  allocating: "ALLOCATING",
  allocated: "ALLOCATED",
  reviewRequired: "REVIEW_REQUIRED",
  failed: "FAILED",
} as const;

export const ACTIVE_CARRIER_INVOICE_ISSUE_BATCH_STATUSES = [
  CARRIER_INVOICE_ISSUE_BATCH_STATUS.pending,
  CARRIER_INVOICE_ISSUE_BATCH_STATUS.allocating,
  CARRIER_INVOICE_ISSUE_BATCH_STATUS.reviewRequired,
] as const;

export const CARRIER_INVOICE_ISSUE_ITEM_STATUS = {
  pending: "PENDING",
  allocated: "ALLOCATED",
  failed: "FAILED",
  missingResponse: "MISSING_RESPONSE",
  conflict: "CONFLICT",
} as const;

export const CARRIER_REGISTRATION_WORK_STATUS = {
  pending: "PENDING",
  prepared: "PREPARED",
  submitting: "SUBMITTING",
  retryWaiting: "RETRY_WAITING",
  reconciling: "RECONCILING",
  registered: "REGISTERED",
  blocked: "BLOCKED",
  reviewRequired: "REVIEW_REQUIRED",
} as const;

export const ACTIVE_CARRIER_REGISTRATION_WORK_STATUSES = [
  CARRIER_REGISTRATION_WORK_STATUS.pending,
  CARRIER_REGISTRATION_WORK_STATUS.prepared,
  CARRIER_REGISTRATION_WORK_STATUS.submitting,
  CARRIER_REGISTRATION_WORK_STATUS.retryWaiting,
  CARRIER_REGISTRATION_WORK_STATUS.reconciling,
  CARRIER_REGISTRATION_WORK_STATUS.reviewRequired,
] as const;

export const ACTIVE_SHIPMENT_ADDRESS_CHANGE_STATUSES = [
  "PENDING",
  "FAILED",
] as const;
