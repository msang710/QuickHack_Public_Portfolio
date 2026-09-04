// QuickHack note: 응답 성능 측정 메뉴의 서버/클라이언트 공통 데이터 계약입니다.

export const RESPONSE_PERFORMANCE_RANGE_VALUES = [
  "1h",
  "6h",
  "24h",
  "7d",
] as const;

export type ResponsePerformanceRange =
  (typeof RESPONSE_PERFORMANCE_RANGE_VALUES)[number];

export const RESPONSE_PERFORMANCE_STATUS_VALUES = [
  "ALL",
  "SUCCESS",
  "FAILED",
] as const;

export type ResponsePerformanceStatusFilter =
  (typeof RESPONSE_PERFORMANCE_STATUS_VALUES)[number];

export const RESPONSE_PERFORMANCE_OPERATION_NAMES = [
  "inventory.workspace.read", "inventory.quantity-ledger.read", "inventory.quantity-ledger.movements.read",
  "inventory.inbound-reconciliation.read", "inventory.device.create", "inventory.device.update",
  "inventory.device.delete", "inventory.bulk-correction", "inventory.audit.save",
  "inspection.record.save", "inbound.batch.read", "inbound.batch.create", "inbound.batch.update",
  "inbound.batch.delete", "inbound.purchase.confirm", "inbound.purchase-price.save",
  "shipment.orders.read", "shipment.delivering.read", "shipment.print-history.read",
  "shipment.inventory-candidates.read", "shipment.address-change.read", "shipment.packing-check",
  "shipment.print-batch.create", "shipment.print-batch.update", "return.action", "return.list.read",
  "statistics.dashboard.read", "statistics.sales.read", "sales-channel.sync-check.read",
  "sales-channel.sync-check.recheck-inventory", "sales-channel.sync-check.repair-inventory",
  "sales-channel.write-review.action",
] as const;

export type ResponsePerformanceDurationStats = {
  sampleCount: number;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export type ResponsePerformanceQueryMetrics = {
  count: number;
  readCount: number;
  writeCount: number;
  totalMs: number;
  maxMs: number;
};

export type ResponsePerformanceTransactionMetrics = {
  count: number;
  waitMs: number;
  runMs: number;
  totalMs: number;
  maxMs: number;
};

export type ResponsePerformanceClientMetrics = {
  responseStatus: number;
  headerReceivedMs: number;
  responseCompleteMs: number | null;
  bodyProcessingMs: number | null;
  gatewayMs: number | null;
  outsideServerMs: number | null;
  observedAt: string;
};

export type ResponsePerformanceOperationSummary = {
  key: string;
  operationName: string;
  method: string;
  route: string;
  sampleCount: number;
  successSampleCount: number;
  failedSampleCount: number;
  slowSampleCount: number;
  duration: ResponsePerformanceDurationStats;
  averageQueryMs: number | null;
  averageTransactionWaitMs: number | null;
  averageTransactionRunMs: number | null;
  clientSampleCount: number;
  clientCoveragePercent: number;
  clientDuration: ResponsePerformanceDurationStats;
  averageOutsideServerMs: number | null;
};

export type ResponsePerformanceTraceSummary = {
  logId: number;
  traceId: string;
  operationName: string;
  route: string;
  method: string;
  status: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  targetCount: number | null;
  displayName: string;
  username: string;
  query: ResponsePerformanceQueryMetrics;
  transaction: ResponsePerformanceTransactionMetrics;
  client: ResponsePerformanceClientMetrics | null;
  errorCode: string;
  errorMessage: string;
};

export type ResponsePerformanceSpan = {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
};

export type ResponsePerformanceTraceDetail =
  ResponsePerformanceTraceSummary & {
    spans: ResponsePerformanceSpan[];
    context: Record<string, string>;
    fields: Record<string, string>;
  };

export type ResponsePerformanceReport = {
  ok: true;
  mode: "REPORT";
  checkedAt: string;
  window: {
    range: ResponsePerformanceRange;
    from: string;
    to: string;
  };
  filters: {
    status: ResponsePerformanceStatusFilter;
    operation: string;
  };
  sample: {
    matchedCount: number;
    analyzedCount: number;
    truncated: boolean;
    analysisLimit: number;
    productionSamplingDetected: boolean;
  };
  overview: {
    successSampleCount: number;
    failedSampleCount: number;
    slowSampleCount: number;
    duration: ResponsePerformanceDurationStats;
  };
  operations: ResponsePerformanceOperationSummary[];
  traces: ResponsePerformanceTraceSummary[];
  ingestion: {
    pendingCount: number;
    droppedCount: number;
    lastFailure: string;
    lastFlushedAt: string;
    consecutiveFailureCount: number;
  };
};

export type ResponsePerformanceDetailResponse = {
  ok: true;
  mode: "DETAIL";
  item: ResponsePerformanceTraceDetail;
};

export type ResponsePerformanceErrorResponse = {
  ok: false;
  code: string;
};

export type ResponsePerformanceApiResponse =
  | ResponsePerformanceReport
  | ResponsePerformanceDetailResponse
  | ResponsePerformanceErrorResponse;
