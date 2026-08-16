// QuickHack note: One-off and scheduled privacy maintenance jobs sanitize stored diagnostic payloads.
import { prisma } from "@/quickhack_server/core/prisma";
import {
  assertWorkerLeaseActive,
  throwIfWorkerLeaseAborted,
} from "@/quickhack_server/workers/lease-guard";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";
import {
  quickHackClock,
} from "@/quickhack_shared/core/time";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import {
  PERSONAL_DATA_RETENTION_DAYS,
  personalDataRetentionCutoff,
  reconcilePersonalDataLifecyclesForOrder,
  recordPersonalDataDeliveryCompletion,
} from "@/quickhack_server/security/personal-data-lifecycle-service";
import {
  redactPersonalDataCopiesForSubject,
  type PersonalDataTableSummary,
} from "@/quickhack_server/security/personal-data-redaction-service";

type TableSummary = {
  table: string;
  scanned: number;
  updated: number;
  parseFailed: number;
};

async function reconcileStoredPersonalDataLifecycles(input: {
  batchSize: number;
  workerLease?: WorkerLeaseGuard;
}) {
  let lastSaleRecordId = 0;
  let lastRawOrderId = 0;
  let lastReturnId = 0;
  let lastExchangeId = 0;
  let lastClaimEventId = 0;
  let deliveryEvidence = 0;
  let reconciled = 0;
  let fallbackTimestamp = 0;
  let parseFailed = 0;
  const reconciledSubjects = new Set<string>();
  const claimOrderIds = new Set<string>();
  const subjectKey = (
    channel: string,
    externalOrderId: string,
    externalShipmentId: string
  ) => `${channel}\u0000${externalOrderId}\u0000${externalShipmentId}`;

  while (true) {
    await assertWorkerLeaseActive(input.workerLease);
    const sales = await prisma.sales_records.findMany({
      where: {
        sale_record_id: { gt: lastSaleRecordId },
        external_shipment_id: { not: null },
      },
      orderBy: { sale_record_id: "asc" },
      take: input.batchSize,
      select: {
        sale_record_id: true,
        channel: true,
        external_order_id: true,
        external_shipment_id: true,
        sold_at: true,
      },
    });
    if (sales.length === 0) break;
    const uniqueSales = Array.from(
      new Map(
        sales
          .filter((sale) => sale.external_shipment_id)
          .map((sale) => [
            subjectKey(
              sale.channel,
              sale.external_order_id,
              sale.external_shipment_id!
            ),
            sale,
          ])
      ).values()
    );
    const completedLifecycles =
      uniqueSales.length === 0
        ? []
        : await prisma.sales_channel_personal_data_lifecycles.findMany({
            where: {
              delivery_completed_at: { not: null },
              OR: uniqueSales.map((sale) => ({
                channel: sale.channel,
                external_order_id: sale.external_order_id,
                external_shipment_id: sale.external_shipment_id!,
              })),
            },
            select: {
              channel: true,
              external_order_id: true,
              external_shipment_id: true,
            },
          });
    const alreadyRecorded = new Set(
      completedLifecycles.map((lifecycle) =>
        subjectKey(
          lifecycle.channel,
          lifecycle.external_order_id,
          lifecycle.external_shipment_id
        )
      )
    );

    await prisma.$transaction(async (tx) => {
      for (const sale of sales) {
        throwIfWorkerLeaseAborted(input.workerLease);
        lastSaleRecordId = sale.sale_record_id;
        if (!sale.external_shipment_id) continue;
        const key = subjectKey(
          sale.channel,
          sale.external_order_id,
          sale.external_shipment_id
        );
        if (reconciledSubjects.has(key) || alreadyRecorded.has(key)) continue;
        const result = await recordPersonalDataDeliveryCompletion(tx, {
          channel: sale.channel,
          externalOrderId: sale.external_order_id,
          externalShipmentId: sale.external_shipment_id,
          completedAt: sale.sold_at,
        });
        deliveryEvidence += result.recorded ? 1 : 0;
        parseFailed += result.parseFailed ? 1 : 0;
        reconciled += result.reconciliation?.subjectCount ?? 0;
        fallbackTimestamp +=
          result.reconciliation?.fallbackTimestamp ?? 0;
        parseFailed += result.reconciliation?.parseFailed ?? 0;
        if (result.reconciliation) reconciledSubjects.add(key);
      }
    });
  }

  // This covers FINAL_DELIVERY orders that have not been matched to a package group.
  while (true) {
    await assertWorkerLeaseActive(input.workerLease);
    const orders = await prisma.coupang_order_raw.findMany({
      where: {
        coupang_order_raw_id: { gt: lastRawOrderId },
        external_order_status: "FINAL_DELIVERY",
      },
      orderBy: { coupang_order_raw_id: "asc" },
      take: input.batchSize,
      select: {
        coupang_order_raw_id: true,
        external_order_id: true,
        external_shipment_id: true,
        synced_at: true,
      },
    });
    if (orders.length === 0) break;
    const completedLifecycles =
      await prisma.sales_channel_personal_data_lifecycles.findMany({
        where: {
          channel: "COUPANG",
          delivery_completed_at: { not: null },
          OR: orders.map((order) => ({
            external_order_id: order.external_order_id,
            external_shipment_id: order.external_shipment_id,
          })),
        },
        select: {
          channel: true,
          external_order_id: true,
          external_shipment_id: true,
        },
      });
    const alreadyRecorded = new Set(
      completedLifecycles.map((lifecycle) =>
        subjectKey(
          lifecycle.channel,
          lifecycle.external_order_id,
          lifecycle.external_shipment_id
        )
      )
    );

    await prisma.$transaction(async (tx) => {
      for (const order of orders) {
        throwIfWorkerLeaseAborted(input.workerLease);
        lastRawOrderId = order.coupang_order_raw_id;
        const key = subjectKey(
          "COUPANG",
          order.external_order_id,
          order.external_shipment_id
        );
        if (reconciledSubjects.has(key) || alreadyRecorded.has(key)) continue;
        const result = await recordPersonalDataDeliveryCompletion(tx, {
          externalOrderId: order.external_order_id,
          externalShipmentId: order.external_shipment_id,
          completedAt: order.synced_at,
        });
        deliveryEvidence += result.recorded ? 1 : 0;
        parseFailed += result.parseFailed ? 1 : 0;
        reconciled += result.reconciliation?.subjectCount ?? 0;
        fallbackTimestamp +=
          result.reconciliation?.fallbackTimestamp ?? 0;
        parseFailed += result.reconciliation?.parseFailed ?? 0;
        if (result.reconciliation) reconciledSubjects.add(key);
      }
    });
  }

  // Reconcile only orders that have claim evidence. Orders without claims are
  // immutable after delivery completion and do not need a daily full-table pass.
  while (true) {
    await assertWorkerLeaseActive(input.workerLease);
    const returns = await prisma.coupang_return_raw.findMany({
      where: { coupang_return_raw_id: { gt: lastReturnId } },
      orderBy: { coupang_return_raw_id: "asc" },
      take: input.batchSize,
      select: {
        coupang_return_raw_id: true,
        external_order_id: true,
      },
    });
    if (returns.length === 0) break;
    for (const claim of returns) {
      lastReturnId = claim.coupang_return_raw_id;
      if (claim.external_order_id) claimOrderIds.add(claim.external_order_id);
    }
  }

  while (true) {
    await assertWorkerLeaseActive(input.workerLease);
    const exchanges = await prisma.coupang_exchange_raw.findMany({
      where: { coupang_exchange_raw_id: { gt: lastExchangeId } },
      orderBy: { coupang_exchange_raw_id: "asc" },
      take: input.batchSize,
      select: {
        coupang_exchange_raw_id: true,
        external_order_id: true,
      },
    });
    if (exchanges.length === 0) break;
    for (const claim of exchanges) {
      lastExchangeId = claim.coupang_exchange_raw_id;
      if (claim.external_order_id) claimOrderIds.add(claim.external_order_id);
    }
  }

  while (true) {
    await assertWorkerLeaseActive(input.workerLease);
    const events = await prisma.coupang_raw_change_event.findMany({
      where: {
        coupang_raw_change_event_id: { gt: lastClaimEventId },
        source_table: {
          in: ["coupang_return_raw", "coupang_exchange_raw"],
        },
        external_order_id: { not: null },
      },
      orderBy: { coupang_raw_change_event_id: "asc" },
      take: input.batchSize,
      select: {
        coupang_raw_change_event_id: true,
        external_order_id: true,
      },
    });
    if (events.length === 0) break;
    for (const event of events) {
      lastClaimEventId = event.coupang_raw_change_event_id;
      if (event.external_order_id) claimOrderIds.add(event.external_order_id);
    }
  }

  const claimOrders = Array.from(claimOrderIds);
  for (let offset = 0; offset < claimOrders.length; offset += input.batchSize) {
    await assertWorkerLeaseActive(input.workerLease);
    const batch = claimOrders.slice(offset, offset + input.batchSize);
    await prisma.$transaction(async (tx) => {
      for (const externalOrderId of batch) {
        throwIfWorkerLeaseAborted(input.workerLease);
        const result = await reconcilePersonalDataLifecyclesForOrder(tx, {
          externalOrderId,
        });
        reconciled += result.subjectCount;
        fallbackTimestamp += result.fallbackTimestamp;
        parseFailed += result.parseFailed;
      }
    });
  }

  const [waitingCompletion, activeClaim] = await Promise.all([
    prisma.sales_channel_personal_data_lifecycles.count({
      where: {
        active_claim_count: 0,
        retention_started_at: null,
      },
    }),
    prisma.sales_channel_personal_data_lifecycles.count({
      where: {
        active_claim_count: { gt: 0 },
      },
    }),
  ]);

  return {
    deliveryEvidence,
    reconciled,
    waitingCompletion,
    activeClaim,
    fallbackTimestamp,
    parseFailed,
  };
}

export async function redactExpiredSalesChannelPersonalData(
  options: {
    retentionDays?: number;
    batchSize?: number;
    workerLease?: WorkerLeaseGuard;
  } = {}
) {
  await assertWorkerLeaseActive(options.workerLease);
  const retentionDays =
    options.retentionDays ?? PERSONAL_DATA_RETENTION_DAYS;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 500));
  const cutoff = personalDataRetentionCutoff(
    quickHackClock.nowDate(),
    retentionDays
  );
  const redactedAt = databaseNow();
  const reconciliation = await reconcileStoredPersonalDataLifecycles({
    batchSize,
    workerLease: options.workerLease,
  });
  const summariesByTable = new Map<string, TableSummary>();
  let lastLifecycleId = 0;
  let eligibleSubjects = 0;
  let completedSubjects = 0;
  let alreadyRedacted = 0;
  let deferredActiveWork = 0;
  let deferredSharedSubjects = 0;
  let sanitizedCopies = 0;

  while (true) {
    await assertWorkerLeaseActive(options.workerLease);
    const lifecycles =
      await prisma.sales_channel_personal_data_lifecycles.findMany({
        where: {
          personal_data_lifecycle_id: { gt: lastLifecycleId },
          active_claim_count: 0,
          redacted_at: null,
          retention_started_at: { not: null, lte: cutoff },
        },
        orderBy: { personal_data_lifecycle_id: "asc" },
        take: batchSize,
        select: {
          personal_data_lifecycle_id: true,
        },
      });

    if (lifecycles.length === 0) {
      break;
    }

    for (const lifecycle of lifecycles) {
      throwIfWorkerLeaseAborted(options.workerLease);
      lastLifecycleId = lifecycle.personal_data_lifecycle_id;
      const result = await prisma.$transaction(async (tx) => {
        return redactPersonalDataCopiesForSubject(tx, {
          lifecycleId: lifecycle.personal_data_lifecycle_id,
          cutoff,
          redactedAt,
          workerLease: options.workerLease,
        });
      });

      if (!result.eligible) continue;
      eligibleSubjects += 1;
      completedSubjects += result.completed ? 1 : 0;
      alreadyRedacted += result.alreadyRedacted ? 1 : 0;
      deferredActiveWork += result.deferredActiveWork;
      deferredSharedSubjects += result.deferredSharedSubjects;
      sanitizedCopies += result.sanitizedCopies;
      mergeTableSummaries(summariesByTable, result.tables);
    }
  }

  await assertWorkerLeaseActive(options.workerLease);
  const summaries = Array.from(summariesByTable.values()).sort((left, right) =>
    left.table.localeCompare(right.table)
  );
  const scanned = summaries.reduce((sum, item) => sum + item.scanned, 0);
  const updated = summaries.reduce((sum, item) => sum + item.updated, 0);

  return {
    redactedAt,
    retentionDays,
    cutoff,
    reconciliation,
    waitingCompletion: reconciliation.waitingCompletion,
    activeClaim: reconciliation.activeClaim,
    eligible: eligibleSubjects,
    redacted: completedSubjects,
    alreadyRedacted,
    eligibleSubjects,
    completedSubjects,
    deferredActiveWork,
    deferredSharedSubjects,
    sanitizedCopies,
    fallbackTimestamp: reconciliation.fallbackTimestamp,
    tables: summaries,
    scanned,
    updated,
    parseFailed: reconciliation.parseFailed,
  };
}

function mergeTableSummaries(
  target: Map<string, TableSummary>,
  summaries: PersonalDataTableSummary[]
) {
  for (const summary of summaries) {
    const current = target.get(summary.table) ?? {
      table: summary.table,
      scanned: 0,
      updated: 0,
      parseFailed: 0,
    };
    current.scanned += summary.scanned;
    current.updated += summary.updated;
    target.set(summary.table, current);
  }
}
