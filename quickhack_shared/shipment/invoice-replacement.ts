export const CARRIER_INVOICE_REPLACEMENT_SOURCE = {
  addressChange: "ADDRESS_CHANGE",
  manual: "MANUAL",
} as const;

export const CARRIER_INVOICE_REPLACEMENT_STATUS = {
  pending: "PENDING",
  processing: "PROCESSING",
  waitingManual: "WAITING_MANUAL",
  waitingLabel: "WAITING_LABEL",
  completed: "COMPLETED",
  reviewRequired: "REVIEW_REQUIRED",
  failed: "FAILED",
  canceled: "CANCELED",
} as const;

export const CARRIER_INVOICE_REPLACEMENT_STAGE = {
  precheck: "PRECHECK",
  oldInvoiceHandling: "OLD_INVOICE_HANDLING",
  allocation: "ALLOCATION",
  channelUpdate: "CHANNEL_UPDATE",
  carrierRegistration: "CARRIER_REGISTRATION",
  labelPrint: "LABEL_PRINT",
  finalize: "FINALIZE",
} as const;

export const CARRIER_INVOICE_OLD_HANDLING_STATUS = {
  notRequired: "NOT_REQUIRED",
  pendingManual: "PENDING_MANUAL",
  confirmed: "CONFIRMED",
} as const;

export const TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES = [
  CARRIER_INVOICE_REPLACEMENT_STATUS.completed,
  CARRIER_INVOICE_REPLACEMENT_STATUS.failed,
  CARRIER_INVOICE_REPLACEMENT_STATUS.canceled,
] as const;

export const ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES = [
  CARRIER_INVOICE_REPLACEMENT_STATUS.pending,
  CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
  CARRIER_INVOICE_REPLACEMENT_STATUS.waitingManual,
  CARRIER_INVOICE_REPLACEMENT_STATUS.waitingLabel,
  CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
] as const;

export const CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE = {
  idle: "IDLE",
  running: "RUNNING",
  stale: "STALE",
} as const;
