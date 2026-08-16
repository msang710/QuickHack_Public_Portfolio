import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  findLatestCompleteStatisticsSnapshotBatch,
  readStatisticsSnapshotItem,
} from "@/quickhack_server/statistics/statistics-snapshot-store";
import type {
  StatisticsCalculationDelivery,
  StatisticsSnapshotFallbackReason,
} from "@/quickhack_shared/statistics/statistics";
import {
  DEFAULT_STATISTICS_LOOKBACK_DAYS,
  statisticsDateRangeDayCount,
  type StatisticsPeriodContext,
} from "@/quickhack_shared/statistics/statistics-period";
import type {
  StatisticsSnapshotData,
  StatisticsSnapshotDomain,
} from "@/quickhack_shared/statistics/statistics-snapshot";
import { requiredApiDate } from "@/quickhack_server/core/database/time-boundary";

type StatisticsReadClient = PrismaClient | Prisma.TransactionClient;

export type StatisticsReadDispatchResult<
  Domain extends StatisticsSnapshotDomain,
> = {
  data: StatisticsSnapshotData<Domain>;
  delivery: StatisticsCalculationDelivery;
  snapshotBatchId: number | null;
  snapshotCutoffLagDays: number | null;
};

function withDelivery<Domain extends StatisticsSnapshotDomain>(
  data: StatisticsSnapshotData<Domain>,
  delivery: StatisticsCalculationDelivery
): StatisticsSnapshotData<Domain> {
  return {
    ...data,
    calculation: {
      ...data.calculation,
      delivery,
    },
  };
}

function cutoffLagDays(snapshotCutoffDate: string, requestCutoffDate: string) {
  return (
    statisticsDateRangeDayCount({
      fromDate: snapshotCutoffDate,
      toDate: requestCutoffDate,
    }) - 1
  );
}

async function liveResult<Domain extends StatisticsSnapshotDomain>(input: {
  calculateLive: () => Promise<StatisticsSnapshotData<Domain>>;
  delivery: StatisticsCalculationDelivery;
  snapshotBatchId?: number | null;
  snapshotCutoffLagDays?: number | null;
}): Promise<StatisticsReadDispatchResult<Domain>> {
  const data = await input.calculateLive();

  return {
    data: withDelivery(data, input.delivery),
    delivery: input.delivery,
    snapshotBatchId: input.snapshotBatchId ?? null,
    snapshotCutoffLagDays: input.snapshotCutoffLagDays ?? null,
  };
}

async function fallbackLiveResult<
  Domain extends StatisticsSnapshotDomain,
>(input: {
  calculateLive: () => Promise<StatisticsSnapshotData<Domain>>;
  reason: StatisticsSnapshotFallbackReason;
  snapshotBatchId?: number | null;
  snapshotCutoffLagDays?: number | null;
}) {
  return liveResult({
    calculateLive: input.calculateLive,
    delivery: {
      status: "LIVE_FALLBACK",
      fallbackReason: input.reason,
    },
    snapshotBatchId: input.snapshotBatchId,
    snapshotCutoffLagDays: input.snapshotCutoffLagDays,
  });
}

export async function dispatchStatisticsRead<
  Domain extends StatisticsSnapshotDomain,
>(
  client: StatisticsReadClient,
  input: {
    domain: Domain;
    /**
     * null은 inventory의 호환용 period preset처럼 snapshot 대상이 아닌
     * 요청을 뜻합니다.
     */
    period: StatisticsPeriodContext | null;
    calculateLive: () => Promise<StatisticsSnapshotData<Domain>>;
  }
): Promise<StatisticsReadDispatchResult<Domain>> {
  if (!input.period?.isDefault) {
    return liveResult({
      calculateLive: input.calculateLive,
      delivery: {
        status: "LIVE_CUSTOM_PERIOD",
      },
    });
  }

  let snapshotBatchId: number | null = null;
  let snapshotCutoffLagDays: number | null = null;

  try {
    const batch = await findLatestCompleteStatisticsSnapshotBatch(client, {
      dataCutoffDate: input.period.dataCutoffDate,
    });

    if (!batch) {
      return fallbackLiveResult({
        calculateLive: input.calculateLive,
        reason: "NOT_FOUND",
      });
    }

    snapshotBatchId = batch.snapshot_batch_id;
    const snapshotCutoffDate = requiredApiDate(batch.data_cutoff_date);
    snapshotCutoffLagDays = cutoffLagDays(
      snapshotCutoffDate,
      input.period.dataCutoffDate
    );

    if (snapshotCutoffLagDays > 1) {
      return fallbackLiveResult({
        calculateLive: input.calculateLive,
        reason: "TOO_OLD",
        snapshotBatchId,
        snapshotCutoffLagDays,
      });
    }
    if (batch.day_count !== DEFAULT_STATISTICS_LOOKBACK_DAYS) {
      throw new Error(
        "The selected statistics snapshot is not the default 90-day result."
      );
    }

    const snapshot = await readStatisticsSnapshotItem(client, {
      snapshotBatchId,
      domain: input.domain,
    });
    const delivery: StatisticsCalculationDelivery = {
      status:
        snapshotCutoffLagDays === 0
          ? "SNAPSHOT_CURRENT"
          : "SNAPSHOT_DELAYED",
      snapshotCutoffDate,
      snapshotCutoffLagDays,
    };

    return {
      data: withDelivery(snapshot.data, delivery),
      delivery,
      snapshotBatchId,
      snapshotCutoffLagDays,
    };
  } catch {
    return fallbackLiveResult({
      calculateLive: input.calculateLive,
      reason: "INVALID",
      snapshotBatchId,
      snapshotCutoffLagDays,
    });
  }
}

export function statisticsReadDispatchTraceFields<
  Domain extends StatisticsSnapshotDomain,
>(result: StatisticsReadDispatchResult<Domain>) {
  return {
    "statistics.calculation_mode": result.data.calculation.mode,
    "statistics.delivery_status": result.delivery.status,
    "statistics.snapshot_batch_id": result.snapshotBatchId ?? "",
    "statistics.snapshot_cutoff_lag_days":
      result.snapshotCutoffLagDays ?? "",
    "statistics.snapshot_fallback_reason":
      result.delivery.status === "LIVE_FALLBACK"
        ? result.delivery.fallbackReason
        : "",
  };
}
