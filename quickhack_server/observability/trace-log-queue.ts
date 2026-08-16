import type { OperationTraceSnapshot } from "@/quickhack_server/observability/operation-trace";
import { runOutsideOperationTrace } from "@/quickhack_server/observability/operation-trace";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";

const MAX_QUEUE_SIZE = 500;
const FLUSH_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 60_000;
const queue: OperationTraceSnapshot[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushPromise: Promise<void> | null = null;
let droppedCount = 0;
let lastFailure: string | null = null;
let lastFlushedAt: string | null = null;
let consecutiveFailureCount = 0;
let shuttingDown = false;

function spanFields(snapshot: OperationTraceSnapshot) {
  return Object.entries(snapshot.spans).flatMap(([name, span]) => [
    { field_name: `span.${name}.count`, field_value: String(span.count) },
    { field_name: `span.${name}.total_ms`, field_value: String(span.totalMs) },
    { field_name: `span.${name}.max_ms`, field_value: String(span.maxMs) },
  ]);
}

export function operationTraceLogFields(snapshot: OperationTraceSnapshot) {
  const baseFields = [
    { field_name: "trace_id", field_value: snapshot.traceId },
    { field_name: "source", field_value: snapshot.source },
    { field_name: "route", field_value: snapshot.route ?? "" },
    { field_name: "method", field_value: snapshot.method ?? "" },
    {
      field_name: "target_count",
      field_value: snapshot.targetCount === null ? "" : String(snapshot.targetCount),
    },
    { field_name: "query.count", field_value: String(snapshot.query.count) },
    { field_name: "query.read_count", field_value: String(snapshot.query.readCount) },
    { field_name: "query.write_count", field_value: String(snapshot.query.writeCount) },
    { field_name: "query.total_ms", field_value: String(snapshot.query.totalMs) },
    { field_name: "query.max_ms", field_value: String(snapshot.query.maxMs) },
    { field_name: "transaction.count", field_value: String(snapshot.transaction.count) },
    { field_name: "transaction.wait_ms", field_value: String(snapshot.transaction.waitMs) },
    { field_name: "transaction.run_ms", field_value: String(snapshot.transaction.runMs) },
    { field_name: "transaction.total_ms", field_value: String(snapshot.transaction.totalMs) },
    { field_name: "transaction.max_ms", field_value: String(snapshot.transaction.maxMs) },
  ];
  const customFields = Object.entries(snapshot.fields).map(([name, value]) => ({
    field_name: `context.${name}`,
    field_value: value,
  }));

  return [...baseFields, ...spanFields(snapshot), ...customFields];
}

async function persistTrace(snapshot: OperationTraceSnapshot) {
  const { prisma } = await import("@/quickhack_server/core/prisma");
  const startedAt = databaseDateTime(snapshot.startedAt);
  const finishedAt = databaseDateTime(snapshot.finishedAt);
  const summary = [
    `total=${snapshot.durationMs}ms`,
    `queries=${snapshot.query.count}`,
    `queryTime=${snapshot.query.totalMs}ms`,
    `transactions=${snapshot.transaction.count}`,
    `transactionWait=${snapshot.transaction.waitMs}ms`,
    `transactionRun=${snapshot.transaction.runMs}ms`,
  ].join(" / ");

  await prisma.server_job_logs.create({
    data: {
      job_type: "USER_OPERATION_TRACE",
      job_name: snapshot.operationName,
      status: snapshot.status,
      triggered_by_user_id: snapshot.userId,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: snapshot.durationMs,
      summary_text: summary,
      summary_processed_count: snapshot.targetCount,
      summary_succeeded_count:
        snapshot.status === "SUCCESS" ? snapshot.targetCount : 0,
      summary_failed_count: snapshot.status === "FAILED" ? 1 : 0,
      error_code: snapshot.errorCode,
      error_message: snapshot.errorMessage,
      created_at: finishedAt,
      fields: { createMany: { data: operationTraceLogFields(snapshot) } },
    },
  });
}

function retryDelayMs() {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    1000 * 2 ** Math.min(consecutiveFailureCount, 6)
  );
}

function scheduleFlush(delayMs = FLUSH_DELAY_MS) {
  if (shuttingDown || flushTimer || flushPromise) return;

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushOperationTraceQueue();
  }, delayMs);
  flushTimer.unref?.();
}

export function enqueueOperationTrace(snapshot: OperationTraceSnapshot) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
    droppedCount += 1;
  }

  queue.push(snapshot);
  scheduleFlush();
}

export async function flushOperationTraceQueue() {
  if (flushPromise) return flushPromise;

  flushPromise = runOutsideOperationTrace(async () => {
    while (queue.length > 0) {
      const snapshot = queue[0];

      try {
        await persistTrace(snapshot);
        queue.shift();
        lastFailure = null;
        lastFlushedAt = new Date().toISOString();
        consecutiveFailureCount = 0;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
        consecutiveFailureCount += 1;
        break;
      }
    }
  }).finally(() => {
    flushPromise = null;
    if (queue.length > 0) scheduleFlush(retryDelayMs());
  });

  return flushPromise;
}

export async function flushOperationTraceQueueForShutdown() {
  shuttingDown = true;

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  await flushPromise?.catch(() => undefined);
  await flushOperationTraceQueue().catch(() => undefined);

  return getOperationTraceQueueState();
}

export function getOperationTraceQueueState() {
  return {
    pendingCount: queue.length,
    droppedCount,
    lastFailure,
    lastFlushedAt,
    consecutiveFailureCount,
    shuttingDown,
  };
}
