import { prisma } from "@/quickhack_server/core/prisma";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";
import {
  TRACE_RETENTION_BATCH_SIZE,
  TRACE_RETENTION_CATEGORIES,
  TRACE_RETENTION_MAX_BATCHES,
  traceRetentionCutoffs,
  type TraceRetentionCategory,
  type TraceRetentionCutoffs,
} from "@/quickhack_server/observability/trace-retention-policy.mjs";

type TraceRetentionContext = {
  assertLeaseActive: () => Promise<void>;
  updateProgress: (current: number, total?: number | null) => Promise<void>;
};

type TraceRetentionCounts = Record<TraceRetentionCategory, number>;

function emptyCounts(): TraceRetentionCounts {
  return {
    USER_OPERATION_TRACE: 0,
    CLIENT_HTTP_TRACE: 0,
    WORKER_DETAIL: 0,
    WORKER_PARENT: 0,
  };
}

async function candidateIds(
  category: TraceRetentionCategory,
  cutoffs: TraceRetentionCutoffs,
  take: number
) {
  if (category === "USER_OPERATION_TRACE") {
    return (
      await prisma.server_job_logs.findMany({
        where: {
          job_type: "USER_OPERATION_TRACE",
          started_at: { lt: databaseDateTime(cutoffs.userOperationTraceKst) },
        },
        orderBy: [{ started_at: "asc" }, { id: "asc" }],
        take,
        select: { id: true },
      })
    ).map((row) => row.id);
  }

  if (category === "CLIENT_HTTP_TRACE") {
    return (
      await prisma.client_http_trace_observations.findMany({
        where: {
          created_at: {
            lt: databaseDateTime(cutoffs.clientHttpTraceCreatedKst),
          },
        },
        orderBy: [
          { created_at: "asc" },
          { client_http_trace_observation_id: "asc" },
        ],
        take,
        select: { client_http_trace_observation_id: true },
      })
    ).map((row) => row.client_http_trace_observation_id);
  }

  if (category === "WORKER_DETAIL") {
    return (
      await prisma.server_job_log_fields.findMany({
        where: {
          server_job_log: {
            job_type: { startsWith: "WORKER_" },
            started_at: { lt: databaseDateTime(cutoffs.workerDetailKst) },
          },
        },
        orderBy: [
          { server_job_log_id: "asc" },
          { server_job_log_field_id: "asc" },
        ],
        take,
        select: { server_job_log_field_id: true },
      })
    ).map((row) => row.server_job_log_field_id);
  }

  return (
    await prisma.server_job_logs.findMany({
      where: {
        job_type: { startsWith: "WORKER_" },
        started_at: { lt: databaseDateTime(cutoffs.workerParentKst) },
      },
      orderBy: [{ started_at: "asc" }, { id: "asc" }],
      take,
      select: { id: true },
    })
  ).map((row) => row.id);
}

async function deleteCandidateIds(
  category: TraceRetentionCategory,
  ids: number[]
) {
  if (ids.length === 0) {
    return 0;
  }

  if (category === "CLIENT_HTTP_TRACE") {
    return (
      await prisma.client_http_trace_observations.deleteMany({
        where: { client_http_trace_observation_id: { in: ids } },
      })
    ).count;
  }

  if (category === "WORKER_DETAIL") {
    return (
      await prisma.server_job_log_fields.deleteMany({
        where: { server_job_log_field_id: { in: ids } },
      })
    ).count;
  }

  return (
    await prisma.server_job_logs.deleteMany({
      where: { id: { in: ids } },
    })
  ).count;
}

export async function runObservabilityTraceRetention(input: {
  context: TraceRetentionContext;
  referenceDate?: Date;
  batchSize?: number;
  maxBatches?: number;
}) {
  const cutoffs = traceRetentionCutoffs(input.referenceDate ?? new Date());
  const batchSize = Math.max(
    1,
    Math.trunc(input.batchSize ?? TRACE_RETENTION_BATCH_SIZE)
  );
  const maxBatches = Math.max(
    1,
    Math.trunc(input.maxBatches ?? TRACE_RETENTION_MAX_BATCHES)
  );
  const deletedByCategory = emptyCounts();
  const exhausted = new Set<TraceRetentionCategory>();
  let deletedCount = 0;
  let batchCount = 0;

  while (
    batchCount < maxBatches &&
    exhausted.size < TRACE_RETENTION_CATEGORIES.length
  ) {
    for (const category of TRACE_RETENTION_CATEGORIES) {
      if (batchCount >= maxBatches || exhausted.has(category)) {
        continue;
      }

      await input.context.assertLeaseActive();
      const ids = await candidateIds(category, cutoffs, batchSize);

      if (ids.length === 0) {
        exhausted.add(category);
        continue;
      }

      const deleted = await deleteCandidateIds(category, ids);
      deletedByCategory[category] += deleted;
      deletedCount += deleted;
      batchCount += 1;
      await input.context.updateProgress(
        deletedCount,
        batchSize * maxBatches
      );

      if (ids.length < batchSize) {
        exhausted.add(category);
      }
    }
  }

  const backlogCategories: TraceRetentionCategory[] = [];
  for (const category of TRACE_RETENTION_CATEGORIES) {
    if ((await candidateIds(category, cutoffs, 1)).length > 0) {
      backlogCategories.push(category);
    }
  }
  const warningCount = backlogCategories.length;
  const summaryText =
    warningCount > 0
      ? `만료 trace ${deletedCount}건 정리, 잔여 분류 ${warningCount}개`
      : `만료 trace ${deletedCount}건 정리, 잔여 backlog 없음`;

  return {
    summaryText,
    processedCount: deletedCount,
    deletedCount,
    batchCount,
    warningCount,
    backlog: warningCount > 0,
    backlogCategories,
    deletedByCategory,
    cutoffs,
  };
}
