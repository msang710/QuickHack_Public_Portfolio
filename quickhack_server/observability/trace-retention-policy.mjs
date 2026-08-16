export const TRACE_RETENTION_SHORT_DAYS = 14;
export const TRACE_RETENTION_WORKER_PARENT_DAYS = 90;
export const TRACE_RETENTION_BATCH_SIZE = 500;
export const TRACE_RETENTION_MAX_BATCHES = 20;

export const TRACE_RETENTION_CATEGORIES = [
  "USER_OPERATION_TRACE",
  "CLIENT_HTTP_TRACE",
  "WORKER_DETAIL",
  "WORKER_PARENT",
];

function kstSqlDateTime(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

export function traceRetentionCutoffs(referenceDate = new Date()) {
  const shortCutoff = new Date(
    referenceDate.getTime() -
      TRACE_RETENTION_SHORT_DAYS * 24 * 60 * 60 * 1_000
  );
  const workerParentCutoff = new Date(
    referenceDate.getTime() -
      TRACE_RETENTION_WORKER_PARENT_DAYS * 24 * 60 * 60 * 1_000
  );

  return {
    userOperationTraceKst: kstSqlDateTime(shortCutoff),
    clientHttpTraceCreatedKst: kstSqlDateTime(shortCutoff),
    workerDetailKst: kstSqlDateTime(shortCutoff),
    workerParentKst: kstSqlDateTime(workerParentCutoff),
  };
}
