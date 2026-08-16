import {
  SALES_CHANNEL_WRITE_ATTEMPT_STATUS,
  SALES_CHANNEL_WRITE_ATTEMPT_TYPE,
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
  SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS,
  SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS,
  type SalesChannelWriteRequestStatus,
} from "@/quickhack_shared/sales-channel/write-requests";
import { parseKstSqlDateTime } from "@/quickhack_shared/core/time";

type PersistedTimestamp = Date | string;

function sameTimestamp(
  left: PersistedTimestamp | null,
  right: PersistedTimestamp | null
) {
  if (left === null || right === null) return left === right;

  return (
    parseKstSqlDateTime(left)?.getTime() ===
    parseKstSqlDateTime(right)?.getTime()
  );
}

export type SalesChannelWriteTargetState = {
  externalResultStatus: string;
  localFinalizationStatus: string;
};

export type SalesChannelWriteAttemptCommitExpectation = {
  requestId: number;
  attemptId: number;
  attemptNo: number;
  attemptType: string;
  attemptStatus: string;
  triggerType: string;
  completedAt: PersistedTimestamp;
  requestDispatched: boolean;
  responseReceived: boolean;
  externalAppliedUnknown: boolean;
};

export type SalesChannelWriteAttemptCommitState = {
  salesChannelWriteRequestId: number;
  salesChannelWriteRequestAttemptId: number;
  attemptNo: number;
  attemptType: string;
  attemptStatus: string;
  triggerType: string;
  completedAt: PersistedTimestamp | null;
  requestDispatched: number;
  responseReceived: number;
  externalAppliedUnknown: number;
};

export function isCommittedSalesChannelWriteAttempt(input: {
  expected: SalesChannelWriteAttemptCommitExpectation;
  attempt: SalesChannelWriteAttemptCommitState;
}) {
  return (
    input.attempt.salesChannelWriteRequestId === input.expected.requestId &&
    input.attempt.salesChannelWriteRequestAttemptId ===
      input.expected.attemptId &&
    input.attempt.attemptNo === input.expected.attemptNo &&
    input.attempt.attemptType === input.expected.attemptType &&
    input.attempt.attemptStatus === input.expected.attemptStatus &&
    input.attempt.triggerType === input.expected.triggerType &&
    sameTimestamp(input.attempt.completedAt, input.expected.completedAt) &&
    input.attempt.requestDispatched ===
      (input.expected.requestDispatched ? 1 : 0) &&
    input.attempt.responseReceived ===
      (input.expected.responseReceived ? 1 : 0) &&
    input.attempt.externalAppliedUnknown ===
      (input.expected.externalAppliedUnknown ? 1 : 0)
  );
}

export function deriveSalesChannelWriteRequestStatus(
  targets: readonly SalesChannelWriteTargetState[]
): SalesChannelWriteRequestStatus {
  if (targets.length === 0) {
    return SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired;
  }

  if (
    targets.some(
      (target) =>
        target.externalResultStatus ===
        SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.unknown
    )
  ) {
    return SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired;
  }

  if (
    targets.some(
      (target) =>
        target.externalResultStatus ===
          SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded &&
        target.localFinalizationStatus !==
          SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.succeeded
    )
  ) {
    return SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending;
  }

  const succeeded = targets.filter(
    (target) =>
      target.externalResultStatus ===
      SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded
  ).length;
  const notApplied = targets.filter(
    (target) =>
      target.externalResultStatus ===
      SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied
  ).length;

  if (notApplied === targets.length) {
    return SALES_CHANNEL_WRITE_REQUEST_STATUS.notApplied;
  }
  if (succeeded === targets.length) {
    return SALES_CHANNEL_WRITE_REQUEST_STATUS.completed;
  }
  if (succeeded > 0 && succeeded + notApplied === targets.length) {
    return SALES_CHANNEL_WRITE_REQUEST_STATUS.partiallyCompleted;
  }

  return SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired;
}

export function successfulPendingTargetIds<
  T extends SalesChannelWriteTargetState & {
    salesChannelWriteRequestTargetId: number;
  },
>(targets: readonly T[]) {
  return targets
    .filter(
      (target) =>
        target.externalResultStatus ===
          SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded &&
        target.localFinalizationStatus !==
          SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.succeeded
    )
    .map((target) => target.salesChannelWriteRequestTargetId);
}

export function isCommittedSalesChannelWriteLocalFinalization(input: {
  expectedAttempt: SalesChannelWriteAttemptCommitExpectation;
  requestStatus: string;
  expectedTargetIds: readonly number[];
  finalizedAt: PersistedTimestamp;
  attempt: SalesChannelWriteAttemptCommitState;
  targets: readonly (SalesChannelWriteTargetState & {
    salesChannelWriteRequestTargetId: number;
    localFinalizedAt: PersistedTimestamp | null;
  })[];
}) {
  if (input.expectedTargetIds.length === 0) return false;

  const uniqueExpectedTargetIds = new Set(input.expectedTargetIds);
  if (
    uniqueExpectedTargetIds.size !== input.expectedTargetIds.length ||
    input.expectedAttempt.attemptType !==
      SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize ||
    input.expectedAttempt.attemptStatus !==
      SALES_CHANNEL_WRITE_ATTEMPT_STATUS.succeeded ||
    !sameTimestamp(input.expectedAttempt.completedAt, input.finalizedAt) ||
    !isCommittedSalesChannelWriteAttempt({
      expected: input.expectedAttempt,
      attempt: input.attempt,
    }) ||
    deriveSalesChannelWriteRequestStatus(input.targets) !== input.requestStatus
  ) {
    return false;
  }

  const targetsById = new Map(
    input.targets.map((target) => [
      target.salesChannelWriteRequestTargetId,
      target,
    ])
  );

  return input.expectedTargetIds.every((targetId) => {
    const target = targetsById.get(targetId);
    return Boolean(
      target &&
        target.externalResultStatus ===
          SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded &&
        target.localFinalizationStatus ===
          SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.succeeded &&
        sameTimestamp(target.localFinalizedAt, input.finalizedAt)
    );
  });
}
