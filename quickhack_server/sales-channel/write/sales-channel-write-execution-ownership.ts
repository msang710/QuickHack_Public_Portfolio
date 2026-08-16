import type { Prisma } from "@/generated/prisma/client";
import {
  PublicError,
  publicConflict,
} from "@/quickhack_server/core/public-error";
import { SALES_CHANNEL_WRITE_ATTEMPT_STATUS } from "@/quickhack_shared/sales-channel/write-requests";

const OWNERSHIP_LOST_CODE = "SALES_CHANNEL_WRITE_EXECUTION_OWNERSHIP_LOST";

type AttemptInput = {
  requestId: number;
  attemptType: string;
  triggerType: string;
  method?: string | null;
  endpointPath?: string | null;
  startedAt: Date;
  requestDispatched?: boolean;
  integrationCommandId?: string | null;
};

type ExpectedOwnedAttempt = {
  requestId: number;
  attemptId: number;
  expectedRequestStatus: string;
  expectedAttemptType: string;
  expectedRequestDispatched?: boolean;
};

function ownershipLost() {
  return publicConflict(
    OWNERSHIP_LOST_CODE,
    "판매 채널 쓰기 실행 소유권이 만료되었거나 다른 실행으로 넘어갔습니다. 최신 처리 상태를 확인하세요."
  );
}

export function isSalesChannelWriteExecutionOwnershipLost(error: unknown) {
  return error instanceof PublicError && error.code === OWNERSHIP_LOST_CODE;
}

async function nextAttemptNumber(
  tx: Prisma.TransactionClient,
  requestId: number
) {
  const latest = await tx.sales_channel_write_request_attempts.findFirst({
    where: { sales_channel_write_request_id: requestId },
    orderBy: { attempt_no: "desc" },
    select: { attempt_no: true },
  });

  return (latest?.attempt_no ?? 0) + 1;
}

export async function createSalesChannelWriteAttempt(
  tx: Prisma.TransactionClient,
  input: AttemptInput
) {
  const attemptNo = await nextAttemptNumber(tx, input.requestId);

  return tx.sales_channel_write_request_attempts.create({
    data: {
      sales_channel_write_request_id: input.requestId,
      attempt_no: attemptNo,
      attempt_type: input.attemptType,
      attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending,
      trigger_type: input.triggerType,
      method: input.method ?? null,
      endpoint_path: input.endpointPath ?? null,
      started_at: input.startedAt,
      request_dispatched: input.requestDispatched ? 1 : 0,
      integration_command_id: input.integrationCommandId ?? null,
      created_at: input.startedAt,
    },
  });
}

function ownedAttemptWhere(input: ExpectedOwnedAttempt) {
  return {
    sales_channel_write_request_attempt_id: input.attemptId,
    sales_channel_write_request_id: input.requestId,
    attempt_type: input.expectedAttemptType,
    attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending,
    ...(input.expectedRequestDispatched === undefined
      ? {}
      : { request_dispatched: input.expectedRequestDispatched ? 1 : 0 }),
  };
}

export async function assertOwnedSalesChannelWriteAttempt(
  tx: Prisma.TransactionClient,
  input: ExpectedOwnedAttempt
) {
  const [request, attempt] = await Promise.all([
    tx.sales_channel_write_requests.findFirst({
      where: {
        sales_channel_write_request_id: input.requestId,
        request_status: input.expectedRequestStatus,
        active_review_attempt_id: null,
      },
      select: { sales_channel_write_request_id: true },
    }),
    tx.sales_channel_write_request_attempts.findFirst({
      where: ownedAttemptWhere(input),
      select: { sales_channel_write_request_attempt_id: true },
    }),
  ]);
  if (!request || !attempt) throw ownershipLost();
}

export async function transitionOwnedSalesChannelWriteAttempt(
  tx: Prisma.TransactionClient,
  input: ExpectedOwnedAttempt & {
    requestData: Prisma.sales_channel_write_requestsUncheckedUpdateManyInput;
    attemptData: Prisma.sales_channel_write_request_attemptsUncheckedUpdateManyInput;
  }
) {
  const requestUpdated = await tx.sales_channel_write_requests.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      request_status: input.expectedRequestStatus,
      active_review_attempt_id: null,
    },
    data: input.requestData,
  });

  if (requestUpdated.count !== 1) {
    throw ownershipLost();
  }

  const attemptUpdated =
    await tx.sales_channel_write_request_attempts.updateMany({
      where: ownedAttemptWhere(input),
      data: input.attemptData,
    });

  if (attemptUpdated.count !== 1) {
    throw ownershipLost();
  }
}

export async function transferOwnedSalesChannelWriteAttempt(
  tx: Prisma.TransactionClient,
  input: ExpectedOwnedAttempt & {
    nextRequestStatus: string;
    requestData: Prisma.sales_channel_write_requestsUncheckedUpdateManyInput;
    currentAttemptData: Prisma.sales_channel_write_request_attemptsUncheckedUpdateManyInput;
    nextAttempt: Omit<AttemptInput, "requestId">;
    bindNextAsActiveReviewAttempt?: boolean;
  }
) {
  const requestUpdated = await tx.sales_channel_write_requests.updateMany({
    where: {
      sales_channel_write_request_id: input.requestId,
      request_status: input.expectedRequestStatus,
      active_review_attempt_id: null,
    },
    data: {
      ...input.requestData,
      request_status: input.nextRequestStatus,
    },
  });

  if (requestUpdated.count !== 1) {
    throw ownershipLost();
  }

  const attemptUpdated =
    await tx.sales_channel_write_request_attempts.updateMany({
      where: ownedAttemptWhere(input),
      data: input.currentAttemptData,
    });

  if (attemptUpdated.count !== 1) {
    throw ownershipLost();
  }

  const nextAttempt = await createSalesChannelWriteAttempt(tx, {
    requestId: input.requestId,
    ...input.nextAttempt,
  });

  if (input.bindNextAsActiveReviewAttempt) {
    const bound = await tx.sales_channel_write_requests.updateMany({
      where: {
        sales_channel_write_request_id: input.requestId,
        request_status: input.nextRequestStatus,
        active_review_attempt_id: null,
      },
      data: {
        active_review_attempt_id:
          nextAttempt.sales_channel_write_request_attempt_id,
        active_review_heartbeat_at: input.nextAttempt.startedAt,
      },
    });

    if (bound.count !== 1) {
      throw ownershipLost();
    }
  }

  return nextAttempt;
}
