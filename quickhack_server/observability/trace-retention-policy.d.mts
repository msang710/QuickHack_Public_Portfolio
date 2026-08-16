export const TRACE_RETENTION_SHORT_DAYS: 14;
export const TRACE_RETENTION_WORKER_PARENT_DAYS: 90;
export const TRACE_RETENTION_BATCH_SIZE: 500;
export const TRACE_RETENTION_MAX_BATCHES: 20;
export const TRACE_RETENTION_CATEGORIES: readonly [
  "USER_OPERATION_TRACE",
  "CLIENT_HTTP_TRACE",
  "WORKER_DETAIL",
  "WORKER_PARENT",
];

export type TraceRetentionCategory =
  (typeof TRACE_RETENTION_CATEGORIES)[number];

export type TraceRetentionCutoffs = {
  userOperationTraceKst: string;
  clientHttpTraceCreatedKst: string;
  workerDetailKst: string;
  workerParentKst: string;
};

export function traceRetentionCutoffs(
  referenceDate?: Date
): TraceRetentionCutoffs;
