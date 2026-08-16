import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  LIFECYCLE_DAY_MS,
  defineLifecyclePolicy,
  lifecycleAgeMs,
  lifecycleCutoffExclusive,
  resolveLifecycleBatchSize,
} from "@/quickhack_shared/lifecycle/lifecycle-policy.mjs";

export const STATISTICS_COMPLETE_RETENTION_POLICY = defineLifecyclePolicy({
  retentionMs: 400 * LIFECYCLE_DAY_MS,
  maxBatchSize: 100,
});
export const STATISTICS_FAILED_RETENTION_POLICY = defineLifecyclePolicy({
  retentionMs: 0,
  graceMs: 7 * LIFECYCLE_DAY_MS,
  maxBatchSize: 100,
});

function eligibleWhere(
  completeCutoffExclusive: Date,
  failedCutoffExclusive: Date
): Prisma.statistics_snapshot_batchesWhereInput {
  return {
    OR: [
      {
        status: { in: ["COMPLETE", "SUPERSEDED"] },
        completed_at: { lt: completeCutoffExclusive },
      },
      {
        status: "FAILED",
        failed_at: { lt: failedCutoffExclusive },
      },
    ],
  };
}

export async function pruneStatisticsSnapshots(options: {
  now?: Date;
  dryRun?: boolean;
  maxBatchSize?: number;
} = {}) {
  const now = options.now ?? new Date();
  const completeCutoffExclusive = lifecycleCutoffExclusive(
    now,
    STATISTICS_COMPLETE_RETENTION_POLICY
  );
  const failedCutoffExclusive = lifecycleCutoffExclusive(
    now,
    STATISTICS_FAILED_RETENTION_POLICY,
    { useGrace: true }
  );
  const maxBatchSize = resolveLifecycleBatchSize(
    STATISTICS_COMPLETE_RETENTION_POLICY,
    options.maxBatchSize
  );
  const candidates = await prisma.statistics_snapshot_batches.findMany({
    where: eligibleWhere(completeCutoffExclusive, failedCutoffExclusive),
    orderBy: { snapshot_batch_id: "asc" },
    take: maxBatchSize,
    select: {
      snapshot_batch_id: true,
      status: true,
      completed_at: true,
      failed_at: true,
    },
  });

  let changedCount = 0;
  let skippedCount = 0;
  if (!options.dryRun) {
    await prisma.$transaction(async (tx) => {
      for (const candidate of candidates) {
        const deleted = await tx.statistics_snapshot_batches.deleteMany({
          where: {
            snapshot_batch_id: candidate.snapshot_batch_id,
            ...eligibleWhere(
              completeCutoffExclusive,
              failedCutoffExclusive
            ),
          },
        });
        if (deleted.count === 1) changedCount += 1;
        else skippedCount += 1;
      }
    });
  }

  const where = eligibleWhere(
    completeCutoffExclusive,
    failedCutoffExclusive
  );
  const [backlogCount, oldestCompleted, oldestFailed] = await Promise.all([
    prisma.statistics_snapshot_batches.count({ where }),
    prisma.statistics_snapshot_batches.aggregate({
      where: {
        status: { in: ["COMPLETE", "SUPERSEDED"] },
        completed_at: { lt: completeCutoffExclusive },
      },
      _min: { completed_at: true },
    }),
    prisma.statistics_snapshot_batches.aggregate({
      where: {
        status: "FAILED",
        failed_at: { lt: failedCutoffExclusive },
      },
      _min: { failed_at: true },
    }),
  ]);
  const timestamps = [
    oldestCompleted._min.completed_at,
    oldestFailed._min.failed_at,
  ].filter((value): value is Date => value instanceof Date);
  const oldest = timestamps.sort(
    (left, right) => left.getTime() - right.getTime()
  )[0];

  return {
    dryRun: Boolean(options.dryRun),
    completeCutoffExclusive,
    failedCutoffExclusive,
    maxBatchSize,
    attemptedCount: candidates.length,
    changedCount: options.dryRun ? 0 : changedCount,
    skippedCount: options.dryRun ? 0 : skippedCount,
    backlogCount,
    oldestEligibleAgeMs: oldest ? lifecycleAgeMs(now, oldest) : null,
  };
}

export type StatisticsSnapshotLifecycleSummary = Awaited<
  ReturnType<typeof pruneStatisticsSnapshots>
>;
