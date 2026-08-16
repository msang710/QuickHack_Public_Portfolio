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

export const RESPONSE_PERFORMANCE_OPERATION_LABELS: Record<string, string> = {
  "inventory.workspace.read": "재고 작업공간 조회",
  "inventory.quantity-ledger.read": "재고 수량 원장 조회",
  "inventory.quantity-ledger.movements.read": "재고 수불 이력 조회",
  "inventory.inbound-reconciliation.read": "입고 대조 상세 조회",
  "inventory.device.create": "재고 추가",
  "inventory.device.update": "기존 재고 수정",
  "inventory.device.delete": "재고 삭제",
  "inventory.bulk-correction": "재고 일괄 수정",
  "inventory.audit.save": "재고실사 저장",
  "inspection.record.save": "검수 기록 저장",
  "inbound.batch.read": "입고 차수 조회",
  "inbound.batch.create": "입고 차수 생성",
  "inbound.batch.update": "입고 차수 수정",
  "inbound.batch.delete": "입고 차수 삭제",
  "inbound.purchase.confirm": "매입 확정",
  "inbound.purchase-price.save": "매입가 저장",
  "shipment.orders.read": "출고 주문 조회",
  "shipment.delivering.read": "배송 중 목록 조회",
  "shipment.print-history.read": "출고 출력 이력 조회",
  "shipment.inventory-candidates.read": "출고 재고 후보 조회",
  "shipment.address-change.read": "배송지 변경 건 조회",
  "shipment.packing-check": "포장 검증",
  "shipment.print-batch.create": "출고 목록 생성",
  "shipment.print-batch.update": "출고 목록 상태 변경",
  "return.action": "반품 처리",
  "return.list.read": "반품 목록 조회",
  "statistics.dashboard.read": "통계 대시보드 조회",
  "statistics.sales.read": "매출 통계 조회",
  "sales-channel.sync-check.read": "판매 채널 동기화 점검 조회",
  "sales-channel.sync-check.recheck-inventory": "판매 채널 재고 다시 점검",
  "sales-channel.sync-check.repair-inventory": "판매 채널 재고수량 복구",
  "sales-channel.write-review.action": "판매 채널 쓰기 점검 처리",
};

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
  operationLabel: string;
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
  operationLabel: string;
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
  message: string;
};

export type ResponsePerformanceApiResponse =
  | ResponsePerformanceReport
  | ResponsePerformanceDetailResponse
  | ResponsePerformanceErrorResponse;

export function responsePerformanceOperationLabel(operationName: string) {
  return RESPONSE_PERFORMANCE_OPERATION_LABELS[operationName] ?? operationName;
}
