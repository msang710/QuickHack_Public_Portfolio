import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { nowKstSqlDateTime } from "@/quickhack_shared/core/time";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import {
  formatQuickHackServerTiming,
  QUICKHACK_TRACE_ID_HEADER,
  QUICKHACK_TRACE_RECORDED_HEADER,
  SERVER_TIMING_HEADER,
} from "@/quickhack_shared/observability/http-trace";

const PRODUCTION_TRACE_SAMPLE_RATE = 0.1;

export type OperationTraceSource = "HTTP" | "WORKER" | "SERVICE";

export type OperationTraceInput = {
  operationName: string;
  source?: OperationTraceSource;
  route?: string | null;
  method?: string | null;
  targetCount?: number | null;
  userId?: number | null;
  persist?: boolean;
  onComplete?: (snapshot: OperationTraceSnapshot) => void | Promise<void>;
};

type SpanAggregate = {
  count: number;
  totalMs: number;
  maxMs: number;
};

type QueryAggregate = {
  count: number;
  readCount: number;
  writeCount: number;
  totalMs: number;
  maxMs: number;
};

type TransactionAggregate = {
  count: number;
  waitMs: number;
  runMs: number;
  totalMs: number;
  maxMs: number;
};

type OperationTraceContext = {
  traceId: string;
  operationName: string;
  source: OperationTraceSource;
  route: string | null;
  method: string | null;
  targetCount: number | null;
  userId: number | null;
  startedAt: string;
  startedPerformanceMs: number;
  spans: Map<string, SpanAggregate>;
  query: QueryAggregate;
  transaction: TransactionAggregate;
  fields: Map<string, string>;
  failure: { code: string | null; message: string | null } | null;
};

export type OperationTraceSnapshot = {
  traceId: string;
  operationName: string;
  source: OperationTraceSource;
  route: string | null;
  method: string | null;
  targetCount: number | null;
  userId: number | null;
  status: "SUCCESS" | "FAILED";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  spans: Record<string, SpanAggregate>;
  query: QueryAggregate;
  transaction: TransactionAggregate;
  fields: Record<string, string>;
  errorCode: string | null;
  errorMessage: string | null;
};

const operationTraceStorage = new AsyncLocalStorage<OperationTraceContext>();
const READ_QUERY_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "aggregate",
  "count",
  "groupBy",
  "$queryRaw",
  "$queryRawUnsafe",
]);

function roundedMs(value: number) {
  return Math.max(0, Math.round(value));
}

function safeFieldName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);
}

function safeFieldValue(value: unknown) {
  return String(value ?? "")
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+(@)/gi,
      "$1[REDACTED]$2"
    )
    .replace(
      /(authorization|access[_-]?key|secret[_-]?key|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 1000);
}

function errorSnapshot(error: unknown) {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : error.name || "ERROR";

    return {
      code: safeFieldValue(code).slice(0, 120) || "ERROR",
      message: safeFieldValue(error.message),
    };
  }

  return { code: "ERROR", message: safeFieldValue(error) };
}

function recordSpanDuration(
  context: OperationTraceContext,
  name: string,
  durationMs: number
) {
  const normalizedName = safeFieldName(name);
  const previous = context.spans.get(normalizedName) ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
  };
  const duration = roundedMs(durationMs);

  context.spans.set(normalizedName, {
    count: previous.count + 1,
    totalMs: previous.totalMs + duration,
    maxMs: Math.max(previous.maxMs, duration),
  });
}

function responseFailure(result: unknown) {
  if (
    result &&
    typeof result === "object" &&
    "status" in result &&
    typeof result.status === "number" &&
    result.status >= 400
  ) {
    return {
      code: `HTTP_${result.status}`,
      message: `HTTP response status ${result.status}`,
    };
  }

  return null;
}

function createContext(input: OperationTraceInput): OperationTraceContext {
  const runtime = runtimeConfigService.read();

  return {
    traceId: randomUUID(),
    operationName: safeFieldName(input.operationName) || "unknown-operation",
    source: input.source ?? "SERVICE",
    route: input.route ? safeFieldValue(input.route) : null,
    method: input.method ? safeFieldValue(input.method).toUpperCase() : null,
    targetCount:
      typeof input.targetCount === "number" && Number.isFinite(input.targetCount)
        ? Math.max(0, Math.trunc(input.targetCount))
        : null,
    userId: input.userId ?? null,
    startedAt: nowKstSqlDateTime(),
    startedPerformanceMs: performance.now(),
    spans: new Map(),
    query: { count: 0, readCount: 0, writeCount: 0, totalMs: 0, maxMs: 0 },
    transaction: { count: 0, waitMs: 0, runMs: 0, totalMs: 0, maxMs: 0 },
    fields: new Map([
      ["runtime.environment", runtime.environment],
      ["runtime.role", runtime.role],
      ["runtime.database_provider", runtime.database.provider],
      ["runtime.coupang_api_mode", runtime.endpoints.coupang.mode],
    ]),
    failure: null,
  };
}

function shouldPersistSnapshot(snapshot: OperationTraceSnapshot) {
  if (!runtimeConfigService.isProduction()) return true;
  if (snapshot.status === "FAILED" || snapshot.durationMs >= 1000) return true;

  return Math.random() < PRODUCTION_TRACE_SAMPLE_RATE;
}

function snapshotContext(context: OperationTraceContext): OperationTraceSnapshot {
  const failure = context.failure;

  return {
    traceId: context.traceId,
    operationName: context.operationName,
    source: context.source,
    route: context.route,
    method: context.method,
    targetCount: context.targetCount,
    userId: context.userId,
    status: failure ? "FAILED" : "SUCCESS",
    startedAt: context.startedAt,
    finishedAt: nowKstSqlDateTime(),
    durationMs: roundedMs(performance.now() - context.startedPerformanceMs),
    spans: Object.fromEntries(context.spans.entries()),
    query: { ...context.query },
    transaction: { ...context.transaction },
    fields: Object.fromEntries(context.fields.entries()),
    errorCode: failure?.code ?? null,
    errorMessage: failure?.message ?? null,
  };
}

export function operationTraceResponseHeaders(
  snapshot: OperationTraceSnapshot,
  recorded: boolean
) {
  const authMs = snapshot.spans.AUTH?.totalMs ?? 0;
  const serviceMs =
    (snapshot.spans.SERVICE_READ?.totalMs ?? 0) +
    (snapshot.spans.SERVICE_WRITE?.totalMs ?? 0);

  return {
    [QUICKHACK_TRACE_ID_HEADER]: snapshot.traceId,
    [QUICKHACK_TRACE_RECORDED_HEADER]: recorded ? "1" : "0",
    [SERVER_TIMING_HEADER]: formatQuickHackServerTiming({
      qh: snapshot.durationMs,
      "qh-auth": authMs,
      "qh-service": serviceMs,
      "qh-db-sum": snapshot.query.totalMs,
      "qh-db-max": snapshot.query.maxMs,
      "qh-tx-enter": snapshot.transaction.waitMs,
      "qh-tx-run": snapshot.transaction.runMs,
    }),
  };
}

function attachOperationTraceHeaders(
  result: unknown,
  snapshot: OperationTraceSnapshot,
  recorded: boolean
) {
  if (!(result instanceof Response)) return;

  try {
    const headers = operationTraceResponseHeaders(snapshot, recorded);

    for (const [name, value] of Object.entries(headers)) {
      result.headers.set(name, value);
    }
  } catch {
    // Immutable or custom responses must still complete normally.
  }
}

export function setOperationTraceUserId(userId: number | null | undefined) {
  const context = operationTraceStorage.getStore();

  if (context && typeof userId === "number" && Number.isFinite(userId)) {
    context.userId = Math.trunc(userId);
  }
}

export function getOperationTraceId() {
  return operationTraceStorage.getStore()?.traceId ?? null;
}

export function setOperationTraceTargetCount(count: number | null | undefined) {
  const context = operationTraceStorage.getStore();

  if (context && typeof count === "number" && Number.isFinite(count)) {
    context.targetCount = Math.max(0, Math.trunc(count));
  }
}

export function setOperationTraceField(name: string, value: unknown) {
  const context = operationTraceStorage.getStore();
  const normalizedName = safeFieldName(name);

  if (context && normalizedName) {
    context.fields.set(normalizedName, safeFieldValue(value));
  }
}

export function markOperationTraceFailed(error: unknown, code?: string) {
  const context = operationTraceStorage.getStore();

  if (!context) return;
  const failure = errorSnapshot(error);
  context.failure = {
    code: code ? safeFieldValue(code).slice(0, 120) : failure.code,
    message: failure.message,
  };
}

export async function traceOperationSpan<T>(
  name: string,
  work: () => T | Promise<T>
) {
  const context = operationTraceStorage.getStore();

  if (!context) return work();
  const startedAt = performance.now();

  try {
    return await work();
  } finally {
    recordSpanDuration(context, name, performance.now() - startedAt);
  }
}

export function traceOperationSpanSync<T>(name: string, work: () => T) {
  const context = operationTraceStorage.getStore();

  if (!context) return work();
  const startedAt = performance.now();

  try {
    return work();
  } finally {
    recordSpanDuration(context, name, performance.now() - startedAt);
  }
}

export function recordOperationQuery(operation: string, durationMs: number) {
  const context = operationTraceStorage.getStore();

  if (!context) return;
  const duration = roundedMs(durationMs);
  context.query.count += 1;
  context.query.totalMs += duration;
  context.query.maxMs = Math.max(context.query.maxMs, duration);

  if (READ_QUERY_OPERATIONS.has(operation)) context.query.readCount += 1;
  else context.query.writeCount += 1;
}

export function recordOperationTransaction(input: {
  waitMs: number;
  runMs: number;
  totalMs: number;
}) {
  const context = operationTraceStorage.getStore();

  if (!context) return;
  const waitMs = roundedMs(input.waitMs);
  const runMs = roundedMs(input.runMs);
  const totalMs = roundedMs(input.totalMs);
  context.transaction.count += 1;
  context.transaction.waitMs += waitMs;
  context.transaction.runMs += runMs;
  context.transaction.totalMs += totalMs;
  context.transaction.maxMs = Math.max(context.transaction.maxMs, totalMs);
}

export function runOutsideOperationTrace<T>(work: () => T) {
  return operationTraceStorage.exit(work);
}

export async function runOperationTrace<T>(
  input: OperationTraceInput,
  work: () => T | Promise<T>
): Promise<T> {
  if (operationTraceStorage.getStore()) {
    return traceOperationSpan(`operation.${input.operationName}`, work);
  }

  const context = createContext(input);

  return operationTraceStorage.run(context, async () => {
    let snapshot: OperationTraceSnapshot | null = null;
    let recorded = false;
    let persistenceDecided = false;

    try {
      const result = await work();
      const failure = responseFailure(result);
      if (failure && !context.failure) context.failure = failure;
      snapshot = snapshotContext(context);
      recorded = input.persist !== false && shouldPersistSnapshot(snapshot);
      persistenceDecided = true;
      attachOperationTraceHeaders(result, snapshot, recorded);
      return result;
    } catch (error) {
      markOperationTraceFailed(error);
      throw error;
    } finally {
      snapshot ??= snapshotContext(context);

      if (!persistenceDecided) {
        recorded = input.persist !== false && shouldPersistSnapshot(snapshot);
        persistenceDecided = true;
      }

      if (input.onComplete) {
        try {
          await input.onComplete(snapshot);
        } catch {
          // Observability callbacks must never change the business result.
        }
      }

      if (recorded) {
        try {
          const { enqueueOperationTrace } = await import(
            "@/quickhack_server/observability/trace-log-queue"
          );
          enqueueOperationTrace(snapshot);
        } catch {
          // Trace persistence is best-effort and must not fail the operation.
        }
      }
    }
  });
}
