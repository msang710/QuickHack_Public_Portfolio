import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import { todayKstDate } from "@/quickhack_shared/core/time";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import type {
  InboundBatchReconciliationDto,
  InboundReconciliationDetailDto,
  InboundReconciliationDetailScope,
  InboundReconciliationSummaryDto,
  LatestInboundDeviceDto,
} from "@/quickhack_shared/inbound/inbound-reconciliation";
import { INBOUND_RECONCILIATION_DETAIL_SCOPES } from "@/quickhack_shared/inbound/inbound-reconciliation";
import { loadLatestInbounds } from "@/quickhack_server/inbound/latest-inbound-loader";
import { PublicError } from "@/quickhack_server/core/public-error";
import {
  databaseDate,
  databaseDateTime,
  requiredApiDate,
} from "@/quickhack_server/core/database/time-boundary";

type InboundReadClient = Pick<
  PrismaClient,
  "inbound_batches" | "inbounds"
>;

type InboundBatchRow = Prisma.inbound_batchesGetPayload<{
  select: {
    inbound_batch_id: true;
    batch_date: true;
    batch_no: true;
    expected_quantity: true;
    note: true;
  };
}>;

type BuildInboundReconciliationInput = {
  businessDate: string;
  batches: readonly InboundBatchRow[];
  latestInbounds: readonly LatestInboundDeviceDto[];
};

const SQL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class InboundReconciliationInputError extends PublicError {
  constructor(message: string) {
    super({
      status: 400,
      code: "INBOUND_RECONCILIATION_INPUT_INVALID",
      message,
    });
    this.name = "InboundReconciliationInputError";
  }
}

function assertSqlDate(value: string, label: string) {
  if (!SQL_DATE_PATTERN.test(value)) {
    throw new InboundReconciliationInputError(
      "INBOUND_RECONCILIATION_INPUT_INVALID"
    );
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new InboundReconciliationInputError(
      "INBOUND_RECONCILIATION_INPUT_INVALID"
    );
  }
}

export function normalizeInboundReconciliationDetailScope(
  value: unknown
): InboundReconciliationDetailScope {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();

  if (
    !INBOUND_RECONCILIATION_DETAIL_SCOPES.includes(
      normalized as InboundReconciliationDetailScope
    )
  ) {
    throw new InboundReconciliationInputError(
      "INBOUND_RECONCILIATION_INPUT_INVALID"
    );
  }

  return normalized as InboundReconciliationDetailScope;
}

function isCreatedOnBusinessDate(
  inbound: LatestInboundDeviceDto,
  businessDate: string
) {
  return (
    inbound.createdAt >= `${businessDate} 00:00:00` &&
    inbound.createdAt <= `${businessDate} 23:59:59`
  );
}

function latestDistinctInbounds(
  rows: readonly LatestInboundDeviceDto[]
) {
  const latestByPgNo = new Map<string, LatestInboundDeviceDto>();

  for (const row of rows) {
    const current = latestByPgNo.get(row.pgNo);

    if (!current || row.inboundId > current.inboundId) {
      latestByPgNo.set(row.pgNo, row);
    }
  }

  return Array.from(latestByPgNo.values()).sort(
    (left, right) => left.inboundId - right.inboundId
  );
}

function statusCounts(rows: readonly LatestInboundDeviceDto[]) {
  const counts: Record<string, number> = {};

  for (const row of rows) {
    counts[row.inboundStatus] = (counts[row.inboundStatus] ?? 0) + 1;
  }

  return counts;
}

function reconcileBatch(
  batch: InboundBatchRow,
  rows: readonly LatestInboundDeviceDto[]
): InboundBatchReconciliationDto {
  const linkedRows = rows.filter(
    (row) => row.inboundBatchId === batch.inbound_batch_id
  );
  const supplierReturnQuantity = linkedRows.filter(
    (row) => row.inboundStatus === INBOUND_STATUS.supplierReturn
  ).length;
  const linkedQuantity = linkedRows.length;
  const arrivalDifference = linkedQuantity - batch.expected_quantity;

  return {
    inboundBatchId: batch.inbound_batch_id,
    batchDate: requiredApiDate(batch.batch_date),
    batchNo: batch.batch_no,
    expectedQuantity: batch.expected_quantity,
    note: batch.note,
    linkedQuantity,
    supplierReturnQuantity,
    normalInboundTargetQuantity:
      linkedQuantity - supplierReturnQuantity,
    arrivalDifference,
    shortageQuantity: Math.max(-arrivalDifference, 0),
    excessQuantity: Math.max(arrivalDifference, 0),
    statusCounts: statusCounts(linkedRows),
    devices: linkedRows,
  };
}

export function buildInboundReconciliation({
  businessDate,
  batches,
  latestInbounds,
}: BuildInboundReconciliationInput): InboundReconciliationSummaryDto {
  assertSqlDate(businessDate, "업무일");

  const distinctLatestInbounds = latestDistinctInbounds(latestInbounds);
  const reconciledBatches = batches.map((batch) =>
    reconcileBatch(batch, distinctLatestInbounds)
  );
  const unassignedDevices = distinctLatestInbounds.filter(
    (row) =>
      row.inboundBatchId === null &&
      isCreatedOnBusinessDate(row, businessDate)
  );

  return {
    businessDate,
    unassignedPgQuantity: unassignedDevices.length,
    mismatchedBatchQuantity: reconciledBatches.filter(
      (batch) => batch.arrivalDifference !== 0
    ).length,
    shortageQuantity: reconciledBatches.reduce(
      (sum, batch) => sum + batch.shortageQuantity,
      0
    ),
    excessQuantity: reconciledBatches.reduce(
      (sum, batch) => sum + batch.excessQuantity,
      0
    ),
    unassignedDevices,
    batches: reconciledBatches,
  };
}

export function buildInboundReconciliationDetail(
  summary: InboundReconciliationSummaryDto,
  scope: InboundReconciliationDetailScope
): InboundReconciliationDetailDto {
  if (scope === "UNASSIGNED") {
    return {
      businessDate: summary.businessDate,
      scope,
      scopeQuantity: summary.unassignedPgQuantity,
      devices: summary.unassignedDevices,
      batches: [],
    };
  }

  if (scope === "MISMATCHED") {
    return {
      businessDate: summary.businessDate,
      scope,
      scopeQuantity: summary.mismatchedBatchQuantity,
      devices: [],
      batches: summary.batches.filter(
        (batch) => batch.arrivalDifference !== 0
      ),
    };
  }

  if (scope === "SHORTAGE") {
    return {
      businessDate: summary.businessDate,
      scope,
      scopeQuantity: summary.shortageQuantity,
      devices: [],
      batches: summary.batches.filter(
        (batch) => batch.shortageQuantity > 0
      ),
    };
  }

  return {
    businessDate: summary.businessDate,
    scope,
    scopeQuantity: summary.excessQuantity,
    devices: [],
    batches: summary.batches.filter(
      (batch) => batch.excessQuantity > 0
    ),
  };
}

async function candidatePgNosForDate(
  client: InboundReadClient,
  inboundBatchIds: readonly number[],
  businessDate: string
) {
  const dayStart = databaseDateTime(`${businessDate} 00:00:00`);
  const dateRange = {
    gte: dayStart,
    lt: new Date(dayStart.getTime() + 24 * 60 * 60 * 1_000),
  };
  const rows = await client.inbounds.findMany({
    where: {
      OR: [
        ...(inboundBatchIds.length > 0
          ? [{ inbound_batch_id: { in: [...inboundBatchIds] } }]
          : []),
        { created_at: dateRange },
      ],
    },
    select: { pg_no: true },
    distinct: ["pg_no"],
  });

  return rows.map((row) => row.pg_no);
}

export async function loadInboundReconciliationSnapshot(
  client: InboundReadClient,
  options: {
    batchDate?: string;
    businessDate?: string;
  } = {}
) {
  const businessDate =
    options.businessDate ?? options.batchDate ?? todayKstDate();

  assertSqlDate(businessDate, "업무일");

  if (options.batchDate) {
    assertSqlDate(options.batchDate, "차수 일자");
  }

  const batches = await client.inbound_batches.findMany({
    where: options.batchDate
      ? { batch_date: databaseDate(options.batchDate) }
      : undefined,
    select: {
      inbound_batch_id: true,
      batch_date: true,
      batch_no: true,
      expected_quantity: true,
      note: true,
    },
    orderBy: [{ batch_date: "desc" }, { batch_no: "desc" }],
  });

  const pgNos = options.batchDate
    ? await candidatePgNosForDate(
        client,
        batches.map((batch) => batch.inbound_batch_id),
        businessDate
      )
    : undefined;
  const latestInbounds = await loadLatestInbounds(client, { pgNos });

  return buildInboundReconciliation({
    businessDate,
    batches,
    latestInbounds,
  });
}

export function getInboundReconciliation(
  owner: PrismaClient,
  options: {
    batchDate?: string;
    businessDate?: string;
  } = {}
) {
  return runConsistentReadSnapshot(
    owner,
    "inbound.reconciliation",
    (tx) => loadInboundReconciliationSnapshot(tx, options)
  );
}
