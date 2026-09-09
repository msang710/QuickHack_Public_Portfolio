import type { Prisma } from "@/generated/prisma/client";
import {
  todayKstDate,
  type DateTimeInput,
} from "@/quickhack_shared/core/time";
import {
  apiDate,
  databaseDate,
} from "@/quickhack_server/core/database/time-boundary";
import {
  publicBadRequest,
  publicConflict,
} from "@/quickhack_server/core/public-error";

type TransactionClient = Prisma.TransactionClient;

export function inboundBatchDateFromTimestamp(value: unknown) {
  return apiDate(value as DateTimeInput) ?? todayKstDate();
}

export async function resolveInboundBatchId(
  tx: TransactionClient,
  batchNo: number | null | undefined,
  timestamp: unknown
) {
  if (batchNo === undefined) {
    return undefined;
  }

  if (batchNo === null) {
    return null;
  }

  if (!Number.isInteger(batchNo) || batchNo <= 0) {
    throw publicBadRequest(
      "INBOUND_BATCH_REFERENCE_INVALID",
      "INBOUND_BATCH_REFERENCE_INVALID"
    );
  }

  const batchDate = inboundBatchDateFromTimestamp(timestamp);
  const batch = await tx.inbound_batches.findUnique({
    where: {
      batch_date_batch_no: {
        batch_date: databaseDate(batchDate),
        batch_no: batchNo,
      },
    },
    select: { inbound_batch_id: true },
  });

  if (!batch) {
    throw publicConflict(
      "INBOUND_BATCH_NOT_REGISTERED",
      "INBOUND_BATCH_NOT_REGISTERED"
    );
  }

  return batch.inbound_batch_id;
}
