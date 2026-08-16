import type { Prisma } from "@/generated/prisma/client";

import { resolveCoupangWriteTargetResults } from "@/quickhack_server/sales-channel/coupang/write-target-result-service";
import type { CoupangWriteResponseAssessment } from "@/quickhack_server/sales-channel/coupang/write-response-contract";
import type { CoupangWriteVerificationTargetGroupResult } from "@/quickhack_server/sales-channel/coupang/write-verification-service";
import {
  deriveSalesChannelWriteRequestStatus,
  successfulPendingTargetIds,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-target-state";
import {
  SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS,
  SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS,
  type SalesChannelWriteCommand,
} from "@/quickhack_shared/sales-channel/write-requests";

const targetStateSelect = {
  sales_channel_write_request_target_id: true,
  external_result_status: true,
  local_finalization_status: true,
} as const;

function targetResultOperatorMessage(externalStatus: string) {
  if (
    externalStatus === SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded
  ) {
    return "채널 처리 성공";
  }
  if (
    externalStatus === SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied
  ) {
    return "채널 미반영";
  }
  return null;
}

export async function settleCoupangWriteTargetAssessment(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  command: SalesChannelWriteCommand;
  assessment: CoupangWriteResponseAssessment;
  receivedAt: Date;
}) {
  const targets = await input.tx.sales_channel_write_request_targets.findMany({
    where: { sales_channel_write_request_id: input.requestId },
    orderBy: { target_position: "asc" },
    select: {
      sales_channel_write_request_target_id: true,
      target_external_id: true,
      external_shipment_id: true,
    },
  });
  const resolved = resolveCoupangWriteTargetResults({
    command: input.command,
    assessment: input.assessment,
    targets,
  });

  for (const result of resolved) {
    const updated = await input.tx.sales_channel_write_request_targets.updateMany({
      where: {
        sales_channel_write_request_target_id: result.targetId,
        sales_channel_write_request_id: input.requestId,
        external_result_status: SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.pending,
      },
      data: {
        external_result_status: result.externalResultStatus,
        external_result_code: result.externalResultCode,
        external_result_message: targetResultOperatorMessage(
          result.externalResultStatus
        ),
        retry_required: result.retryRequired,
        result_received_at: input.receivedAt,
        local_finalization_status: result.localFinalizationStatus,
      },
    });
    if (updated.count !== 1) {
      throw new Error(
        `Sales channel write target ${result.targetId} result was already settled.`
      );
    }
  }

  return loadSalesChannelWriteTargetSettlement(input.tx, input.requestId);
}

export async function markPendingSalesChannelWriteTargets(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  externalStatus: "NOT_APPLIED" | "UNKNOWN" | "SUCCEEDED";
  resultCode?: string | null;
  receivedAt: Date;
}) {
  await input.tx.sales_channel_write_request_targets.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      external_result_status: SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.pending,
    },
    data: {
      external_result_status: input.externalStatus,
      external_result_code: input.resultCode ?? null,
      external_result_message: targetResultOperatorMessage(
        input.externalStatus
      ),
      result_received_at: input.receivedAt,
      local_finalization_status:
        input.externalStatus ===
        SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied
          ? SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.notRequired
          : SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.pending,
    },
  });
  return loadSalesChannelWriteTargetSettlement(input.tx, input.requestId);
}

export async function settleSalesChannelWriteVerificationGroups(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  expectedExternalStatuses: readonly ("PENDING" | "UNKNOWN")[];
  groupResults: readonly CoupangWriteVerificationTargetGroupResult[];
  receivedAt: Date;
}) {
  const expectedRows =
    await input.tx.sales_channel_write_request_targets.findMany({
      where: {
        sales_channel_write_request_id: input.requestId,
        external_result_status: { in: [...input.expectedExternalStatuses] },
      },
      select: { sales_channel_write_request_target_id: true },
    });
  const expectedTargetIds = new Set(
    expectedRows.map((row) => row.sales_channel_write_request_target_id)
  );
  const seenTargetIds = new Set<number>();

  for (const group of input.groupResults) {
    if (group.targetIds.length === 0) {
      throw new Error(`Sales-channel write verification group ${group.groupKey} is empty.`);
    }
    for (const targetId of group.targetIds) {
      if (seenTargetIds.has(targetId)) {
        throw new Error(
          `Sales-channel write verification target ${targetId} belongs to multiple groups.`
        );
      }
      seenTargetIds.add(targetId);
    }

    const externalStatus =
      group.outcome === "CONFIRMED"
        ? SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded
        : group.outcome === "NOT_APPLIED"
          ? SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied
          : SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.unknown;
    const updated =
      await input.tx.sales_channel_write_request_targets.updateMany({
        where: {
          sales_channel_write_request_id: input.requestId,
          sales_channel_write_request_target_id: { in: group.targetIds },
          external_result_status: {
            in: [...input.expectedExternalStatuses],
          },
        },
        data: {
          external_result_status: externalStatus,
          external_result_code: group.code,
          external_result_message: targetResultOperatorMessage(externalStatus),
          retry_required:
            externalStatus === SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied
              ? 1
              : 0,
          result_received_at: input.receivedAt,
          local_finalization_status:
            externalStatus === SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied
              ? SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.notRequired
              : SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.pending,
        },
      });
    if (updated.count !== group.targetIds.length) {
      throw new Error(
        `Sales-channel write verification group ${group.groupKey} ownership changed.`
      );
    }
  }

  if (
    seenTargetIds.size !== expectedTargetIds.size ||
    [...seenTargetIds].some((targetId) => !expectedTargetIds.has(targetId))
  ) {
    throw new Error(
      "Sales-channel write verification did not cover the current target set."
    );
  }

  return loadSalesChannelWriteTargetSettlement(input.tx, input.requestId);
}

export async function markSalesChannelWriteTargetsLocalStatus(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  targetIds: readonly number[];
  status: "SUCCEEDED" | "FAILED";
  finalizedAt?: Date | null;
}) {
  if (input.targetIds.length === 0) return;
  const updated = await input.tx.sales_channel_write_request_targets.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      sales_channel_write_request_target_id: { in: [...input.targetIds] },
      external_result_status: SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded,
      local_finalization_status: {
        in: [
          SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.pending,
          SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.failed,
        ],
      },
    },
    data: {
      local_finalization_status: input.status,
      local_finalized_at:
        input.status === SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.succeeded
          ? input.finalizedAt ?? null
          : null,
    },
  });
  if (updated.count !== input.targetIds.length) {
    throw new Error("Sales channel write target local finalization ownership changed.");
  }
}

export async function resolveUnknownSalesChannelWriteTargets(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  targetIds: readonly number[];
  externalStatus: "SUCCEEDED" | "NOT_APPLIED";
  resultCode: string;
  receivedAt: Date;
}) {
  if (input.targetIds.length === 0) {
    throw new Error("Sales-channel write target group is empty.");
  }
  const updated = await input.tx.sales_channel_write_request_targets.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      sales_channel_write_request_target_id: { in: [...input.targetIds] },
      external_result_status: SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.unknown,
    },
    data: {
      external_result_status: input.externalStatus,
      external_result_code: input.resultCode,
      external_result_message: targetResultOperatorMessage(
        input.externalStatus
      ),
      result_received_at: input.receivedAt,
      local_finalization_status:
        input.externalStatus ===
        SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied
          ? SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.notRequired
          : SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.pending,
    },
  });
  if (updated.count !== input.targetIds.length) {
    throw new Error("Sales-channel write target group ownership changed.");
  }
  return loadSalesChannelWriteTargetSettlement(input.tx, input.requestId);
}

export async function loadSalesChannelWriteTargetSettlement(
  tx: Prisma.TransactionClient,
  requestId: number
) {
  const rows = await tx.sales_channel_write_request_targets.findMany({
    where: { sales_channel_write_request_id: requestId },
    orderBy: { target_position: "asc" },
    select: targetStateSelect,
  });
  const targets = rows.map((row) => ({
    salesChannelWriteRequestTargetId:
      row.sales_channel_write_request_target_id,
    externalResultStatus: row.external_result_status,
    localFinalizationStatus: row.local_finalization_status,
  }));
  return {
    targetIds: successfulPendingTargetIds(targets),
    requestStatus: deriveSalesChannelWriteRequestStatus(targets),
    targets,
  };
}
