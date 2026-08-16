import type {
  InventoryStatisticsData,
  PurchaseStatisticsData,
  ReturnStatisticsData,
  SalesStatisticsData,
  StatisticsCalculationMetadata,
} from "@/quickhack_shared/statistics/statistics";
import {
  normalizeStatisticsDate,
  statisticsDateRangeDayCount,
} from "@/quickhack_shared/statistics/statistics-period";
import { assertStatisticsSnapshotDomainData } from "@/quickhack_shared/statistics/statistics-snapshot-payload-validator";
import { StatisticsRuntimeSchemaError } from "@/quickhack_shared/statistics/statistics-runtime-schema";

export const STATISTICS_SNAPSHOT_DOMAINS = [
  "PURCHASE",
  "INVENTORY",
  "SALES",
  "RETURNS",
] as const;

export type StatisticsSnapshotDomain =
  (typeof STATISTICS_SNAPSHOT_DOMAINS)[number];

export const CURRENT_STATISTICS_CALCULATION_VERSION =
  "statistics-daily-v2";
export const CURRENT_STATISTICS_PAYLOAD_SCHEMA_VERSION = 2;

export type StatisticsSnapshotBatchContract = {
  dataCutoffDate: string;
  periodFrom: string;
  periodTo: string;
  dayCount: number;
  calculationVersion: string;
};

export type StatisticsSnapshotDataByDomain = {
  PURCHASE: PurchaseStatisticsData;
  INVENTORY: InventoryStatisticsData;
  SALES: SalesStatisticsData;
  RETURNS: ReturnStatisticsData;
};

export type StatisticsSnapshotData<
  Domain extends StatisticsSnapshotDomain,
> = StatisticsSnapshotDataByDomain[Domain];

export type StatisticsSnapshotEnvelope<
  Domain extends StatisticsSnapshotDomain = StatisticsSnapshotDomain,
> = {
  domain: Domain;
  calculationVersion: string;
  payloadSchemaVersion: number;
  dataCutoffDate: string;
  period: {
    fromDate: string;
    toDate: string;
    dayCount: number;
  };
  data: StatisticsSnapshotData<Domain>;
};

export type StatisticsSnapshotContractErrorCode =
  | "SNAPSHOT_INVALID_DOMAIN"
  | "SNAPSHOT_INVALID_BATCH"
  | "SNAPSHOT_INVALID_PAYLOAD"
  | "SNAPSHOT_METADATA_MISMATCH"
  | "SNAPSHOT_FORBIDDEN_FIELD";

export class StatisticsSnapshotContractError extends Error {
  readonly code: StatisticsSnapshotContractErrorCode;

  constructor(
    code: StatisticsSnapshotContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = "StatisticsSnapshotContractError";
    this.code = code;
  }
}

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "query",
  "pgno",
  "imei",
  "receivername",
  "receiverphone",
  "address",
  "shippingmemo",
  "rawpayload",
  "payloadjson",
  "customermemo",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contractError(
  code: StatisticsSnapshotContractErrorCode,
  message: string
): never {
  throw new StatisticsSnapshotContractError(code, message);
}

export function isStatisticsSnapshotDomain(
  value: unknown
): value is StatisticsSnapshotDomain {
  return (
    typeof value === "string" &&
    STATISTICS_SNAPSHOT_DOMAINS.includes(
      value as StatisticsSnapshotDomain
    )
  );
}

export function assertStatisticsSnapshotBatchContract(
  batch: StatisticsSnapshotBatchContract
) {
  try {
    const dataCutoffDate = normalizeStatisticsDate(
      batch.dataCutoffDate,
      "dataCutoffDate"
    );
    const periodFrom = normalizeStatisticsDate(
      batch.periodFrom,
      "periodFrom"
    );
    const periodTo = normalizeStatisticsDate(batch.periodTo, "periodTo");
    const dayCount = statisticsDateRangeDayCount({
      fromDate: periodFrom,
      toDate: periodTo,
    });

    if (
      dataCutoffDate !== periodTo ||
      !Number.isInteger(batch.dayCount) ||
      batch.dayCount !== dayCount ||
      typeof batch.calculationVersion !== "string" ||
      !batch.calculationVersion.trim()
    ) {
      contractError(
        "SNAPSHOT_INVALID_BATCH",
        "Snapshot batch period, cutoff, day count, or calculation version is invalid."
      );
    }
  } catch (error) {
    if (error instanceof StatisticsSnapshotContractError) {
      throw error;
    }
    contractError(
      "SNAPSHOT_INVALID_BATCH",
      "Snapshot batch period, cutoff, day count, or calculation version is invalid."
    );
  }
}

function assertCalculationMetadata(
  calculation: unknown,
  batch: StatisticsSnapshotBatchContract
): asserts calculation is StatisticsCalculationMetadata {
  if (!isRecord(calculation)) {
    contractError(
      "SNAPSHOT_INVALID_PAYLOAD",
      "Snapshot data.calculation is required."
    );
  }

  const period = calculation.period;
  const comparisonPeriod = calculation.comparisonPeriod;

  if (!isRecord(period) || !isRecord(comparisonPeriod)) {
    contractError(
      "SNAPSHOT_INVALID_PAYLOAD",
      "Snapshot calculation period metadata is required."
    );
  }

  try {
    const periodDayCount = statisticsDateRangeDayCount({
      fromDate: String(period.fromDate ?? ""),
      toDate: String(period.toDate ?? ""),
    });
    const comparisonDayCount = statisticsDateRangeDayCount({
      fromDate: String(comparisonPeriod.fromDate ?? ""),
      toDate: String(comparisonPeriod.toDate ?? ""),
    });

    if (
      calculation.mode !== "SNAPSHOT" ||
      calculation.isDefaultPeriod !== true ||
      calculation.dataCutoffDate !== batch.dataCutoffDate ||
      period.fromDate !== batch.periodFrom ||
      period.toDate !== batch.periodTo ||
      period.dayCount !== batch.dayCount ||
      periodDayCount !== batch.dayCount ||
      comparisonPeriod.dayCount !== comparisonDayCount
    ) {
      contractError(
        "SNAPSHOT_METADATA_MISMATCH",
        "Snapshot calculation metadata does not match its batch."
      );
    }
  } catch (error) {
    if (error instanceof StatisticsSnapshotContractError) {
      throw error;
    }

    contractError(
      "SNAPSHOT_METADATA_MISMATCH",
      "Snapshot calculation contains an invalid date range."
    );
  }
}

function assertNoForbiddenFields(
  value: unknown,
  seen = new WeakSet<object>()
) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    contractError(
      "SNAPSHOT_INVALID_PAYLOAD",
      "Snapshot payload must not contain circular references."
    );
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoForbiddenFields(entry, seen);
    }
    seen.delete(value);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_PAYLOAD_KEYS.has(normalizedKey)) {
      contractError(
        "SNAPSHOT_FORBIDDEN_FIELD",
        `Snapshot payload must not contain ${key}.`
      );
    }
    assertNoForbiddenFields(child, seen);
  }

  seen.delete(value);
}

function assertSnapshotData(
  domain: StatisticsSnapshotDomain,
  data: unknown,
  batch: StatisticsSnapshotBatchContract
) {
  if (
    !isRecord(data) ||
    typeof data.generatedAt !== "string" ||
    !data.generatedAt.trim()
  ) {
    contractError(
      "SNAPSHOT_INVALID_PAYLOAD",
      "Snapshot aggregate data and generatedAt are required."
    );
  }

  assertCalculationMetadata(data.calculation, batch);

  try {
    assertStatisticsSnapshotDomainData(domain, data);
  } catch (error) {
    if (error instanceof StatisticsRuntimeSchemaError) {
      contractError("SNAPSHOT_INVALID_PAYLOAD", error.message);
    }
    throw error;
  }

  assertNoForbiddenFields(data);
}

export function createStatisticsSnapshotEnvelope<
  Domain extends StatisticsSnapshotDomain,
>(input: {
  domain: Domain;
  data: StatisticsSnapshotData<Domain>;
  batch: StatisticsSnapshotBatchContract;
  payloadSchemaVersion?: number;
}): StatisticsSnapshotEnvelope<Domain> {
  if (!isStatisticsSnapshotDomain(input.domain)) {
    contractError(
      "SNAPSHOT_INVALID_DOMAIN",
      "Snapshot domain is not supported."
    );
  }

  assertStatisticsSnapshotBatchContract(input.batch);

  const data = {
    ...input.data,
    calculation: {
      ...input.data.calculation,
      mode: "SNAPSHOT" as const,
    },
  } as StatisticsSnapshotData<Domain>;

  assertSnapshotData(input.domain, data, input.batch);

  const payloadSchemaVersion =
    input.payloadSchemaVersion ??
    CURRENT_STATISTICS_PAYLOAD_SCHEMA_VERSION;
  if (
    !Number.isInteger(payloadSchemaVersion) ||
    payloadSchemaVersion <= 0
  ) {
    contractError(
      "SNAPSHOT_INVALID_PAYLOAD",
      "Snapshot payload schema version must be a positive integer."
    );
  }

  return {
    domain: input.domain,
    calculationVersion: input.batch.calculationVersion,
    payloadSchemaVersion,
    dataCutoffDate: input.batch.dataCutoffDate,
    period: {
      fromDate: input.batch.periodFrom,
      toDate: input.batch.periodTo,
      dayCount: input.batch.dayCount,
    },
    data,
  };
}

export function assertStatisticsSnapshotEnvelope(
  value: unknown,
  expected: {
    domain: StatisticsSnapshotDomain;
    batch: StatisticsSnapshotBatchContract;
    payloadSchemaVersion: number;
  }
): asserts value is StatisticsSnapshotEnvelope {
  if (!isRecord(value) || !isStatisticsSnapshotDomain(value.domain)) {
    contractError(
      "SNAPSHOT_INVALID_PAYLOAD",
      "Snapshot envelope is invalid."
    );
  }

  if (
    value.domain !== expected.domain ||
    value.calculationVersion !== expected.batch.calculationVersion ||
    value.payloadSchemaVersion !== expected.payloadSchemaVersion ||
    value.dataCutoffDate !== expected.batch.dataCutoffDate ||
    !isRecord(value.period) ||
    value.period.fromDate !== expected.batch.periodFrom ||
    value.period.toDate !== expected.batch.periodTo ||
    value.period.dayCount !== expected.batch.dayCount
  ) {
    contractError(
      "SNAPSHOT_METADATA_MISMATCH",
      "Snapshot envelope does not match its stored batch metadata."
    );
  }

  assertStatisticsSnapshotBatchContract(expected.batch);
  assertSnapshotData(expected.domain, value.data, expected.batch);
}
