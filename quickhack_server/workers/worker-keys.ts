export const COUPANG_SYNC_WORKER_KEY = {
  acceptOrders: "coupang-accept-order-sync",
  preShipmentVerification: "coupang-pre-shipment-verification-sync",
  preShipmentReturns: "coupang-pre-shipment-return-sync",
  shipmentStatus: "coupang-shipment-status-sync",
  afterShipmentClaims: "coupang-after-shipment-claim-sync",
} as const;

export const LOGEN_WORKER_KEY = {
  shipmentRegistration: "logen-shipment-registration",
  shipmentTracking: "logen-shipment-tracking-sync",
} as const;

export const STATISTICS_WORKER_KEY = {
  dailySnapshot: "statistics-daily-snapshot",
} as const;

export const OBSERVABILITY_WORKER_KEY = {
  traceRetention: "observability-trace-retention",
} as const;

export const MANUAL_ORDER_MATCH_WORKER_KEY = {
  retention: "manual-order-match-retention",
} as const;

export const ORDER_MATCHING_WORKER_KEY = "coupang-order-matching";

export const INSPECTION_PG_WORKER_KEY = {
  retention: "inspection-pg-reservation-retention",
} as const;
