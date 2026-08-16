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
      "차수 번호는 1 이상의 숫자여야 합니다."
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
      `${batchDate} ${batchNo}차가 차수 지정 메뉴에 등록되어 있지 않습니다.`
    );
  }

  return batch.inbound_batch_id;
}
