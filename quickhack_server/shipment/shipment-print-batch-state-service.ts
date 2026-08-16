import type { Prisma } from "@/generated/prisma/client";
import {
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import {
  SHIPMENT_PRINT_BATCH_STATUS,
  isShipmentPrintBatchStatus,
  shipmentPrintBatchAllowedFromStatuses,
  type ShipmentPrintBatchStatus,
} from "@/quickhack_shared/shipment/shipment-print-batch-status";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";

type TransactionClient = Prisma.TransactionClient;
type TransitionTarget = Exclude<ShipmentPrintBatchStatus, "PENDING">;

export type ShipmentPrintBatchTransitionResult = {
  applied: boolean;
  status: TransitionTarget;
};

function transitionData(
  targetStatus: TransitionTarget,
  transitionedAtInput: DateTimeInput
) {
  const transitionedAt = databaseDateTime(transitionedAtInput);
  if (targetStatus === SHIPMENT_PRINT_BATCH_STATUS.printDialogClosed) {
    return {
      batch_status: targetStatus,
      print_dialog_closed_at: transitionedAt,
      updated_at: transitionedAt,
    };
  }

  if (targetStatus === SHIPMENT_PRINT_BATCH_STATUS.confirmed) {
    return {
      batch_status: targetStatus,
      confirmed_at: transitionedAt,
      updated_at: transitionedAt,
    };
  }

  return {
    batch_status: targetStatus,
    canceled_at: transitionedAt,
    updated_at: transitionedAt,
  };
}

function conflictMessage(
  currentStatus: string,
  targetStatus: TransitionTarget
) {
  if (currentStatus === SHIPMENT_PRINT_BATCH_STATUS.confirmed) {
    return "이미 확정된 출고 출력 차수는 폐기하거나 이전 상태로 되돌릴 수 없습니다.";
  }
  if (currentStatus === SHIPMENT_PRINT_BATCH_STATUS.canceled) {
    return "이미 폐기된 출고 출력 차수는 확정하거나 이전 상태로 되돌릴 수 없습니다.";
  }
  return `출고 출력 차수 상태가 동시에 변경되어 ${targetStatus} 처리를 중단했습니다.`;
}

export async function transitionShipmentPrintBatchStatus(
  tx: TransactionClient,
  input: {
    batchId: number;
    targetStatus: TransitionTarget;
    transitionedAt: DateTimeInput;
  }
): Promise<ShipmentPrintBatchTransitionResult> {
  const allowedFromStatuses = shipmentPrintBatchAllowedFromStatuses(
    input.targetStatus
  );
  const updated = await tx.sales_channel_shipment_list_print_batches.updateMany({
    where: {
      shipment_list_print_batch_id: input.batchId,
      batch_status: { in: allowedFromStatuses },
    },
    data: transitionData(input.targetStatus, input.transitionedAt),
  });

  if (updated.count === 1) {
    return { applied: true, status: input.targetStatus };
  }

  const current = await tx.sales_channel_shipment_list_print_batches.findUnique({
    where: { shipment_list_print_batch_id: input.batchId },
    select: { batch_status: true },
  });
  if (!current) {
    throw publicNotFound(
      "SHIPMENT_PRINT_BATCH_NOT_FOUND",
      "출고 출력 차수를 찾을 수 없습니다.",
      { batchId: input.batchId }
    );
  }

  if (current.batch_status === input.targetStatus) {
    return { applied: false, status: input.targetStatus };
  }

  const currentStatus = isShipmentPrintBatchStatus(current.batch_status)
    ? current.batch_status
    : String(current.batch_status);
  throw publicConflict(
    "SHIPMENT_PRINT_BATCH_STATE_CONFLICT",
    conflictMessage(currentStatus, input.targetStatus),
    {
      batchId: input.batchId,
      currentStatus,
      requestedStatus: input.targetStatus,
    }
  );
}
