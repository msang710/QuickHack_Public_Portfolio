import { performance } from "node:perf_hooks";

import { prisma } from "@/quickhack_server/core/prisma";
import { getInventoryStatisticsData } from "@/quickhack_server/statistics/inventory-statistics-service";
import { getPurchaseStatisticsData } from "@/quickhack_server/statistics/purchase-statistics-service";
import { getReturnStatisticsData } from "@/quickhack_server/statistics/return-statistics-service";
import { getSalesStatisticsData } from "@/quickhack_server/statistics/sales-statistics-service";
import {
  completeStatisticsSnapshotBatch,
  createStatisticsSnapshotBatch,
  failInterruptedStatisticsSnapshotBatches,
  failStatisticsSnapshotBatch,
  findCompleteStatisticsSnapshotBatchForCutoff,
  putStatisticsSnapshotItem,
} from "@/quickhack_server/statistics/statistics-snapshot-store";
import type { WorkerRunContext } from "@/quickhack_server/workers/types";
import { quickHackClock } from "@/quickhack_shared/core/time";
import {
  CURRENT_STATISTICS_CALCULATION_VERSION,
  type StatisticsSnapshotDataByDomain,
  type StatisticsSnapshotDomain,
} from "@/quickhack_shared/statistics/statistics-snapshot";
import { resolveClosedStatisticsPeriod } from "@/quickhack_shared/statistics/statistics-period";

const STATISTICS_SNAPSHOT_TOTAL_DOMAINS = 4;
const STATISTICS_SNAPSHOT_ERROR_MESSAGE_LIMIT = 1_000;

export type StatisticsSnapshotCalculators = {
  [Domain in StatisticsSnapshotDomain]: () => Promise<
    StatisticsSnapshotDataByDomain[Domain]
  >;
};

export type StatisticsSnapshotWorkerDomainSummary = {
  domain: StatisticsSnapshotDomain;
  durationMs: number;
  payloadSizeBytes: number;
};

export type StatisticsSnapshotWorkerSummary = {
  dataCutoffDate: string;
  periodFrom: string;
  periodTo: string;
  dayCount: number;
  snapshotBatchId: number | null;
  processedCount: number;
  completedDomainCount: number;
  payloadSizeBytes: number;
  recoveredBuildingBatchCount: number;
  skippedCount: number;
  createdCount: number;
  skipReason: string | null;
  totalDurationMs: number;
  domains: StatisticsSnapshotWorkerDomainSummary[];
};

function safeErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  return message.slice(0, STATISTICS_SNAPSHOT_ERROR_MESSAGE_LIMIT);
}

async function yieldToServerLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function defaultCalculators(
  now: Date,
  period: ReturnType<typeof resolveClosedStatisticsPeriod>
): StatisticsSnapshotCalculators {
  return {
    PURCHASE: () =>
      getPurchaseStatisticsData(prisma, {
        now,
        period,
      }),
    INVENTORY: () =>
      getInventoryStatisticsData(prisma, {
        now,
        periodContext: period,
      }),
    SALES: () =>
      getSalesStatisticsData(prisma, {
        now,
        period,
      }),
    RETURNS: () =>
      getReturnStatisticsData(prisma, {
        now,
        period,
      }),
  };
}

export async function runDailyStatisticsSnapshot(input: {
  context: WorkerRunContext;
  now?: Date;
  calculators?: Partial<StatisticsSnapshotCalculators>;
}): Promise<StatisticsSnapshotWorkerSummary> {
  const startedAtMs = performance.now();
  const now = input.now ?? quickHackClock.nowDate();
  const period = resolveClosedStatisticsPeriod({ now });
  const baseCalculators = defaultCalculators(now, period);
  const calculators: StatisticsSnapshotCalculators = {
    ...baseCalculators,
    ...input.calculators,
  };
  const domainSummaries: StatisticsSnapshotWorkerDomainSummary[] = [];
  let snapshotBatchId: number | null = null;
  let payloadSizeBytes = 0;

  await input.context.assertLeaseActive();

  const recovered = await failInterruptedStatisticsSnapshotBatches(prisma, {
    workerJobId: input.context.workerJobId,
    errorCode: "STATISTICS_SNAPSHOT_INTERRUPTED",
    errorMessage:
      "A previous snapshot build was interrupted before it completed.",
    failedAt: now,
  });

  await input.context.assertLeaseActive();

  const existing =
    await findCompleteStatisticsSnapshotBatchForCutoff(prisma, {
      dataCutoffDate: period.dataCutoffDate,
    });

  if (input.context.triggeredBy === null && existing) {
    await input.context.updateProgress(
      STATISTICS_SNAPSHOT_TOTAL_DOMAINS,
      STATISTICS_SNAPSHOT_TOTAL_DOMAINS
    );

    return {
      dataCutoffDate: period.dataCutoffDate,
      periodFrom: period.range.fromDate,
      periodTo: period.range.toDate,
      dayCount: period.dayCount,
      snapshotBatchId: existing.snapshot_batch_id,
      processedCount: 0,
      completedDomainCount: STATISTICS_SNAPSHOT_TOTAL_DOMAINS,
      payloadSizeBytes: 0,
      recoveredBuildingBatchCount: recovered.count,
      skippedCount: 1,
      createdCount: 0,
      skipReason: "COMPLETE_SNAPSHOT_ALREADY_EXISTS",
      totalDurationMs: Math.round(performance.now() - startedAtMs),
      domains: [],
    };
  }

  try {
    const batch = await createStatisticsSnapshotBatch(prisma, {
      dataCutoffDate: period.dataCutoffDate,
      periodFrom: period.range.fromDate,
      periodTo: period.range.toDate,
      dayCount: period.dayCount,
      calculationVersion: CURRENT_STATISTICS_CALCULATION_VERSION,
      workerJobId: input.context.workerJobId,
      startedAt: now,
    });
    snapshotBatchId = batch.snapshot_batch_id;

    async function calculateAndStore<
      Domain extends StatisticsSnapshotDomain,
    >(domain: Domain, calculate: StatisticsSnapshotCalculators[Domain]) {
      await input.context.assertLeaseActive();
      const domainStartedAtMs = performance.now();
      const data = await calculate();
      await input.context.assertLeaseActive();
      const item = await putStatisticsSnapshotItem(prisma, {
        snapshotBatchId: batch.snapshot_batch_id,
        domain,
        data,
      });
      const durationMs = Math.round(performance.now() - domainStartedAtMs);

      payloadSizeBytes += item.payload_size_bytes;
      domainSummaries.push({
        domain,
        durationMs,
        payloadSizeBytes: item.payload_size_bytes,
      });
      await input.context.updateProgress(
        domainSummaries.length,
        STATISTICS_SNAPSHOT_TOTAL_DOMAINS
      );
      await yieldToServerLoop();
    }

    await calculateAndStore("PURCHASE", calculators.PURCHASE);
    await calculateAndStore("INVENTORY", calculators.INVENTORY);
    await calculateAndStore("SALES", calculators.SALES);
    await calculateAndStore("RETURNS", calculators.RETURNS);

    await input.context.assertLeaseActive();
    await completeStatisticsSnapshotBatch(prisma, {
      snapshotBatchId: batch.snapshot_batch_id,
      completedAt: now,
    });

    return {
      dataCutoffDate: period.dataCutoffDate,
      periodFrom: period.range.fromDate,
      periodTo: period.range.toDate,
      dayCount: period.dayCount,
      snapshotBatchId: batch.snapshot_batch_id,
      processedCount: domainSummaries.length,
      completedDomainCount: domainSummaries.length,
      payloadSizeBytes,
      recoveredBuildingBatchCount: recovered.count,
      skippedCount: 0,
      createdCount: 1,
      skipReason: null,
      totalDurationMs: Math.round(performance.now() - startedAtMs),
      domains: domainSummaries,
    };
  } catch (error) {
    if (snapshotBatchId !== null && !input.context.signal.aborted) {
      try {
        await failStatisticsSnapshotBatch(prisma, {
          snapshotBatchId,
          errorCode: "STATISTICS_SNAPSHOT_BUILD_FAILED",
          errorMessage: safeErrorMessage(error),
          failedAt: now,
        });
      } catch {
        // Preserve the original calculation or lease error.
      }
    }

    throw error;
  }
}
