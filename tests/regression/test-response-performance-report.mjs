import {
  buildResponsePerformanceReport,
  buildResponsePerformanceTraceDetail,
  responsePerformanceDurationStats,
} from "@/quickhack_server/observability/response-performance-service";
import { responsePerformanceOperationLabel } from "@/quickhack_shared/observability/response-performance";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function field(fieldName, fieldValue) {
  return { field_name: fieldName, field_value: String(fieldValue) };
}

function trace({
  id,
  operation = "return.action",
  status = "SUCCESS",
  durationMs,
  route = "/api/coupang/returns",
  method = "PATCH",
  fields = [],
}) {
  return {
    id,
    job_name: operation,
    status,
    started_at: `2026-07-22 0${id}:00:00`,
    finished_at: `2026-07-22 0${id}:00:01`,
    duration_ms: durationMs,
    summary_processed_count: 1,
    error_code: status === "SUCCESS" ? null : "TEST_FAILURE",
    error_message: status === "SUCCESS" ? null : "test failure",
    fields: [
      field("trace_id", `trace-${id}`),
      field("route", route),
      field("method", method),
      field("target_count", 1),
      field("query.count", 2),
      field("query.read_count", 1),
      field("query.write_count", 1),
      field("query.total_ms", id === 2 ? "invalid" : 10 * id),
      field("query.max_ms", 10),
      field("transaction.count", 1),
      field("transaction.wait_ms", id),
      field("transaction.run_ms", 5 * id),
      field("transaction.total_ms", 6 * id),
      field("transaction.max_ms", 6 * id),
      ...fields,
    ],
    users: {
      username: "developer",
      employee_profiles: { display_name: "개발자 테스트" },
    },
  };
}

const durationStats = responsePerformanceDurationStats([1_000, 100, 300, 200]);
assert(durationStats.averageMs === 400, "Average duration must be calculated.");
assert(durationStats.p50Ms === 200, "P50 must use nearest-rank calculation.");
assert(durationStats.p95Ms === 1_000, "P95 must use nearest-rank calculation.");
assert(
  responsePerformanceOperationLabel("statistics.sales.read") === "매출 통계 조회",
  "Expanded read operations must have a user-facing label."
);
assert(
  responsePerformanceOperationLabel("sales-channel.sync-check.read") ===
    "판매 채널 동기화 점검 조회",
  "Sync-check reads must have a user-facing label."
);
assert(
  responsePerformanceOperationLabel(
    "sales-channel.sync-check.recheck-inventory"
  ) === "판매 채널 재고 다시 점검",
  "Inventory rechecks must have a user-facing label."
);
assert(
  responsePerformanceOperationLabel(
    "sales-channel.sync-check.repair-inventory"
  ) === "판매 채널 재고수량 복구",
  "Inventory repairs must have a user-facing label."
);

const rows = [
  trace({ id: 1, durationMs: 100 }),
  trace({ id: 2, durationMs: 200 }),
  trace({ id: 3, durationMs: 300 }),
  trace({ id: 4, durationMs: 1_000 }),
  trace({
    id: 5,
    operation: "inventory.audit.save",
    route: "/api/inventory/audit",
    method: "POST",
    status: "FAILED",
    durationMs: 50,
    fields: [field("context.runtime.environment", "production")],
  }),
];

const report = buildResponsePerformanceReport({
  rows,
  clientObservations: [
    {
      trace_id: "trace-1",
      response_status: 200,
      header_received_ms: 140,
      response_complete_ms: 160,
      body_processing_ms: 20,
      gateway_ms: 15,
      observed_at: "2026-07-22T00:00:00.000Z",
    },
    {
      trace_id: "trace-2",
      response_status: 200,
      header_received_ms: 220,
      response_complete_ms: null,
      body_processing_ms: null,
      gateway_ms: 12,
      observed_at: "2026-07-22T00:00:01.000Z",
    },
  ],
  matchedCount: 2_501,
  range: "24h",
  status: "ALL",
  operation: "",
  from: "2026-07-21 09:00:00",
  to: "2026-07-22 09:00:00",
  checkedAt: "2026-07-22 09:00:00",
  ingestion: {
    pendingCount: 2,
    droppedCount: 1,
    lastFailure: "",
    lastFlushedAt: "2026-07-22T00:00:00.000Z",
    consecutiveFailureCount: 0,
  },
});

assert(report.overview.duration.sampleCount === 4, "Failed traces must not lower the default success latency distribution.");
assert(report.overview.duration.averageMs === 400, "The report must aggregate successful durations.");
assert(report.overview.failedSampleCount === 1, "Failure samples must be counted separately.");
assert(report.overview.slowSampleCount === 1, "Slow samples must use the one-second threshold.");
assert(report.sample.truncated, "The report must disclose analysis truncation.");
assert(report.sample.productionSamplingDetected, "Production sampling must be disclosed.");
assert(report.ingestion.pendingCount === 2, "Trace ingestion health must be preserved.");
assert(report.operations.length === 2, "Operations must be grouped independently.");
assert(report.traces[1].query.totalMs === 0, "Malformed numeric fields must be handled safely.");
const returnOperation = report.operations.find(
  (item) => item.operationName === "return.action"
);
assert(returnOperation?.clientSampleCount === 1, "Only completed client observations must enter the latency distribution.");
assert(returnOperation?.clientCoveragePercent === 25, "Client coverage must be disclosed against successful server samples.");
assert(returnOperation?.clientDuration.averageMs === 160, "Client response duration must be aggregated.");
assert(returnOperation?.averageOutsideServerMs === 60, "Time outside the central server must be derived from the shared Trace ID.");

const detail = buildResponsePerformanceTraceDetail(
  trace({
    id: 6,
    durationMs: 500,
    fields: [
      field("span.transaction.sales-channel.write.finalize.total.count", 1),
      field("span.transaction.sales-channel.write.finalize.total.total_ms", 42),
      field("span.transaction.sales-channel.write.finalize.total.max_ms", 42),
      field("context.runtime.database_provider", "postgresql"),
    ],
  }),
  {
    trace_id: "trace-6",
    response_status: 200,
    header_received_ms: 530,
    response_complete_ms: 550,
    body_processing_ms: 20,
    gateway_ms: 8,
    observed_at: "2026-07-22T00:00:00.000Z",
  }
);

assert(
  detail.spans[0]?.name === "transaction.sales-channel.write.finalize.total",
  "Span names containing dots must remain intact."
);
assert(detail.spans[0]?.totalMs === 42, "Span duration fields must be parsed.");
assert(
  detail.context["runtime.database_provider"] === "postgresql",
  "Context fields must be separated from raw fields."
);
assert(detail.client?.outsideServerMs === 50, "Trace detail must join the client observation by Trace ID.");

console.log("Response performance report invariants passed.");
