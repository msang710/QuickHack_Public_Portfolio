import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  PublicError,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  SALES_CHANNEL_WRITE_ATTEMPT_STATUS,
  SALES_CHANNEL_WRITE_ATTEMPT_TYPE,
} from "@/quickhack_shared/sales-channel/write-requests";
import { createSalesChannelWriteAttempt } from "@/quickhack_server/sales-channel/write/sales-channel-write-execution-ownership";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";
import { parseKstSqlDateTime } from "@/quickhack_shared/core/time";

const REVIEW_OPERATION_LEASE_MS = 15 * 60 * 1000;
const REVIEW_OWNERSHIP_LOST_CODE =
  "SALES_CHANNEL_WRITE_REVIEW_OWNERSHIP_LOST";

type AttemptType =
  (typeof SALES_CHANNEL_WRITE_ATTEMPT_TYPE)[keyof typeof SALES_CHANNEL_WRITE_ATTEMPT_TYPE];

type AttemptMetadata = {
  attemptType: AttemptType;
  triggerType: string;
  method?: string | null;
  endpointPath?: string | null;
  requestDispatched?: boolean;
};

type StateConflict = {
  code: string;
  message: string;
};

function inProgressError() {
  return publicConflict(
    "SALES_CHANNEL_WRITE_REVIEW_IN_PROGRESS",
    "같은 외부 API 요청의 상태 점검 또는 내부 확정 작업이 이미 진행 중입니다. 완료 후 다시 시도하세요."
  );
}

function ownershipLostError() {
  return publicConflict(
    REVIEW_OWNERSHIP_LOST_CODE,
    "이 작업의 처리 소유권이 만료되었거나 다른 작업으로 넘어갔습니다. 최신 상태를 확인하세요."
  );
}

export function isSalesChannelWriteReviewOwnershipLost(error: unknown) {
  return (
    error instanceof PublicError && error.code === REVIEW_OWNERSHIP_LOST_CODE
  );
}

export function isSalesChannelWriteReviewOperationActive(
  heartbeatAt: Date | string | null | undefined,
  now = new Date()
) {
  const heartbeat = parseKstSqlDateTime(heartbeatAt);

  return Boolean(
    heartbeat && now.getTime() - heartbeat.getTime() < REVIEW_OPERATION_LEASE_MS
  );
}

async function expireStaleOperation(
  tx: Prisma.TransactionClient,
  input: {
    requestId: number;
    attemptId: number;
    heartbeatAt: Date | string | null;
    completedAt: Date;
  }
) {
  const released = await tx.sales_channel_write_requests.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      active_review_attempt_id: input.attemptId,
      active_review_heartbeat_at: input.heartbeatAt,
    },
    data: {
      active_review_attempt_id: null,
      active_review_heartbeat_at: null,
      updated_at: input.completedAt,
    },
  });

  if (released.count !== 1) {
    throw inProgressError();
  }

  const attempt = await tx.sales_channel_write_request_attempts.findUnique({
    where: { sales_channel_write_request_attempt_id: input.attemptId },
    select: { attempt_type: true, completed_at: true },
  });

  if (!attempt || attempt.completed_at) return;

  await tx.sales_channel_write_request_attempts.updateMany({
    where: {
      sales_channel_write_request_attempt_id: input.attemptId,
      sales_channel_write_request_id: input.requestId,
      attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending,
    },
    data: {
      attempt_status:
        attempt.attempt_type === SALES_CHANNEL_WRITE_ATTEMPT_TYPE.localFinalize
          ? SALES_CHANNEL_WRITE_ATTEMPT_STATUS.failed
          : SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous,
      completed_at: input.completedAt,
      error_code: "SALES_CHANNEL_WRITE_REVIEW_LEASE_EXPIRED",
      error_message:
        "진행 중이던 상태 점검 또는 내부 확정 작업의 소유권이 만료되었습니다.",
      external_applied_unknown:
        attempt.attempt_type === SALES_CHANNEL_WRITE_ATTEMPT_TYPE.verifyRead
          ? 1
          : undefined,
    },
  });
}

async function releaseExpiredOperationIfNeeded(
  tx: Prisma.TransactionClient,
  input: {
    requestId: number;
    activeAttemptId: number | null;
    heartbeatAt: Date | string | null;
    now: Date;
  }
) {
  if (input.activeAttemptId === null) return;

  if (isSalesChannelWriteReviewOperationActive(input.heartbeatAt, input.now)) {
    throw inProgressError();
  }

  await expireStaleOperation(tx, {
    requestId: input.requestId,
    attemptId: input.activeAttemptId,
    heartbeatAt: input.heartbeatAt,
    completedAt: databaseDateTime(input.now),
  });
}

type SalesChannelWriteReviewClaimInput = {
  requestId: number;
  allowedStatuses: readonly string[];
  requiredFailureStage?: string;
  attempt: AttemptMetadata;
  stateConflict: StateConflict;
  now?: Date;
};

export async function claimSalesChannelWriteReviewOperationInTransaction(
  tx: Prisma.TransactionClient,
  input: SalesChannelWriteReviewClaimInput
) {
  const now = input.now ?? new Date();
  const startedAt = databaseDateTime(now);
  const locked = await tx.$queryRaw<Array<{ sales_channel_write_request_id: number }>>`
    SELECT sales_channel_write_request_id
    FROM sales_channel_write_requests
    WHERE sales_channel_write_request_id = ${input.requestId}
    FOR UPDATE
  `;
  const request = locked.length === 1
    ? await tx.sales_channel_write_requests.findUnique({
        where: { sales_channel_write_request_id: input.requestId },
      })
    : null;

  if (!request) {
    throw publicNotFound(
      "SALES_CHANNEL_WRITE_REQUEST_NOT_FOUND",
      "외부 API 대기 요청을 찾을 수 없습니다."
    );
  }

  if (
    !input.allowedStatuses.includes(request.request_status) ||
    (input.requiredFailureStage !== undefined &&
      request.failure_stage !== input.requiredFailureStage)
  ) {
    throw publicConflict(input.stateConflict.code, input.stateConflict.message);
  }

  await releaseExpiredOperationIfNeeded(tx, {
    requestId: input.requestId,
    activeAttemptId: request.active_review_attempt_id,
    heartbeatAt: request.active_review_heartbeat_at,
    now,
  });

  const attempt = await createSalesChannelWriteAttempt(tx, {
    requestId: input.requestId,
    attemptType: input.attempt.attemptType,
    triggerType: input.attempt.triggerType,
    method: input.attempt.method,
    endpointPath: input.attempt.endpointPath,
    startedAt,
    requestDispatched: input.attempt.requestDispatched,
  });
  const claimed = await tx.sales_channel_write_requests.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      request_status: { in: [...input.allowedStatuses] },
      ...(input.requiredFailureStage !== undefined
        ? { failure_stage: input.requiredFailureStage }
        : {}),
      active_review_attempt_id: null,
      active_review_heartbeat_at: null,
    },
    data: {
      active_review_attempt_id: attempt.sales_channel_write_request_attempt_id,
      active_review_heartbeat_at: startedAt,
      updated_at: startedAt,
    },
  });

  if (claimed.count !== 1) {
    throw inProgressError();
  }

  return { request, attempt, startedAt };
}

export async function claimSalesChannelWriteReviewOperation(
  input: SalesChannelWriteReviewClaimInput
) {
  return runMeasuredTransaction(
    prisma,
    "sales-channel.write-review.claim",
    (tx) => claimSalesChannelWriteReviewOperationInTransaction(tx, input)
  );
}

export async function assertSalesChannelWriteReviewOwnership(
  tx: Prisma.TransactionClient,
  input: {
    requestId: number;
    attemptId: number;
    allowedStatuses?: readonly string[];
    now?: Date;
  }
) {
  const heartbeatAt = databaseDateTime(input.now ?? new Date());
  const owned = await tx.sales_channel_write_requests.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      active_review_attempt_id: input.attemptId,
      ...(input.allowedStatuses
        ? { request_status: { in: [...input.allowedStatuses] } }
        : {}),
    },
    data: { active_review_heartbeat_at: heartbeatAt },
  });

  if (owned.count !== 1) {
    throw ownershipLostError();
  }

  return heartbeatAt;
}

export async function transferSalesChannelWriteReviewOwnership(
  tx: Prisma.TransactionClient,
  input: {
    requestId: number;
    currentAttemptId: number;
    nextAttempt: AttemptMetadata;
    nextRequestStatus: string;
    requestData?: Prisma.sales_channel_write_requestsUncheckedUpdateManyInput;
    currentAttemptData: Prisma.sales_channel_write_request_attemptsUncheckedUpdateManyInput;
    allowedStatuses: readonly string[];
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const startedAt = await assertSalesChannelWriteReviewOwnership(tx, {
    requestId: input.requestId,
    attemptId: input.currentAttemptId,
    allowedStatuses: input.allowedStatuses,
    now,
  });
  const nextAttempt = await createSalesChannelWriteAttempt(tx, {
    requestId: input.requestId,
    attemptType: input.nextAttempt.attemptType,
    triggerType: input.nextAttempt.triggerType,
    method: input.nextAttempt.method,
    endpointPath: input.nextAttempt.endpointPath,
    startedAt,
    requestDispatched: input.nextAttempt.requestDispatched,
  });
  const transferred = await tx.sales_channel_write_requests.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      active_review_attempt_id: input.currentAttemptId,
      request_status: { in: [...input.allowedStatuses] },
    },
    data: {
      ...(input.requestData ?? {}),
      request_status: input.nextRequestStatus,
      active_review_attempt_id:
        nextAttempt.sales_channel_write_request_attempt_id,
      active_review_heartbeat_at: startedAt,
      updated_at: startedAt,
    },
  });

  if (transferred.count !== 1) {
    throw ownershipLostError();
  }

  const attemptUpdated = await tx.sales_channel_write_request_attempts.updateMany({
    where: {
      sales_channel_write_request_attempt_id: input.currentAttemptId,
      sales_channel_write_request_id: input.requestId,
      attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending,
    },
    data: input.currentAttemptData,
  });

  if (attemptUpdated.count !== 1) {
    throw ownershipLostError();
  }

  return nextAttempt;
}

export async function transitionSalesChannelWriteReviewOwnership(
  tx: Prisma.TransactionClient,
  input: {
    requestId: number;
    attemptId: number;
    allowedStatuses: readonly string[];
    nextRequestStatus: string;
    requestData?: Prisma.sales_channel_write_requestsUncheckedUpdateManyInput;
    now?: Date;
  }
) {
  const heartbeatAt = await assertSalesChannelWriteReviewOwnership(tx, {
    requestId: input.requestId,
    attemptId: input.attemptId,
    allowedStatuses: input.allowedStatuses,
    now: input.now,
  });
  const transitioned = await tx.sales_channel_write_requests.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      active_review_attempt_id: input.attemptId,
      request_status: { in: [...input.allowedStatuses] },
    },
    data: {
      ...(input.requestData ?? {}),
      request_status: input.nextRequestStatus,
      active_review_heartbeat_at: heartbeatAt,
      updated_at: heartbeatAt,
    },
  });

  if (transitioned.count !== 1) {
    throw ownershipLostError();
  }
}

export async function completeSalesChannelWriteReviewOperation(
  tx: Prisma.TransactionClient,
  input: {
    requestId: number;
    attemptId: number;
    requestData?: Prisma.sales_channel_write_requestsUncheckedUpdateManyInput;
    attemptData: Prisma.sales_channel_write_request_attemptsUncheckedUpdateManyInput;
    allowedStatuses: readonly string[];
    now?: Date;
  }
) {
  await assertSalesChannelWriteReviewOwnership(tx, {
    requestId: input.requestId,
    attemptId: input.attemptId,
    allowedStatuses: input.allowedStatuses,
    now: input.now,
  });
  const released = await tx.sales_channel_write_requests.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      active_review_attempt_id: input.attemptId,
      request_status: { in: [...input.allowedStatuses] },
    },
    data: {
      ...(input.requestData ?? {}),
      active_review_attempt_id: null,
      active_review_heartbeat_at: null,
    },
  });

  if (released.count !== 1) {
    throw ownershipLostError();
  }

  const attemptUpdated = await tx.sales_channel_write_request_attempts.updateMany({
    where: {
      sales_channel_write_request_attempt_id: input.attemptId,
      sales_channel_write_request_id: input.requestId,
      attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending,
    },
    data: input.attemptData,
  });

  if (attemptUpdated.count !== 1) {
    throw ownershipLostError();
  }
}

export async function assertNoActiveSalesChannelWriteReviewOperation(
  tx: Prisma.TransactionClient,
  input: { requestId: number; now?: Date }
) {
  const now = input.now ?? new Date();
  const request = await tx.sales_channel_write_requests.findUnique({
    where: { sales_channel_write_request_id: input.requestId },
    select: {
      active_review_attempt_id: true,
      active_review_heartbeat_at: true,
    },
  });

  if (!request) {
    throw publicNotFound(
      "SALES_CHANNEL_WRITE_REQUEST_NOT_FOUND",
      "외부 API 대기 요청을 찾을 수 없습니다."
    );
  }

  await releaseExpiredOperationIfNeeded(tx, {
    requestId: input.requestId,
    activeAttemptId: request.active_review_attempt_id,
    heartbeatAt: request.active_review_heartbeat_at,
    now,
  });
}
