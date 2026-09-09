import type { Prisma } from "@/generated/prisma/client";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  publicBadRequest,
  publicConflict,
} from "@/quickhack_server/core/public-error";
import { finalizePersistedCoupangReturnWrite } from "@/quickhack_server/returns/return-write-finalizer";
import { finalizePersistedCoupangOrderInstruct } from "@/quickhack_server/sales-channel/coupang/order-instruct-finalizer";
import { finalizePersistedCoupangInvoiceUpload } from "@/quickhack_server/shipment/carrier-integration/coupang-invoice-finalizer";
import { finalizePersistedCoupangInvoiceUpdate } from "@/quickhack_server/shipment/carrier-integration/coupang-invoice-replacement-service";
import {
  finalizePersistedCoupangInventoryQuantityRepair,
  preparePersistedCoupangInventoryQuantityRepairFinalization,
} from "@/quickhack_server/sales-channel/coupang/inventory-quantity-repair-finalizer";
import {
  observeCoupangWriteRequest,
  persistCoupangWriteVerificationObservation,
  type CoupangWriteVerificationObservation,
} from "@/quickhack_server/sales-channel/coupang/write-verification-service";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  SALES_CHANNEL_WRITE_ATTEMPT_STATUS,
  SALES_CHANNEL_WRITE_ATTEMPT_TYPE,
  SALES_CHANNEL_WRITE_FAILURE_STAGE,
  SALES_CHANNEL_WRITE_MANUAL_VERIFICATION,
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
  SALES_CHANNEL_WRITE_REVIEW_STATUSES,
  type SalesChannelWriteRequestStatus,
} from "@/quickhack_shared/sales-channel/write-requests";
import {
  assertNoActiveSalesChannelWriteReviewOperation,
  assertSalesChannelWriteReviewOwnership,
  claimSalesChannelWriteReviewOperation,
  claimSalesChannelWriteReviewOperationInTransaction,
  completeSalesChannelWriteReviewOperation,
  isSalesChannelWriteReviewOwnershipLost,
  transferSalesChannelWriteReviewOwnership,
  transitionSalesChannelWriteReviewOwnership,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-review-ownership";
import {
  loadSalesChannelWriteTargetSettlement,
  markSalesChannelWriteTargetsLocalStatus,
  resolveUnknownSalesChannelWriteTargets,
  settleSalesChannelWriteVerificationGroups,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-target-service";
import {
  findSalesChannelWriteTargetGroup,
  groupSalesChannelWriteTargets,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-target-group";
import {
  isCommittedSalesChannelWriteAttempt,
  isCommittedSalesChannelWriteLocalFinalization,
  successfulPendingTargetIds,
  type SalesChannelWriteAttemptCommitExpectation,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-target-state";

type ManualDecision =
  (typeof SALES_CHANNEL_WRITE_MANUAL_VERIFICATION)[keyof typeof SALES_CHANNEL_WRITE_MANUAL_VERIFICATION];

const reviewTargetGroupSelect = {
  sales_channel_write_request_target_id: true,
  target_external_id: true,
  external_shipment_id: true,
  external_vendor_item_id: true,
  inventory_verification_state_id: true,
  external_result_status: true,
} as const;

async function loadUnknownTargetGroups(
  tx: Prisma.TransactionClient,
  requestId: number
) {
  const request = await tx.sales_channel_write_requests.findUnique({
    where: { sales_channel_write_request_id: requestId },
    select: {
      request_type: true,
      target_external_id: true,
      targets: {
        orderBy: { target_position: "asc" },
        select: reviewTargetGroupSelect,
      },
    },
  });
  if (!request) {
    throw publicConflict(
      "SALES_CHANNEL_WRITE_REQUEST_NOT_FOUND",
      "SALES_CHANNEL_WRITE_REQUEST_NOT_FOUND"
    );
  }

  const groups = groupSalesChannelWriteTargets({
    requestType: request.request_type,
    requestTargetExternalId: request.target_external_id,
    targets: request.targets,
  });
  const unknownGroups = groups.filter((group) =>
    group.targets.some((target) => target.external_result_status === "UNKNOWN")
  );
  if (
    unknownGroups.some((group) =>
      group.targets.some((target) => target.external_result_status !== "UNKNOWN")
    )
  ) {
    throw publicConflict(
      "SALES_CHANNEL_TARGET_GROUP_STATE_CONFLICT",
      "SALES_CHANNEL_TARGET_GROUP_STATE_CONFLICT"
    );
  }
  if (unknownGroups.length === 0) {
    throw publicConflict(
      "SALES_CHANNEL_TARGET_GROUP_ALREADY_RESOLVED",
      "SALES_CHANNEL_TARGET_GROUP_ALREADY_RESOLVED"
    );
  }

  return { requestType: request.request_type, groups: unknownGroups };
}

async function loadUnknownTargetGroup(
  tx: Prisma.TransactionClient,
  input: { requestId: number; targetId: number }
) {
  const request = await tx.sales_channel_write_requests.findUnique({
    where: { sales_channel_write_request_id: input.requestId },
    select: {
      request_type: true,
      target_external_id: true,
      targets: {
        orderBy: { target_position: "asc" },
        select: reviewTargetGroupSelect,
      },
    },
  });
  if (!request) {
    throw publicConflict(
      "SALES_CHANNEL_WRITE_REQUEST_NOT_FOUND",
      "SALES_CHANNEL_WRITE_REQUEST_NOT_FOUND"
    );
  }
  const group = findSalesChannelWriteTargetGroup({
    requestType: request.request_type,
    requestTargetExternalId: request.target_external_id,
    targets: request.targets,
    targetId: input.targetId,
  });
  if (
    group.targets.length === 0 ||
    group.targets.some((target) => target.external_result_status !== "UNKNOWN")
  ) {
    throw publicConflict(
      "SALES_CHANNEL_TARGET_GROUP_STATE_CONFLICT",
      "SALES_CHANNEL_TARGET_GROUP_STATE_CONFLICT"
    );
  }
  return group;
}

function requiredNote(value: unknown) {
  const note = String(value ?? "").trim();

  if (!note) {
    throw publicBadRequest(
      "SALES_CHANNEL_REVIEW_NOTE_REQUIRED",
      "SALES_CHANNEL_REVIEW_NOTE_REQUIRED"
    );
  }

  return note.slice(0, 1000);
}

async function finalizePersistedRequest(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  requestType: string;
  targetIds: readonly number[];
  actorUserId: number | null;
  finalizedAt: Date;
}) {
  if (
    input.requestType ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct
  ) {
    await finalizePersistedCoupangOrderInstruct({
      tx: input.tx,
      requestId: input.requestId,
      targetIds: input.targetIds,
      finalizedAt: input.finalizedAt,
    });
    return;
  }

  if (input.actorUserId === null) {
    throw new Error(
      "A user identity is required for this sales-channel local finalization."
    );
  }

  if (
    input.requestType ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload
  ) {
    await finalizePersistedCoupangInvoiceUpload({
      tx: input.tx,
      requestId: input.requestId,
      targetIds: input.targetIds,
      actorUserId: input.actorUserId,
      finalizedAt: input.finalizedAt,
    });
    return;
  }

  if (
    input.requestType ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate
  ) {
    await finalizePersistedCoupangInvoiceUpdate({
      tx: input.tx,
      requestId: input.requestId,
      targetIds: input.targetIds,
      actorUserId: input.actorUserId,
      finalizedAt: input.finalizedAt,
    });
    return;
  }

  if (
    input.requestType ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInventoryQuantityUpdate
  ) {
    await finalizePersistedCoupangInventoryQuantityRepair({
      tx: input.tx,
      requestId: input.requestId,
      finalizedAt: input.finalizedAt,
    });
    return;
  }

  await finalizePersistedCoupangReturnWrite({
    tx: input.tx,
    requestId: input.requestId,
    targetIds: input.targetIds,
    actorUserId: input.actorUserId,
    finalizedAt: input.finalizedAt,
  });
}


type ClaimedWriteReviewOperation = Awaited<
  ReturnType<typeof claimSalesChannelWriteReviewOperation>
>;

type CommittedReviewSettlementWithoutLocalFinalization = {
  expectedAttempt: SalesChannelWriteAttemptCommitExpectation;
};

async function hasCommittedSalesChannelWriteAttempt(
  expected: SalesChannelWriteAttemptCommitExpectation
) {
  const attempt = await prisma.sales_channel_write_request_attempts.findUnique({
    where: { sales_channel_write_request_attempt_id: expected.attemptId },
  });

  return Boolean(
    attempt &&
      isCommittedSalesChannelWriteAttempt({
        expected,
        attempt: {
          salesChannelWriteRequestId: attempt.sales_channel_write_request_id,
          salesChannelWriteRequestAttemptId:
            attempt.sales_channel_write_request_attempt_id,
          attemptNo: attempt.attempt_no,
          attemptType: attempt.attempt_type,
          attemptStatus: attempt.attempt_status,
          triggerType: attempt.trigger_type,
          completedAt: attempt.completed_at,
          requestDispatched: attempt.request_dispatched,
          responseReceived: attempt.response_received,
          externalAppliedUnknown: attempt.external_applied_unknown,
        },
      })
  );
}

export type SalesChannelWriteReviewDependencies = {
  observeWrite?: typeof observeCoupangWriteRequest;
  persistObservation?: typeof persistCoupangWriteVerificationObservation;
};

function targetGroupReviewContext(
  requestStatus: SalesChannelWriteRequestStatus,
  reviewRequiredAt: Date
) {
  const reviewRequired =
    requestStatus === SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired;

  return {
    failure_stage: reviewRequired
      ? SALES_CHANNEL_WRITE_FAILURE_STAGE.externalVerification
      : null,
    error_code: reviewRequired ? "TARGET_GROUP_RESULT_UNKNOWN" : null,
    error_message: reviewRequired
      ? "일부 대상 그룹의 외부 판매 채널 처리 결과를 확정하지 못했습니다."
      : null,
    review_required_at: reviewRequired ? reviewRequiredAt : null,
  };
}

async function runOwnedLocalFinalization(input: {
  ownership: ClaimedWriteReviewOperation;
  userId: number | null;
  triggerType: string;
  note?: string | null;
}) {
  const requestId = input.ownership.request.sales_channel_write_request_id;
  const attemptId =
    input.ownership.attempt.sales_channel_write_request_attempt_id;
  const finalizedAt = databaseNow();
  let finalizationTargetIds: number[] = [];
  let committedFinalizationRequestStatus: SalesChannelWriteRequestStatus | null =
    null;

  try {
    await runMeasuredTransaction(
      prisma,
      "sales-channel.write-review.local-finalize",
      async (tx) => {
        await assertSalesChannelWriteReviewOwnership(tx, {
          requestId,
          attemptId,
          allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending],
        });
        const request = await tx.sales_channel_write_requests.findUniqueOrThrow({
          where: { sales_channel_write_request_id: requestId },
          select: { request_type: true },
        });
        const beforeFinalization =
          await loadSalesChannelWriteTargetSettlement(tx, requestId);
        finalizationTargetIds = [...beforeFinalization.targetIds];
        if (beforeFinalization.targetIds.length === 0) {
          throw new Error(
            "LOCAL_PENDING request has no pending local-finalization target."
          );
        }

        if (
          request.request_type ===
          SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInventoryQuantityUpdate
        ) {
          await preparePersistedCoupangInventoryQuantityRepairFinalization(
            requestId,
            tx
          );
        }

        await finalizePersistedRequest({
          tx,
          requestId,
          requestType: request.request_type,
          targetIds: finalizationTargetIds,
          actorUserId: input.userId,
          finalizedAt,
        });
        await markSalesChannelWriteTargetsLocalStatus({
          tx,
          requestId,
          targetIds: finalizationTargetIds,
          status: "SUCCEEDED",
          finalizedAt,
        });
        const afterFinalization =
          await loadSalesChannelWriteTargetSettlement(tx, requestId);
        await tx.employee_activity_logs.create({
          data: {
            user_id: input.userId,
            action_type: "SALES_CHANNEL_WRITE_MANUAL_FINALIZE",
            target_type: "SALES_CHANNEL_WRITE_REQUEST",
            target_id: String(requestId),
            ...activityLogChangeData(null, {
              triggerType: input.triggerType,
              note: input.note ?? null,
              targetIds: finalizationTargetIds,
            }),
            result: "SUCCESS",
            created_at: finalizedAt,
          },
        });
        await completeSalesChannelWriteReviewOperation(tx, {
          requestId,
          attemptId,
          allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending],
          requestData: {
            request_status: afterFinalization.requestStatus,
            ...targetGroupReviewContext(
              afterFinalization.requestStatus,
              finalizedAt
            ),
            completed_at:
              afterFinalization.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.completed ||
              afterFinalization.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.partiallyCompleted
                ? finalizedAt
                : null,
            local_finalized_at: finalizedAt,
            updated_at: finalizedAt,
          },
          attemptData: {
            attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
            completed_at: finalizedAt,
          },
        });
        committedFinalizationRequestStatus = afterFinalization.requestStatus;
      }
    );
  } catch (error) {
    const [persisted, persistedAttempt] = await Promise.all([
      prisma.sales_channel_write_requests.findUnique({
        where: { sales_channel_write_request_id: requestId },
        include: {
          targets: {
            orderBy: { target_position: "asc" },
            select: {
              sales_channel_write_request_target_id: true,
              external_result_status: true,
              local_finalization_status: true,
              local_finalized_at: true,
            },
          },
        },
      }),
      prisma.sales_channel_write_request_attempts.findUnique({
        where: { sales_channel_write_request_attempt_id: attemptId },
      }),
    ]);
    if (
      persisted &&
      committedFinalizationRequestStatus !== null &&
      persistedAttempt?.sales_channel_write_request_id === requestId &&
      persisted.active_review_attempt_id !== attemptId &&
      isCommittedSalesChannelWriteLocalFinalization({
        expectedAttempt: {
          requestId,
          attemptId,
          attemptNo: input.ownership.attempt.attempt_no,
          attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize,
          attemptStatus: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
          triggerType: input.triggerType,
          completedAt: finalizedAt,
          requestDispatched: false,
          responseReceived: false,
          externalAppliedUnknown: false,
        },
        requestStatus: persisted.request_status,
        expectedTargetIds: finalizationTargetIds,
        finalizedAt,
        attempt: {
          salesChannelWriteRequestId:
            persistedAttempt.sales_channel_write_request_id,
          salesChannelWriteRequestAttemptId:
            persistedAttempt.sales_channel_write_request_attempt_id,
          attemptNo: persistedAttempt.attempt_no,
          attemptType: persistedAttempt.attempt_type,
          attemptStatus: persistedAttempt.attempt_status,
          triggerType: persistedAttempt.trigger_type,
          completedAt: persistedAttempt.completed_at,
          requestDispatched: persistedAttempt.request_dispatched,
          responseReceived: persistedAttempt.response_received,
          externalAppliedUnknown:
            persistedAttempt.external_applied_unknown,
        },
        targets: persisted.targets.map((target) => ({
          salesChannelWriteRequestTargetId:
            target.sales_channel_write_request_target_id,
          externalResultStatus: target.external_result_status,
          localFinalizationStatus: target.local_finalization_status,
          localFinalizedAt: target.local_finalized_at,
        })),
      })
    ) {
      return persisted;
    }
    if (isSalesChannelWriteReviewOwnershipLost(error)) throw error;

    const completedAt = databaseNow();
    const message = error instanceof Error ? error.message : String(error);

    try {
      await runMeasuredTransaction(
        prisma,
        "sales-channel.write-review.local-finalize-failed",
        async (tx) => {
          await assertSalesChannelWriteReviewOwnership(tx, {
            requestId,
            attemptId,
            allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending],
          });
          const settlement = await loadSalesChannelWriteTargetSettlement(
            tx,
            requestId
          );
          const failedTargetIds = finalizationTargetIds.length
            ? finalizationTargetIds
            : settlement.targetIds;
          await markSalesChannelWriteTargetsLocalStatus({
            tx,
            requestId,
            targetIds: failedTargetIds,
            status: "FAILED",
          });
          return completeSalesChannelWriteReviewOperation(tx, {
            requestId,
            attemptId,
            allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending],
            requestData: {
              request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
              failure_stage:
                SALES_CHANNEL_WRITE_FAILURE_STAGE.localFinalization,
              error_code: "LOCAL_FINALIZATION_ERROR",
              error_message: message,
              review_required_at: completedAt,
              updated_at: completedAt,
            },
            attemptData: {
              attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.failed,
              completed_at: completedAt,
              error_code:
                error instanceof Error
                  ? error.name
                  : "LOCAL_FINALIZATION_ERROR",
              error_message: message,
            },
          });
        }
      );
    } catch {
      // A superseded execution must not overwrite the current owner's state.
    }

    throw error;
  }

  return prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { sales_channel_write_request_id: requestId },
  });
}

async function settleFailedRecheck(
  ownership: ClaimedWriteReviewOperation,
  error: unknown
) {
  const completedAt = databaseNow();
  const message = error instanceof Error ? error.message : String(error);

  try {
    await runMeasuredTransaction(
      prisma,
      "sales-channel.write-review.recheck-failed",
      (tx) =>
        completeSalesChannelWriteReviewOperation(tx, {
          requestId: ownership.request.sales_channel_write_request_id,
          attemptId:
            ownership.attempt.sales_channel_write_request_attempt_id,
          allowedStatuses: [ownership.request.request_status],
          requestData: { updated_at: completedAt },
          attemptData: {
            attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous,
            completed_at: completedAt,
            error_code:
              error instanceof Error ? error.name : "MANUAL_RECHECK_ERROR",
            error_message: message,
            external_applied_unknown: 1,
          },
        })
    );
  } catch (settlementError) {
    if (isSalesChannelWriteReviewOwnershipLost(settlementError)) {
      throw settlementError;
    }
    // The replacement owner is authoritative after a lease transfer.
  }
}

async function recoverCommittedRecheckSettlement(
  ownership: ClaimedWriteReviewOperation,
  settlementWithoutLocalFinalization:
    | CommittedReviewSettlementWithoutLocalFinalization
    | null
) {
  if (settlementWithoutLocalFinalization) {
    const committed = await hasCommittedSalesChannelWriteAttempt(
      settlementWithoutLocalFinalization.expectedAttempt
    );
    return { committed, localAttempt: null } as const;
  }

  const requestId = ownership.request.sales_channel_write_request_id;
  const currentAttemptId =
    ownership.attempt.sales_channel_write_request_attempt_id;
  const [request, currentAttempt] = await Promise.all([
    prisma.sales_channel_write_requests.findUnique({
      where: { sales_channel_write_request_id: requestId },
      include: {
        active_review_attempt: true,
        targets: {
          orderBy: { target_position: "asc" },
          select: {
            sales_channel_write_request_target_id: true,
            external_result_status: true,
            local_finalization_status: true,
          },
        },
      },
    }),
    prisma.sales_channel_write_request_attempts.findUnique({
      where: { sales_channel_write_request_attempt_id: currentAttemptId },
    }),
  ]);
  if (
    !request ||
    currentAttempt?.sales_channel_write_request_id !== requestId ||
    currentAttempt.attempt_type !== SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead ||
    currentAttempt.trigger_type !== "MANUAL_RECHECK" ||
    !currentAttempt.completed_at ||
    currentAttempt.response_received !== 1
  ) {
    return { committed: false as const, localAttempt: null };
  }

  const targets = request.targets.map((target) => ({
    salesChannelWriteRequestTargetId:
      target.sales_channel_write_request_target_id,
    externalResultStatus: target.external_result_status,
    localFinalizationStatus: target.local_finalization_status,
  }));
  const pendingTargetIds = successfulPendingTargetIds(targets);
  const activeAttempt = request.active_review_attempt;
  if (
    request.request_status === SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending &&
    pendingTargetIds.length > 0 &&
    activeAttempt?.attempt_type ===
      SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize &&
    activeAttempt.attempt_status === SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending &&
    activeAttempt.trigger_type === "MANUAL_RECHECK_CONFIRMED" &&
    activeAttempt.attempt_no === currentAttempt.attempt_no + 1
  ) {
    return { committed: true as const, localAttempt: activeAttempt };
  }

  return { committed: false as const, localAttempt: null };
}

export async function recheckSalesChannelWriteRequest(
  input: { requestId: number; userId: number },
  dependencies: SalesChannelWriteReviewDependencies = {}
) {
  const ownership = await claimSalesChannelWriteReviewOperation({
    requestId: input.requestId,
    allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired],
    attempt: {
      attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
      triggerType: "MANUAL_RECHECK",
      method: "GET",
      requestDispatched: true,
    },
    stateConflict: {
      code: "SALES_CHANNEL_RECHECK_STATE_CONFLICT",
    },
  });
  let observation: CoupangWriteVerificationObservation;
  let unknownTargetIds: number[];

  try {
    const unknown = await runMeasuredTransaction(
      prisma,
      "sales-channel.write-review.load-unknown-groups",
      async (tx) => {
        await assertSalesChannelWriteReviewOwnership(tx, {
          requestId: input.requestId,
          attemptId:
            ownership.attempt.sales_channel_write_request_attempt_id,
          allowedStatuses: [ownership.request.request_status],
        });
        return loadUnknownTargetGroups(tx, input.requestId);
      }
    );
    unknownTargetIds = unknown.groups.flatMap((group) => group.targetIds);
    observation = await (
      dependencies.observeWrite ?? observeCoupangWriteRequest
    )({
      requestId: input.requestId,
      triggerType: "MANUAL_RECHECK",
      targetIds: unknownTargetIds,
    });
  } catch (error) {
    await settleFailedRecheck(ownership, error);
    throw error;
  }

  const result = observation.result;
  let localAttempt: Awaited<
    ReturnType<typeof transferSalesChannelWriteReviewOwnership>
  > | null;
  let committedSettlementWithoutLocalFinalization:
    | CommittedReviewSettlementWithoutLocalFinalization
    | null = null;

  try {
    localAttempt = await runMeasuredTransaction(
      prisma,
      "sales-channel.write-review.recheck-settlement",
      async (tx) => {
        await assertSalesChannelWriteReviewOwnership(tx, {
          requestId: input.requestId,
          attemptId:
            ownership.attempt.sales_channel_write_request_attempt_id,
          allowedStatuses: [ownership.request.request_status],
        });
        await (
          dependencies.persistObservation ??
          persistCoupangWriteVerificationObservation
        )(tx, observation);
        const completedAt = databaseNow();
        const settlement = await settleSalesChannelWriteVerificationGroups({
          tx,
          requestId: input.requestId,
          expectedExternalStatuses: ["UNKNOWN"],
          groupResults: result.targetGroups,
          receivedAt: completedAt,
        });

        if (settlement.targetIds.length === 0) {
          await completeSalesChannelWriteReviewOperation(tx, {
            requestId: input.requestId,
            attemptId:
              ownership.attempt.sales_channel_write_request_attempt_id,
            allowedStatuses: [ownership.request.request_status],
            requestData: {
              request_status: settlement.requestStatus,
              failure_stage:
                settlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                  ? SALES_CHANNEL_WRITE_FAILURE_STAGE.externalVerification
                  : null,
              error_code:
                settlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                  ? "MANUAL_RECHECK_NOT_CONFIRMED"
                  : null,
              error_message:
                settlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                  ? "일부 대상 그룹의 외부 판매 채널 처리 결과를 확정하지 못했습니다."
                  : null,
              review_required_at:
                settlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                  ? completedAt
                  : null,
              completed_at:
                settlement.requestStatus ===
                  SALES_CHANNEL_WRITE_REQUEST_STATUS.completed ||
                settlement.requestStatus ===
                  SALES_CHANNEL_WRITE_REQUEST_STATUS.partiallyCompleted
                  ? completedAt
                  : null,
              updated_at: completedAt,
            },
            attemptData: {
              attempt_status:
                settlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                  ? SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous
                  : SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
              completed_at: completedAt,
              external_response_code: result.code,
              external_response_message: null,
              endpoint_path: result.endpointPath,
              response_received: 1,
              external_applied_unknown:
                settlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                  ? 1
                  : 0,
            },
          });
          committedSettlementWithoutLocalFinalization = {
            expectedAttempt: {
              requestId: input.requestId,
              attemptId:
                ownership.attempt.sales_channel_write_request_attempt_id,
              attemptNo: ownership.attempt.attempt_no,
              attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead,
              attemptStatus:
                settlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                  ? SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous
                  : SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
              triggerType: "MANUAL_RECHECK",
              completedAt,
              requestDispatched: true,
              responseReceived: true,
              externalAppliedUnknown:
                settlement.requestStatus ===
                SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
            },
          };
          return null;
        }

        return transferSalesChannelWriteReviewOwnership(tx, {
          requestId: input.requestId,
          currentAttemptId:
            ownership.attempt.sales_channel_write_request_attempt_id,
          allowedStatuses: [ownership.request.request_status],
          nextRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
          requestData: {
            ...targetGroupReviewContext(settlement.requestStatus, completedAt),
            completed_at: null,
            updated_at: completedAt,
          },
          nextAttempt: {
            attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize,
            triggerType: "MANUAL_RECHECK_CONFIRMED",
          },
          currentAttemptData: {
            attempt_status:
              settlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous
                : SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
            completed_at: completedAt,
            external_response_code: result.code,
            external_response_message: null,
            endpoint_path: result.endpointPath,
            response_received: 1,
            external_applied_unknown:
              settlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? 1
                : 0,
          },
        });
      }
    );
  } catch (error) {
    const recovered = await recoverCommittedRecheckSettlement(
      ownership,
      committedSettlementWithoutLocalFinalization
    );
    if (!recovered.committed) {
      await settleFailedRecheck(ownership, error);
      throw error;
    }
    localAttempt = recovered.localAttempt;
  }

  if (localAttempt) {
    await runOwnedLocalFinalization({
      ownership: {
        request: ownership.request,
        attempt: localAttempt,
        startedAt: localAttempt.started_at,
      },
      userId: input.userId,
      triggerType: "MANUAL_RECHECK_CONFIRMED",
      note: "QuickHack 수동 재조회에서 대상 그룹별 채널 반영 상태를 확인했습니다.",
    });
  }

  return {
    confirmed: result.confirmedCount > 0,
    messageCode: result.code,
    messageArguments: result.messageArguments,
  };
}

async function recoverCommittedManualDecisionSettlement(input: {
  ownership: ClaimedWriteReviewOperation;
  targetId: number;
  decision: ManualDecision;
  triggerType: string;
  settlementWithoutLocalFinalization:
    | CommittedReviewSettlementWithoutLocalFinalization
    | null;
}) {
  if (input.settlementWithoutLocalFinalization) {
    const committed = await hasCommittedSalesChannelWriteAttempt(
      input.settlementWithoutLocalFinalization.expectedAttempt
    );
    return { committed, localAttempt: null } as const;
  }

  const requestId = input.ownership.request.sales_channel_write_request_id;
  const attemptId =
    input.ownership.attempt.sales_channel_write_request_attempt_id;
  const [request, attempt] = await Promise.all([
    prisma.sales_channel_write_requests.findUnique({
      where: { sales_channel_write_request_id: requestId },
      include: {
        active_review_attempt: true,
        targets: {
          orderBy: { target_position: "asc" },
          select: {
            sales_channel_write_request_target_id: true,
            external_result_status: true,
            local_finalization_status: true,
          },
        },
      },
    }),
    prisma.sales_channel_write_request_attempts.findUnique({
      where: { sales_channel_write_request_attempt_id: attemptId },
    }),
  ]);
  const expectedExternalStatus =
    input.decision ===
    SALES_CHANNEL_WRITE_MANUAL_VERIFICATION.channelApplied
      ? "SUCCEEDED"
      : "NOT_APPLIED";
  const selectedTarget = request?.targets.find(
    (target) =>
      target.sales_channel_write_request_target_id === input.targetId
  );
  if (
    !request ||
    attempt?.sales_channel_write_request_id !== requestId ||
    attempt.attempt_type !== SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize ||
    attempt.trigger_type !== input.triggerType ||
    selectedTarget?.external_result_status !== expectedExternalStatus
  ) {
    return { committed: false as const, localAttempt: null };
  }

  const targets = request.targets.map((target) => ({
    salesChannelWriteRequestTargetId:
      target.sales_channel_write_request_target_id,
    externalResultStatus: target.external_result_status,
    localFinalizationStatus: target.local_finalization_status,
  }));
  const pendingTargetIds = successfulPendingTargetIds(targets);
  const activeAttempt = request.active_review_attempt;
  if (
    request.request_status === SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending &&
    attempt.attempt_status === SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending &&
    !attempt.completed_at &&
    pendingTargetIds.length > 0 &&
    request.active_review_attempt_id === attemptId &&
    activeAttempt?.sales_channel_write_request_attempt_id === attemptId
  ) {
    return {
      committed: true as const,
      localAttempt: activeAttempt,
    };
  }

  return { committed: false as const, localAttempt: null };
}

async function settleOwnedManualWriteDecision(input: {
  requestId: number;
  userId: number;
  targetId: number;
  decision: ManualDecision;
  note: string;
  triggerType: string;
}) {
  const requestId = input.requestId;
  const decidedAt = databaseNow();
  let ownership: ClaimedWriteReviewOperation | null = null;
  let localAttempt: ClaimedWriteReviewOperation["attempt"] | null = null;
  let committedSettlementWithoutLocalFinalization:
    | CommittedReviewSettlementWithoutLocalFinalization
    | null = null;

  try {
    localAttempt = await runMeasuredTransaction(
      prisma,
      "sales-channel.write-review.manual-decision-settlement",
      async (tx) => {
        const claimed = await claimSalesChannelWriteReviewOperationInTransaction(
          tx,
          {
            requestId: input.requestId,
            allowedStatuses: [
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
            ],
            attempt: {
              attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize,
              triggerType: input.triggerType,
            },
            stateConflict: {
              code: "SALES_CHANNEL_WRITE_REQUEST_STATE_CONFLICT",
            },
          }
        );
        ownership = claimed;
        const attemptId =
          claimed.attempt.sales_channel_write_request_attempt_id;
        const targetGroup = await loadUnknownTargetGroup(tx, {
          requestId,
          targetId: input.targetId,
        });
        const applied =
          input.decision ===
          SALES_CHANNEL_WRITE_MANUAL_VERIFICATION.channelApplied;
        const settlement = await resolveUnknownSalesChannelWriteTargets({
          tx,
          requestId,
          targetIds: targetGroup.targetIds,
          externalStatus: applied ? "SUCCEEDED" : "NOT_APPLIED",
          resultCode: applied
            ? "MANUAL_CHANNEL_APPLIED"
            : "MANUAL_CHANNEL_NOT_APPLIED",
          receivedAt: decidedAt,
        });
        await tx.employee_activity_logs.create({
          data: {
            user_id: input.userId,
            action_type: "SALES_CHANNEL_WRITE_MANUAL_DECISION",
            target_type: "SALES_CHANNEL_WRITE_REQUEST",
            target_id: String(requestId),
            ...activityLogChangeData(null, {
              decision: input.decision,
              note: input.note,
              groupKey: targetGroup.groupKey,
              targetIds: targetGroup.targetIds,
            }),
            result: input.decision,
            created_at: decidedAt,
          },
        });
        const requestData = {
          ...targetGroupReviewContext(settlement.requestStatus, decidedAt),
          completed_at:
            settlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.completed ||
            settlement.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.partiallyCompleted
              ? decidedAt
              : null,
          manual_verification_status: input.decision,
          manual_verified_by_user_id: input.userId,
          manual_verified_at: decidedAt,
          manual_verification_note: input.note,
          updated_at: decidedAt,
        } satisfies Prisma.sales_channel_write_requestsUncheckedUpdateManyInput;

        if (settlement.targetIds.length === 0) {
          await completeSalesChannelWriteReviewOperation(tx, {
            requestId,
            attemptId,
            allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired],
            requestData: {
              ...requestData,
              request_status: settlement.requestStatus,
            },
            attemptData: {
              attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
              completed_at: decidedAt,
            },
          });
          committedSettlementWithoutLocalFinalization = {
            expectedAttempt: {
              requestId,
              attemptId,
              attemptNo: claimed.attempt.attempt_no,
              attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize,
              attemptStatus: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded,
              triggerType: input.triggerType,
              completedAt: decidedAt,
              requestDispatched: false,
              responseReceived: false,
              externalAppliedUnknown: false,
            },
          };
          return null;
        }

        await transitionSalesChannelWriteReviewOwnership(tx, {
          requestId,
          attemptId,
          allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired],
          nextRequestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
          requestData: { ...requestData, completed_at: null },
        });
        return claimed.attempt;
      }
    );
  } catch (error) {
    const recoveredOwnership = ownership as ClaimedWriteReviewOperation | null;
    if (!recoveredOwnership) throw error;
    const recovered = await recoverCommittedManualDecisionSettlement({
      ownership: recoveredOwnership,
      targetId: input.targetId,
      decision: input.decision,
      triggerType: input.triggerType,
      settlementWithoutLocalFinalization:
        committedSettlementWithoutLocalFinalization,
    });
    if (!recovered.committed) {
      throw error;
    }
    localAttempt = recovered.localAttempt;
    if (!localAttempt) {
      return prisma.sales_channel_write_requests.findUniqueOrThrow({
        where: { sales_channel_write_request_id: requestId },
      });
    }
  }

  const committedOwnership = ownership as ClaimedWriteReviewOperation | null;
  if (!committedOwnership) {
    throw new Error("Manual decision ownership was not established.");
  }

  if (localAttempt) {
    return runOwnedLocalFinalization({
      ownership: {
        request: committedOwnership.request,
        attempt: localAttempt,
        startedAt: localAttempt.started_at,
      },
      userId: input.userId,
      triggerType: input.triggerType,
      note: input.note,
    });
  }

  return prisma.sales_channel_write_requests.findUniqueOrThrow({
    where: { sales_channel_write_request_id: requestId },
  });
}

export async function recordManualWriteDecision(input: {
  requestId: number;
  userId: number;
  targetId: number;
  decision: ManualDecision;
  note: unknown;
}) {
  const note = requiredNote(input.note);

  if (
    input.decision ===
      SALES_CHANNEL_WRITE_MANUAL_VERIFICATION.channelApplied ||
    input.decision ===
      SALES_CHANNEL_WRITE_MANUAL_VERIFICATION.channelNotApplied
  ) {
    const applied =
      input.decision ===
      SALES_CHANNEL_WRITE_MANUAL_VERIFICATION.channelApplied;

    return settleOwnedManualWriteDecision({
      requestId: input.requestId,
      userId: input.userId,
      targetId: input.targetId,
      decision: input.decision,
      triggerType: applied
        ? "MANUAL_CHANNEL_APPLIED"
        : "MANUAL_CHANNEL_NOT_APPLIED",
      note,
    });
  }

  const timestamp = databaseNow();

  return runMeasuredTransaction(
    prisma,
    "sales-channel.write-review.manual-decision",
    async (tx) => {
    await assertNoActiveSalesChannelWriteReviewOperation(tx, {
      requestId: input.requestId,
    });
    const current = await tx.sales_channel_write_requests.findUnique({
      where: { sales_channel_write_request_id: input.requestId },
      select: { request_status: true },
    });

    if (
      !current ||
      !SALES_CHANNEL_WRITE_REVIEW_STATUSES.includes(
        current.request_status as (typeof SALES_CHANNEL_WRITE_REVIEW_STATUSES)[number]
      )
    ) {
      throw publicConflict(
        "SALES_CHANNEL_REVIEW_STATE_CONFLICT",
        "SALES_CHANNEL_REVIEW_STATE_CONFLICT"
      );
    }

    if (
      current.request_status ===
      SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending
    ) {
      throw publicConflict(
        "SALES_CHANNEL_LOCAL_FINALIZATION_REQUIRED",
        "SALES_CHANNEL_LOCAL_FINALIZATION_REQUIRED"
      );
    }

    const targetGroup = await loadUnknownTargetGroup(tx, {
      requestId: input.requestId,
      targetId: input.targetId,
    });

    const updated = await tx.sales_channel_write_requests.updateMany({
      where: {
        sales_channel_write_request_id: input.requestId,
        request_status: current.request_status,
        active_review_attempt_id: null,
      },
      data: {
        request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
        manual_verification_status: input.decision,
        manual_verified_by_user_id: input.userId,
        manual_verified_at: timestamp,
        manual_verification_note: note,
        review_required_at: timestamp,
        updated_at: timestamp,
      },
    });

    if (updated.count !== 1) {
      throw publicConflict(
        "SALES_CHANNEL_WRITE_REVIEW_IN_PROGRESS",
        "SALES_CHANNEL_WRITE_REVIEW_IN_PROGRESS"
      );
    }

    await tx.employee_activity_logs.create({
      data: {
        user_id: input.userId,
        action_type: "SALES_CHANNEL_WRITE_MANUAL_DECISION",
        target_type: "SALES_CHANNEL_WRITE_REQUEST",
        target_id: String(input.requestId),
        ...activityLogChangeData(null, {
          decision: input.decision,
          note,
          groupKey: targetGroup.groupKey,
          targetIds: targetGroup.targetIds,
        }),
        result: input.decision,
        created_at: timestamp,
      },
    });

    return tx.sales_channel_write_requests.findUniqueOrThrow({
      where: { sales_channel_write_request_id: input.requestId },
    });
  });
}

export async function retrySalesChannelLocalFinalization(input: {
  requestId: number;
  userId: number;
}) {
  const ownership = await claimSalesChannelWriteReviewOperation({
    requestId: input.requestId,
    allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending],
    attempt: {
      attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize,
      triggerType: "MANUAL_LOCAL_RETRY",
    },
    stateConflict: {
      code: "SALES_CHANNEL_LOCAL_RETRY_STATE_CONFLICT",
    },
  });

  return runOwnedLocalFinalization({
    ownership,
    userId: input.userId,
    triggerType: "MANUAL_LOCAL_RETRY",
  });
}

export async function recoverSalesChannelLocalFinalization(input: {
  requestId: number;
  userId: number | null;
}) {
  const ownership = await claimSalesChannelWriteReviewOperation({
    requestId: input.requestId,
    allowedStatuses: [SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending],
    attempt: {
      attemptType: SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize,
      triggerType: "AUTOMATIC_LOCAL_RECOVERY",
    },
    stateConflict: {
      code: "SALES_CHANNEL_LOCAL_RECOVERY_STATE_CONFLICT",
    },
  });

  return runOwnedLocalFinalization({
    ownership,
    userId: input.userId,
    triggerType: "AUTOMATIC_LOCAL_RECOVERY",
  });
}

export async function listSalesChannelWriteRequests(input: {
  status?: string | null;
  channel?: string | null;
  requestType?: string | null;
  search?: string | null;
  limit?: number;
  sortBy?: "REQUESTED_AT" | "UPDATED_AT";
  updatedCursor?: {
    updatedAt: Date;
    id: number;
    mode: "BEFORE" | "AT_OR_BEFORE" | "EXACT";
  };
}) {
  const search = String(input.search ?? "").trim();
  const status = String(input.status ?? "UNRESOLVED").trim().toUpperCase();
  const requestTypes = Array.from(
    new Set(
      String(input.requestType ?? "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean)
    )
  );
  const baseWhere: Prisma.sales_channel_write_requestsWhereInput = {
    ...(status === "ALL"
      ? {}
      : status === "UNRESOLVED"
        ? { request_status: { in: [...SALES_CHANNEL_WRITE_REVIEW_STATUSES] } }
        : { request_status: status }),
    ...(input.channel ? { channel: String(input.channel).toUpperCase() } : {}),
    ...(requestTypes.length > 0
      ? { request_type: { in: requestTypes } }
      : {}),
    ...(search
      ? {
          OR: [
            { external_order_id: { contains: search } },
            { target_external_id: { contains: search } },
            { pg_no: { contains: search } },
            { error_message: { contains: search } },
            {
              targets: {
                some: { invoice_number_snapshot: { contains: search } },
              },
            },
          ],
        }
      : {}),
  };
  const where: Prisma.sales_channel_write_requestsWhereInput = input.updatedCursor
    ? {
        AND: [
          baseWhere,
          input.updatedCursor.mode === "BEFORE"
            ? { updated_at: { lt: input.updatedCursor.updatedAt } }
            : input.updatedCursor.mode === "AT_OR_BEFORE"
              ? { updated_at: { lte: input.updatedCursor.updatedAt } }
              : {
                  OR: [
                    { updated_at: { lt: input.updatedCursor.updatedAt } },
                    {
                      updated_at: input.updatedCursor.updatedAt,
                      sales_channel_write_request_id: {
                        lt: input.updatedCursor.id,
                      },
                    },
                  ],
                },
        ],
      }
    : baseWhere;
  const [rows, unresolvedCount, filteredCount, controls] = await Promise.all([
    prisma.sales_channel_write_requests.findMany({
      where,
      orderBy:
        input.sortBy === "UPDATED_AT"
          ? [
              { updated_at: "desc" },
              { sales_channel_write_request_id: "desc" },
            ]
          : [
              { requested_at: "desc" },
              { sales_channel_write_request_id: "desc" },
            ],
      take: Math.min(Math.max(input.limit ?? 300, 1), 1001),
      include: {
        targets: {
          orderBy: { sales_channel_write_request_target_id: "asc" },
        },
        attempts: { orderBy: { attempt_no: "desc" } },
        requested_by: {
          select: {
            username: true,
            employee_profiles: { select: { display_name: true } },
          },
        },
        manual_verified_by: {
          select: {
            username: true,
            employee_profiles: { select: { display_name: true } },
          },
        },
      },
    }),
    prisma.sales_channel_write_requests.count({
      where: {
        request_status: { in: [...SALES_CHANNEL_WRITE_REVIEW_STATUSES] },
        ...(requestTypes.length > 0
          ? { request_type: { in: requestTypes } }
          : {}),
      },
    }),
    prisma.sales_channel_write_requests.count({ where: baseWhere }),
    prisma.sales_channel_write_controls.findMany({
      where:
        requestTypes.length > 0
          ? { request_type: { in: requestTypes } }
          : undefined,
      orderBy: [{ is_paused: "desc" }, { channel: "asc" }, { request_type: "asc" }],
    }),
  ]);

  return { rows, unresolvedCount, filteredCount, controls };
}
