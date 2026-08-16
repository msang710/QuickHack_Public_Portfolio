// QuickHack note: 저장된 사용자 조작 trace를 응답 성능 메뉴용 표본 통계로 집계합니다.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { getOperationTraceQueueState } from "@/quickhack_server/observability/trace-log-queue";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import {
  RESPONSE_PERFORMANCE_RANGE_VALUES,
  RESPONSE_PERFORMANCE_STATUS_VALUES,
  responsePerformanceOperationLabel,
  type ResponsePerformanceDurationStats,
  type ResponsePerformanceOperationSummary,
  type ResponsePerformanceClientMetrics,
  type ResponsePerformanceQueryMetrics,
  type ResponsePerformanceRange,
  type ResponsePerformanceReport,
  type ResponsePerformanceStatusFilter,
  type ResponsePerformanceTraceDetail,
  type ResponsePerformanceTraceSummary,
  type ResponsePerformanceTransactionMetrics,
} from "@/quickhack_shared/observability/response-performance";
import {
  addSeconds,
  nowKstSqlDateTime,
} from "@/quickhack_shared/core/time";

const USER_OPERATION_TRACE_JOB_TYPE = "USER_OPERATION_TRACE";
const SLOW_TRACE_THRESHOLD_MS = 1_000;
const ANALYSIS_LIMIT = 2_000;
const TRACE_LIST_LIMIT = 300;
const RANGE_SECONDS: Record<ResponsePerformanceRange, number> = {
  "1h": 60 * 60,
  "6h": 60 * 60 * 6,
  "24h": 60 * 60 * 24,
  "7d": 60 * 60 * 24 * 7,
};
const COMPACT_FIELD_NAMES = [
  "trace_id",
  "source",
  "route",
  "method",
  "target_count",
  "query.count",
  "query.read_count",
  "query.write_count",
  "query.total_ms",
  "query.max_ms",
  "transaction.count",
  "transaction.wait_ms",
  "transaction.run_ms",
  "transaction.total_ms",
  "transaction.max_ms",
  "context.runtime.environment",
] as const;

export type PerformanceTraceRecord = {
  id: number;
  job_name: string | null;
  status: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  duration_ms: number | null;
  summary_processed_count: number | null;
  error_code: string | null;
  error_message: string | null;
  fields: Array<{
    field_name: string;
    field_value: string | null;
  }>;
  users?: {
    username: string;
    employee_profiles?: {
      display_name: string;
    } | null;
  } | null;
};

export type ClientTraceObservationRecord = {
  trace_id: string;
  response_status: number;
  header_received_ms: number;
  response_complete_ms: number | null;
  body_processing_ms: number | null;
  gateway_ms: number | null;
  observed_at: Date | string;
};

type PerformanceReportInput = {
  rows: PerformanceTraceRecord[];
  matchedCount: number;
  range: ResponsePerformanceRange;
  status: ResponsePerformanceStatusFilter;
  operation: string;
  from: string;
  to: string;
  checkedAt: string;
  clientObservations?: ClientTraceObservationRecord[];
  ingestion?: Partial<ResponsePerformanceReport["ingestion"]>;
};

function fieldMap(record: PerformanceTraceRecord) {
  return new Map(
    record.fields.map((field) => [field.field_name, field.field_value ?? ""])
  );
}

function nonNegativeNumber(value: string | null | undefined) {
  const parsed = Number(value ?? "");

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.round(parsed);
}

function nullableNonNegativeNumber(value: string | null | undefined) {
  if (String(value ?? "").trim() === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.round(parsed);
}

function queryMetrics(fields: Map<string, string>): ResponsePerformanceQueryMetrics {
  return {
    count: nonNegativeNumber(fields.get("query.count")),
    readCount: nonNegativeNumber(fields.get("query.read_count")),
    writeCount: nonNegativeNumber(fields.get("query.write_count")),
    totalMs: nonNegativeNumber(fields.get("query.total_ms")),
    maxMs: nonNegativeNumber(fields.get("query.max_ms")),
  };
}

function transactionMetrics(
  fields: Map<string, string>
): ResponsePerformanceTransactionMetrics {
  return {
    count: nonNegativeNumber(fields.get("transaction.count")),
    waitMs: nonNegativeNumber(fields.get("transaction.wait_ms")),
    runMs: nonNegativeNumber(fields.get("transaction.run_ms")),
    totalMs: nonNegativeNumber(fields.get("transaction.total_ms")),
    maxMs: nonNegativeNumber(fields.get("transaction.max_ms")),
  };
}

function clientMetrics(
  observation: ClientTraceObservationRecord | undefined,
  serverDurationMs: number
): ResponsePerformanceClientMetrics | null {
  if (!observation) return null;

  return {
    responseStatus: observation.response_status,
    headerReceivedMs: observation.header_received_ms,
    responseCompleteMs: observation.response_complete_ms,
    bodyProcessingMs: observation.body_processing_ms,
    gatewayMs: observation.gateway_ms,
    outsideServerMs:
      observation.response_complete_ms === null
        ? null
        : Math.max(0, observation.response_complete_ms - serverDurationMs),
    observedAt: requiredApiDateTime(observation.observed_at),
  };
}

function traceIdForRecord(record: PerformanceTraceRecord) {
  return (
    record.fields.find((field) => field.field_name === "trace_id")
      ?.field_value ?? ""
  );
}

const CLIENT_OBSERVATION_SELECT = {
  trace_id: true,
  response_status: true,
  header_received_ms: true,
  response_complete_ms: true,
  body_processing_ms: true,
  gateway_ms: true,
  observed_at: true,
} as const;

async function loadClientObservations(rows: PerformanceTraceRecord[]) {
  const traceIds = Array.from(
    new Set(rows.map(traceIdForRecord).filter((traceId) => traceId.length > 0))
  );
  const observations: ClientTraceObservationRecord[] = [];

  for (let index = 0; index < traceIds.length; index += 400) {
    observations.push(
      ...(await prisma.client_http_trace_observations.findMany({
        where: { trace_id: { in: traceIds.slice(index, index + 400) } },
        select: CLIENT_OBSERVATION_SELECT,
      }))
    );
  }

  return observations;
}

function traceSummary(
  record: PerformanceTraceRecord,
  observations: Map<string, ClientTraceObservationRecord>
): ResponsePerformanceTraceSummary {
  const fields = fieldMap(record);
  const operationName = record.job_name ?? "unknown-operation";
  const traceId = fields.get("trace_id") ?? "";
  const durationMs = Math.max(0, record.duration_ms ?? 0);

  return {
    logId: record.id,
    traceId,
    operationName,
    operationLabel: responsePerformanceOperationLabel(operationName),
    route: fields.get("route") ?? "",
    method: fields.get("method") ?? "",
    status: record.status,
    durationMs,
    startedAt: requiredApiDateTime(record.started_at),
    finishedAt: apiDateTime(record.finished_at) ?? "",
    targetCount:
      nullableNonNegativeNumber(fields.get("target_count")) ??
      record.summary_processed_count,
    displayName:
      record.users?.employee_profiles?.display_name ??
      record.users?.username ??
      "",
    username: record.users?.username ?? "",
    query: queryMetrics(fields),
    transaction: transactionMetrics(fields),
    client: clientMetrics(observations.get(traceId), durationMs),
    errorCode: record.error_code ?? "",
    errorMessage: record.error_message ?? "",
  };
}

function nearestRank(sortedValues: number[], percentile: number) {
  if (sortedValues.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(sortedValues.length - 1, Math.ceil(percentile * sortedValues.length) - 1)
  );

  return sortedValues[index];
}

export function responsePerformanceDurationStats(
  values: number[]
): ResponsePerformanceDurationStats {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value))
    .sort((left, right) => left - right);

  if (sorted.length === 0) {
    return {
      sampleCount: 0,
      averageMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    };
  }

  return {
    sampleCount: sorted.length,
    averageMs: Math.round(
      sorted.reduce((total, value) => total + value, 0) / sorted.length
    ),
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    maxMs: sorted.at(-1) ?? null,
  };
}

function average(values: number[]) {
  if (values.length === 0) return null;

  return Math.round(
    values.reduce((total, value) => total + value, 0) / values.length
  );
}

function selectedLatencyRows(
  rows: ResponsePerformanceTraceSummary[],
  status: ResponsePerformanceStatusFilter
) {
  if (status === "FAILED") return rows;
  return rows.filter((row) => row.status === "SUCCESS");
}

function operationSummaries(
  rows: ResponsePerformanceTraceSummary[],
  status: ResponsePerformanceStatusFilter
) {
  const groups = new Map<string, ResponsePerformanceTraceSummary[]>();

  for (const row of rows) {
    const key = `${row.operationName}\u0000${row.method}\u0000${row.route}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const summaries: ResponsePerformanceOperationSummary[] = [];

  for (const [key, group] of groups) {
    const first = group[0];
    const latencyRows = selectedLatencyRows(group, status);
    const clientDurations = latencyRows.flatMap((row) =>
      row.client?.responseCompleteMs === null || !row.client
        ? []
        : [row.client.responseCompleteMs]
    );
    const outsideServerDurations = latencyRows.flatMap((row) =>
      row.client?.outsideServerMs === null || !row.client
        ? []
        : [row.client.outsideServerMs]
    );

    summaries.push({
      key,
      operationName: first.operationName,
      operationLabel: first.operationLabel,
      method: first.method,
      route: first.route,
      sampleCount: group.length,
      successSampleCount: group.filter((row) => row.status === "SUCCESS").length,
      failedSampleCount: group.filter((row) => row.status !== "SUCCESS").length,
      slowSampleCount: group.filter(
        (row) => row.durationMs >= SLOW_TRACE_THRESHOLD_MS
      ).length,
      duration: responsePerformanceDurationStats(
        latencyRows.map((row) => row.durationMs)
      ),
      averageQueryMs: average(latencyRows.map((row) => row.query.totalMs)),
      averageTransactionWaitMs: average(
        latencyRows.map((row) => row.transaction.waitMs)
      ),
      averageTransactionRunMs: average(
        latencyRows.map((row) => row.transaction.runMs)
      ),
      clientSampleCount: clientDurations.length,
      clientCoveragePercent:
        latencyRows.length === 0
          ? 0
          : Math.round((clientDurations.length / latencyRows.length) * 100),
      clientDuration: responsePerformanceDurationStats(clientDurations),
      averageOutsideServerMs: average(outsideServerDurations),
    });
  }

  return summaries.sort((left, right) => {
    const p95Difference = (right.duration.p95Ms ?? -1) - (left.duration.p95Ms ?? -1);

    if (p95Difference !== 0) return p95Difference;
    return right.sampleCount - left.sampleCount;
  });
}

export function buildResponsePerformanceReport(
  input: PerformanceReportInput
): ResponsePerformanceReport {
  const observations = new Map(
    (input.clientObservations ?? []).map((item) => [item.trace_id, item])
  );
  const summaries = input.rows.map((row) => traceSummary(row, observations));
  const latencyRows = selectedLatencyRows(summaries, input.status);
  const queue = input.ingestion ?? {};

  return {
    ok: true,
    mode: "REPORT",
    checkedAt: input.checkedAt,
    window: {
      range: input.range,
      from: input.from,
      to: input.to,
    },
    filters: {
      status: input.status,
      operation: input.operation,
    },
    sample: {
      matchedCount: input.matchedCount,
      analyzedCount: summaries.length,
      truncated: input.matchedCount > summaries.length,
      analysisLimit: ANALYSIS_LIMIT,
      productionSamplingDetected: input.rows.some(
        (row) => fieldMap(row).get("context.runtime.environment") === "production"
      ),
    },
    overview: {
      successSampleCount: summaries.filter((row) => row.status === "SUCCESS").length,
      failedSampleCount: summaries.filter((row) => row.status !== "SUCCESS").length,
      slowSampleCount: summaries.filter(
        (row) => row.durationMs >= SLOW_TRACE_THRESHOLD_MS
      ).length,
      duration: responsePerformanceDurationStats(
        latencyRows.map((row) => row.durationMs)
      ),
    },
    operations: operationSummaries(summaries, input.status),
    traces: summaries.slice(0, TRACE_LIST_LIMIT),
    ingestion: {
      pendingCount: queue.pendingCount ?? 0,
      droppedCount: queue.droppedCount ?? 0,
      lastFailure: queue.lastFailure ?? "",
      lastFlushedAt: queue.lastFlushedAt ?? "",
      consecutiveFailureCount: queue.consecutiveFailureCount ?? 0,
    },
  };
}

export function buildResponsePerformanceTraceDetail(
  record: PerformanceTraceRecord,
  observation?: ClientTraceObservationRecord
): ResponsePerformanceTraceDetail {
  const observations = new Map<string, ClientTraceObservationRecord>();
  if (observation) observations.set(observation.trace_id, observation);
  const summary = traceSummary(record, observations);
  const values = Object.fromEntries(
    record.fields.map((field) => [field.field_name, field.field_value ?? ""])
  );
  const spanParts = new Map<
    string,
    { count: number; totalMs: number; maxMs: number }
  >();
  const context: Record<string, string> = {};

  for (const [name, value] of Object.entries(values)) {
    const spanMatch = /^span\.(.+)\.(count|total_ms|max_ms)$/.exec(name);

    if (spanMatch) {
      const spanName = spanMatch[1];
      const metric = spanMatch[2];
      const span = spanParts.get(spanName) ?? { count: 0, totalMs: 0, maxMs: 0 };
      const parsed = nonNegativeNumber(value);

      if (metric === "count") span.count = parsed;
      if (metric === "total_ms") span.totalMs = parsed;
      if (metric === "max_ms") span.maxMs = parsed;
      spanParts.set(spanName, span);
      continue;
    }

    if (name.startsWith("context.")) {
      context[name.slice("context.".length)] = value;
    }
  }

  return {
    ...summary,
    spans: Array.from(spanParts.entries())
      .map(([name, span]) => ({ name, ...span }))
      .sort((left, right) => right.totalMs - left.totalMs),
    context,
    fields: values,
  };
}

export function normalizeResponsePerformanceRange(
  value: string | null
): ResponsePerformanceRange {
  return RESPONSE_PERFORMANCE_RANGE_VALUES.includes(
    value as ResponsePerformanceRange
  )
    ? (value as ResponsePerformanceRange)
    : "24h";
}

export function normalizeResponsePerformanceStatus(
  value: string | null
): ResponsePerformanceStatusFilter {
  return RESPONSE_PERFORMANCE_STATUS_VALUES.includes(
    value as ResponsePerformanceStatusFilter
  )
    ? (value as ResponsePerformanceStatusFilter)
    : "ALL";
}

function performanceLogWhere(input: {
  from: string;
  to: string;
  status: ResponsePerformanceStatusFilter;
  operation: string;
}): Prisma.server_job_logsWhereInput {
  return {
    job_type: USER_OPERATION_TRACE_JOB_TYPE,
    started_at: {
      gte: input.from,
      lte: input.to,
    },
    ...(input.status === "ALL" ? {} : { status: input.status }),
    ...(input.operation ? { job_name: input.operation } : {}),
  };
}

export async function loadResponsePerformanceReport(input: {
  range: ResponsePerformanceRange;
  status: ResponsePerformanceStatusFilter;
  operation?: string | null;
}) {
  const now = new Date();
  const to = nowKstSqlDateTime(now);
  const from = nowKstSqlDateTime(addSeconds(now, -RANGE_SECONDS[input.range]));
  const operation = String(input.operation ?? "").trim();
  const traceQueue = getOperationTraceQueueState();
  const where = performanceLogWhere({
    from,
    to,
    status: input.status,
    operation,
  });
  const [matchedCount, rows] = await Promise.all([
    prisma.server_job_logs.count({ where }),
    prisma.server_job_logs.findMany({
      where,
      orderBy: [{ started_at: "desc" }, { id: "desc" }],
      take: ANALYSIS_LIMIT,
      select: {
        id: true,
        job_name: true,
        status: true,
        started_at: true,
        finished_at: true,
        duration_ms: true,
        summary_processed_count: true,
        error_code: true,
        error_message: true,
        users: {
          select: {
            username: true,
            employee_profiles: {
              select: { display_name: true },
            },
          },
        },
        fields: {
          where: {
            field_name: { in: [...COMPACT_FIELD_NAMES] },
          },
          select: {
            field_name: true,
            field_value: true,
          },
        },
      },
    }),
  ]);
  const clientObservations = await loadClientObservations(rows);

  return buildResponsePerformanceReport({
    rows,
    matchedCount,
    range: input.range,
    status: input.status,
    operation,
    from,
    to,
    checkedAt: to,
    clientObservations,
    ingestion: {
      ...traceQueue,
      lastFailure: traceQueue.lastFailure ?? "",
      lastFlushedAt: traceQueue.lastFlushedAt ?? "",
    },
  });
}

export async function loadResponsePerformanceTraceDetail(logId: number) {
  const row = await prisma.server_job_logs.findFirst({
    where: {
      id: logId,
      job_type: USER_OPERATION_TRACE_JOB_TYPE,
    },
    select: {
      id: true,
      job_name: true,
      status: true,
      started_at: true,
      finished_at: true,
      duration_ms: true,
      summary_processed_count: true,
      error_code: true,
      error_message: true,
      users: {
        select: {
          username: true,
          employee_profiles: {
            select: { display_name: true },
          },
        },
      },
      fields: {
        select: {
          field_name: true,
          field_value: true,
        },
        orderBy: [{ field_name: "asc" }],
      },
    },
  });

  if (!row) return null;
  const traceId = traceIdForRecord(row);
  const observation = traceId
    ? await prisma.client_http_trace_observations.findUnique({
        where: { trace_id: traceId },
        select: CLIENT_OBSERVATION_SELECT,
      })
    : null;

  return buildResponsePerformanceTraceDetail(row, observation ?? undefined);
}
