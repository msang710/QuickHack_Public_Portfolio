import { createHash } from "node:crypto";

import type {
  Prisma,
  PrismaClient,
  statistics_snapshot_batches,
  statistics_snapshot_items,
} from "@/generated/prisma/client";
import {
  databaseDate,
  databaseDateTime,
  databaseNow,
  requiredApiDate,
} from "@/quickhack_server/core/database/time-boundary";
import {
  assertStatisticsSnapshotBatchContract,
  assertStatisticsSnapshotEnvelope,
  createStatisticsSnapshotEnvelope,
  CURRENT_STATISTICS_CALCULATION_VERSION,
  CURRENT_STATISTICS_PAYLOAD_SCHEMA_VERSION,
  STATISTICS_SNAPSHOT_DOMAINS,
  type StatisticsSnapshotBatchContract,
  type StatisticsSnapshotData,
  type StatisticsSnapshotDomain,
  type StatisticsSnapshotEnvelope,
} from "@/quickhack_shared/statistics/statistics-snapshot";

export type StatisticsSnapshotStoreErrorCode =
  | "SNAPSHOT_BATCH_NOT_FOUND"
  | "SNAPSHOT_BATCH_NOT_BUILDING"
  | "SNAPSHOT_BATCH_INCOMPLETE"
  | "SNAPSHOT_BATCH_CONFLICT"
  | "SNAPSHOT_ITEM_NOT_FOUND"
  | "SNAPSHOT_ITEM_NOT_READABLE"
  | "SNAPSHOT_PAYLOAD_HASH_MISMATCH"
  | "SNAPSHOT_PAYLOAD_SIZE_MISMATCH"
  | "SNAPSHOT_PAYLOAD_JSON_INVALID";

export class StatisticsSnapshotStoreError extends Error {
  readonly code: StatisticsSnapshotStoreErrorCode;

  constructor(
    code: StatisticsSnapshotStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "StatisticsSnapshotStoreError";
    this.code = code;
  }
}

type StatisticsSnapshotReadClient =
  | PrismaClient
  | Prisma.TransactionClient;

export type CreateStatisticsSnapshotBatchInput =
  StatisticsSnapshotBatchContract & {
    workerJobId?: number | null;
    startedAt?: Date;
  };

export type PutStatisticsSnapshotItemInput<
  Domain extends StatisticsSnapshotDomain,
> = {
  snapshotBatchId: number;
  domain: Domain;
  data: StatisticsSnapshotData<Domain>;
  payloadSchemaVersion?: number;
};

export type ReadStatisticsSnapshotItemResult<
  Domain extends StatisticsSnapshotDomain,
> = {
  batch: statistics_snapshot_batches;
  item: statistics_snapshot_items;
  envelope: StatisticsSnapshotEnvelope<Domain>;
  data: StatisticsSnapshotData<Domain>;
};

function storeError(
  code: StatisticsSnapshotStoreErrorCode,
  message: string,
  cause?: unknown
): never {
  throw new StatisticsSnapshotStoreError(code, message, {
    cause,
  });
}

function batchContract(
  batch: Pick<
    statistics_snapshot_batches,
    | "data_cutoff_date"
    | "period_from"
    | "period_to"
    | "day_count"
    | "calculation_version"
  >
): StatisticsSnapshotBatchContract {
  return {
    dataCutoffDate: requiredApiDate(batch.data_cutoff_date),
    periodFrom: requiredApiDate(batch.period_from),
    periodTo: requiredApiDate(batch.period_to),
    dayCount: batch.day_count,
    calculationVersion: batch.calculation_version,
  };
}

function payloadHash(payloadText: string) {
  return createHash("sha256").update(payloadText, "utf8").digest("hex");
}

function assertCompleteDomainSet(domains: readonly string[]) {
  const actual = new Set(domains);
  const complete =
    actual.size === STATISTICS_SNAPSHOT_DOMAINS.length &&
    STATISTICS_SNAPSHOT_DOMAINS.every((domain) => actual.has(domain));

  if (!complete || domains.length !== STATISTICS_SNAPSHOT_DOMAINS.length) {
    storeError(
      "SNAPSHOT_BATCH_INCOMPLETE",
      "Snapshot batch must contain exactly one item for all four statistics domains."
    );
  }
}

export async function createStatisticsSnapshotBatch(
  client: StatisticsSnapshotReadClient,
  input: CreateStatisticsSnapshotBatchInput
) {
  assertStatisticsSnapshotBatchContract(input);
  const now = input.startedAt
    ? databaseDateTime(input.startedAt)
    : databaseNow();

  return client.statistics_snapshot_batches.create({
    data: {
      data_cutoff_date: databaseDate(input.dataCutoffDate),
      period_from: databaseDate(input.periodFrom),
      period_to: databaseDate(input.periodTo),
      day_count: input.dayCount,
      calculation_version: input.calculationVersion,
      status: "BUILDING",
      worker_job_id: input.workerJobId ?? null,
      started_at: now,
      created_at: now,
      updated_at: now,
    },
  });
}

export async function putStatisticsSnapshotItem<
  Domain extends StatisticsSnapshotDomain,
>(
  client: StatisticsSnapshotReadClient,
  input: PutStatisticsSnapshotItemInput<Domain>
) {
  const batch = await client.statistics_snapshot_batches.findUnique({
    where: {
      snapshot_batch_id: input.snapshotBatchId,
    },
  });

  if (!batch) {
    storeError(
      "SNAPSHOT_BATCH_NOT_FOUND",
      `Statistics snapshot batch ${input.snapshotBatchId} was not found.`
    );
  }
  if (batch.status !== "BUILDING") {
    storeError(
      "SNAPSHOT_BATCH_NOT_BUILDING",
      `Statistics snapshot batch ${input.snapshotBatchId} is not BUILDING.`
    );
  }

  const envelope = createStatisticsSnapshotEnvelope({
    domain: input.domain,
    data: input.data,
    batch: batchContract(batch),
    payloadSchemaVersion: input.payloadSchemaVersion,
  });
  const payloadText = JSON.stringify(envelope);
  const itemData = {
    payload_schema_version: envelope.payloadSchemaVersion,
    payload_text: payloadText,
    payload_hash: payloadHash(payloadText),
    payload_size_bytes: Buffer.byteLength(payloadText, "utf8"),
    generated_at: databaseDateTime(envelope.data.generatedAt),
  };

  return client.statistics_snapshot_items.upsert({
    where: {
      snapshot_batch_id_domain: {
        snapshot_batch_id: input.snapshotBatchId,
        domain: input.domain,
      },
    },
    create: {
      snapshot_batch_id: input.snapshotBatchId,
      domain: input.domain,
      ...itemData,
    },
    update: itemData,
  });
}

export async function completeStatisticsSnapshotBatch(
  client: PrismaClient,
  input: {
    snapshotBatchId: number;
    completedAt?: Date;
  }
) {
  const completedAt = input.completedAt
    ? databaseDateTime(input.completedAt)
    : databaseNow();

  try {
    return await client.$transaction(async (tx) => {
      const batch = await tx.statistics_snapshot_batches.findUnique({
        where: {
          snapshot_batch_id: input.snapshotBatchId,
        },
        include: {
          items: {
            select: {
              domain: true,
            },
          },
        },
      });

      if (!batch) {
        storeError(
          "SNAPSHOT_BATCH_NOT_FOUND",
          `Statistics snapshot batch ${input.snapshotBatchId} was not found.`
        );
      }
      if (batch.status !== "BUILDING") {
        storeError(
          "SNAPSHOT_BATCH_NOT_BUILDING",
          `Statistics snapshot batch ${input.snapshotBatchId} is not BUILDING.`
        );
      }

      assertCompleteDomainSet(batch.items.map((item) => item.domain));

      await tx.statistics_snapshot_batches.updateMany({
        where: {
          calculation_version: batch.calculation_version,
          data_cutoff_date: batch.data_cutoff_date,
          status: "COMPLETE",
          snapshot_batch_id: {
            not: batch.snapshot_batch_id,
          },
        },
        data: {
          status: "SUPERSEDED",
          updated_at: completedAt,
        },
      });

      return tx.statistics_snapshot_batches.update({
        where: {
          snapshot_batch_id: batch.snapshot_batch_id,
        },
        data: {
          status: "COMPLETE",
          completed_at: completedAt,
          updated_at: completedAt,
        },
      });
    });
  } catch (error) {
    if (
      error instanceof StatisticsSnapshotStoreError ||
      (error instanceof Error &&
        error.message.includes(
          "statistics snapshot batch requires all four domains"
        ))
    ) {
      throw error;
    }

    storeError(
      "SNAPSHOT_BATCH_CONFLICT",
      "Statistics snapshot batch could not be promoted atomically.",
      error
    );
  }
}

export async function failStatisticsSnapshotBatch(
  client: StatisticsSnapshotReadClient,
  input: {
    snapshotBatchId: number;
    errorCode: string;
    errorMessage?: string | null;
    failedAt?: Date;
  }
) {
  const failedAt = input.failedAt
    ? databaseDateTime(input.failedAt)
    : databaseNow();
  const result = await client.statistics_snapshot_batches.updateMany({
    where: {
      snapshot_batch_id: input.snapshotBatchId,
      status: "BUILDING",
    },
    data: {
      status: "FAILED",
      failed_at: failedAt,
      error_code: input.errorCode.trim() || "UNKNOWN",
      error_message: input.errorMessage?.trim() || null,
      updated_at: failedAt,
    },
  });

  if (result.count === 0) {
    const batch = await client.statistics_snapshot_batches.findUnique({
      where: {
        snapshot_batch_id: input.snapshotBatchId,
      },
      select: {
        status: true,
      },
    });

    if (!batch) {
      storeError(
        "SNAPSHOT_BATCH_NOT_FOUND",
        `Statistics snapshot batch ${input.snapshotBatchId} was not found.`
      );
    }

    storeError(
      "SNAPSHOT_BATCH_NOT_BUILDING",
      `Statistics snapshot batch ${input.snapshotBatchId} is ${batch.status}.`
    );
  }

  return client.statistics_snapshot_batches.findUniqueOrThrow({
    where: {
      snapshot_batch_id: input.snapshotBatchId,
    },
  });
}

export async function failInterruptedStatisticsSnapshotBatches(
  client: StatisticsSnapshotReadClient,
  input: {
    workerJobId: number;
    errorCode: string;
    errorMessage?: string | null;
    failedAt?: Date;
    excludeSnapshotBatchId?: number;
  }
) {
  const failedAt = input.failedAt
    ? databaseDateTime(input.failedAt)
    : databaseNow();

  return client.statistics_snapshot_batches.updateMany({
    where: {
      worker_job_id: input.workerJobId,
      status: "BUILDING",
      ...(input.excludeSnapshotBatchId
        ? {
            snapshot_batch_id: {
              not: input.excludeSnapshotBatchId,
            },
          }
        : {}),
    },
    data: {
      status: "FAILED",
      failed_at: failedAt,
      error_code: input.errorCode.trim() || "UNKNOWN",
      error_message: input.errorMessage?.trim() || null,
      updated_at: failedAt,
    },
  });
}

export async function findCompleteStatisticsSnapshotBatchForCutoff(
  client: StatisticsSnapshotReadClient,
  input: {
    dataCutoffDate: string;
    calculationVersion?: string;
  }
) {
  return client.statistics_snapshot_batches.findFirst({
    where: {
      status: "COMPLETE",
      data_cutoff_date: databaseDate(input.dataCutoffDate),
      calculation_version:
        input.calculationVersion ??
        CURRENT_STATISTICS_CALCULATION_VERSION,
    },
    orderBy: [
      {
        completed_at: "desc",
      },
      {
        snapshot_batch_id: "desc",
      },
    ],
  });
}

export async function findLatestCompleteStatisticsSnapshotBatch(
  client: StatisticsSnapshotReadClient,
  input: {
    calculationVersion?: string;
    dataCutoffDate?: string;
  } = {}
) {
  return client.statistics_snapshot_batches.findFirst({
    where: {
      status: "COMPLETE",
      calculation_version:
        input.calculationVersion ??
        CURRENT_STATISTICS_CALCULATION_VERSION,
      ...(input.dataCutoffDate
        ? {
            data_cutoff_date: {
              lte: databaseDate(input.dataCutoffDate),
            },
          }
        : {}),
    },
    orderBy: [
      {
        data_cutoff_date: "desc",
      },
      {
        completed_at: "desc",
      },
      {
        snapshot_batch_id: "desc",
      },
    ],
  });
}

export async function readStatisticsSnapshotItem<
  Domain extends StatisticsSnapshotDomain,
>(
  client: StatisticsSnapshotReadClient,
  input: {
    snapshotBatchId: number;
    domain: Domain;
    payloadSchemaVersion?: number;
  }
): Promise<ReadStatisticsSnapshotItemResult<Domain>> {
  const item = await client.statistics_snapshot_items.findUnique({
    where: {
      snapshot_batch_id_domain: {
        snapshot_batch_id: input.snapshotBatchId,
        domain: input.domain,
      },
    },
    include: {
      batch: true,
    },
  });

  if (!item) {
    storeError(
      "SNAPSHOT_ITEM_NOT_FOUND",
      `Statistics snapshot item ${input.snapshotBatchId}/${input.domain} was not found.`
    );
  }
  // A same-cutoff rerun can supersede a batch after a reader selected it.
  // SUPERSEDED items remain immutable and are still valid for that read.
  if (
    item.batch.status !== "COMPLETE" &&
    item.batch.status !== "SUPERSEDED"
  ) {
    storeError(
      "SNAPSHOT_ITEM_NOT_READABLE",
      `Statistics snapshot batch ${input.snapshotBatchId} is not a completed immutable result.`
    );
  }

  const actualSize = Buffer.byteLength(item.payload_text, "utf8");
  if (actualSize !== item.payload_size_bytes) {
    storeError(
      "SNAPSHOT_PAYLOAD_SIZE_MISMATCH",
      `Statistics snapshot item ${item.snapshot_item_id} has an invalid byte size.`
    );
  }
  if (payloadHash(item.payload_text) !== item.payload_hash) {
    storeError(
      "SNAPSHOT_PAYLOAD_HASH_MISMATCH",
      `Statistics snapshot item ${item.snapshot_item_id} failed its SHA-256 check.`
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(item.payload_text);
  } catch (error) {
    storeError(
      "SNAPSHOT_PAYLOAD_JSON_INVALID",
      `Statistics snapshot item ${item.snapshot_item_id} contains invalid JSON.`,
      error
    );
  }

  assertStatisticsSnapshotEnvelope(envelope, {
    domain: input.domain,
    batch: batchContract(item.batch),
    payloadSchemaVersion:
      input.payloadSchemaVersion ??
      CURRENT_STATISTICS_PAYLOAD_SCHEMA_VERSION,
  });

  const typedEnvelope =
    envelope as StatisticsSnapshotEnvelope<Domain>;

  return {
    batch: item.batch,
    item,
    envelope: typedEnvelope,
    data: typedEnvelope.data,
  };
}
