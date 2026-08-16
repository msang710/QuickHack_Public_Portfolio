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

export const CARRIER_INVOICE_REPLACEMENT_STAGE_LABELS: Record<string, string> = {
  PRECHECK: "최신 주문과 출고 상태 확인",
  OLD_INVOICE_HANDLING: "기존 송장 처리 확인",
  ALLOCATION: "새 송장번호 채번",
  CHANNEL_UPDATE: "쿠팡 송장번호 변경",
  CARRIER_REGISTRATION: "로젠 주문 등록",
  LABEL_PRINT: "새 송장 출력",
  FINALIZE: "출고 보류 해제",
};

export const CARRIER_INVOICE_REPLACEMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "처리 대기",
  PROCESSING: "처리 중",
  WAITING_MANUAL: "관리자 확인 필요",
  WAITING_LABEL: "새 송장 출력 필요",
  COMPLETED: "교체 완료",
  REVIEW_REQUIRED: "직접 확인 필요",
  FAILED: "처리 실패",
  CANCELED: "작업 취소",
};
