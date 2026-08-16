import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { InboundBatchPlanRowDto } from "@/quickhack_shared/inbound/inbound-reconciliation";
import { loadInboundReconciliationSnapshot } from "@/quickhack_server/inbound/inbound-reconciliation-service";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";

type InboundBatchPlanReadClient = Pick<
  Prisma.TransactionClient,
  "inbound_batches" | "inbounds"
>;

async function loadInboundBatchMetadata(
  client: InboundBatchPlanReadClient,
  inboundBatchIds: readonly number[]
) {
  if (inboundBatchIds.length === 0) {
    return new Map<number, { historicalInboundQuantity: number; revision: number }>();
  }

  const rows = await client.inbound_batches.findMany({
    where: {
      inbound_batch_id: {
        in: [...inboundBatchIds],
      },
    },
    select: {
      inbound_batch_id: true,
      revision: true,
      _count: {
        select: {
          inbounds: true,
        },
      },
    },
  });

  return new Map(
    rows.map((row) => [
      row.inbound_batch_id,
      {
        historicalInboundQuantity: row._count.inbounds,
        revision: row.revision,
      },
    ] as const)
  );
}

export async function listInboundBatchPlanRows(
  owner: PrismaClient
): Promise<InboundBatchPlanRowDto[]> {
  return runConsistentReadSnapshot(owner, "inbound.batch-plan.list", async (tx) => {
    const reconciliation = await loadInboundReconciliationSnapshot(tx);
    const metadataByBatch = await loadInboundBatchMetadata(
      tx,
      reconciliation.batches.map((batch) => batch.inboundBatchId)
    );

    return reconciliation.batches.map((batch) => ({
      id: batch.inboundBatchId,
      revision: metadataByBatch.get(batch.inboundBatchId)?.revision ?? 0,
      batchDate: batch.batchDate,
      batchNo: batch.batchNo,
      expectedQuantity: batch.expectedQuantity,
      note: batch.note,
      linkedQuantity: batch.linkedQuantity,
      supplierReturnQuantity: batch.supplierReturnQuantity,
      normalInboundTargetQuantity: batch.normalInboundTargetQuantity,
      arrivalDifference: batch.arrivalDifference,
      shortageQuantity: batch.shortageQuantity,
      excessQuantity: batch.excessQuantity,
      historicalInboundQuantity:
        metadataByBatch.get(batch.inboundBatchId)?.historicalInboundQuantity ?? 0,
    }));
  });
}
