import { prisma } from "@/quickhack_server/core/prisma";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { markPendingSalesChannelWriteTargets } from "@/quickhack_server/sales-channel/write/sales-channel-write-target-service";
import {
  SALES_CHANNEL_WRITE_ATTEMPT_STATUS,
  SALES_CHANNEL_WRITE_ATTEMPT_TYPE,
  SALES_CHANNEL_WRITE_FAILURE_STAGE,
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
} from "@/quickhack_shared/sales-channel/write-requests";
import {
  parseKstSqlDateTime,
  quickHackClock,
} from "@/quickhack_shared/core/time";
import { preserveKoreanSnapshot } from "@/quickhack_shared/i18n/preserved-snapshot";

const RECOVERABLE_REQUEST_STATUSES = [
  SALES_CHANNEL_WRITE_REQUEST_STATUS.pending,
  SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
  SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying,
] as const;
const DEFAULT_STALE_AFTER_MINUTES = 15;
const WORKER_LEASE_GRACE_SECONDS = 60;

type RecoveryOptions = {
  now?: Date;
  staleAfterMinutes?: number;
};

type WorkerSnapshot = {
  status: string;
  started_at: Date | null;
  lease_token: string | null;
  locked_until: Date | null;
};

function positiveNumber(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function workerStillOwnsRequest(input: {
  now: Date;
  phaseStartedAt: Date | string;
  worker: WorkerSnapshot | null;
}) {
  const worker = input.worker;

  if (
    !worker ||
    worker.status !== "RUNNING" ||
    !worker.lease_token ||
    !worker.locked_until ||
    !worker.started_at
  ) {
    return false;
  }

  const lockedUntil = parseKstSqlDateTime(worker.locked_until);
  const workerStartedAt = parseKstSqlDateTime(worker.started_at);
  const phaseStartedAt = parseKstSqlDateTime(input.phaseStartedAt);

  if (!lockedUntil || !workerStartedAt || !phaseStartedAt) {
    return false;
  }

  const leaseGraceBoundary =
    input.now.getTime() - WORKER_LEASE_GRACE_SECONDS * 1000;

  return (
    lockedUntil.getTime() > leaseGraceBoundary &&
    phaseStartedAt.getTime() >= workerStartedAt.getTime()
  );
}

function recoveryState(input: {
  requestStatus: string;
  activeAttempt:
    | {
        attempt_type: string;
        request_dispatched: number;
      }
    | undefined;
}) {
  const definitelyNotDispatched =
    input.requestStatus === SALES_CHANNEL_WRITE_REQUEST_STATUS.pending ||
    (input.requestStatus === SALES_CHANNEL_WRITE_REQUEST_STATUS.sending &&
      input.activeAttempt?.attempt_type ===
        SALES_CHANNEL_WRITE_ATTEMPT_TYPE.write &&
      input.activeAttempt.request_dispatched === 0);

  if (definitelyNotDispatched) {
    return {
      requestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.notApplied,
      attemptStatus: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.failed,
      failureStage: SALES_CHANNEL_WRITE_FAILURE_STAGE.writeTransport,
      errorCode: "PROCESS_INTERRUPTED_BEFORE_DISPATCH",
      errorMessage: preserveKoreanSnapshot(
        "서버 처리가 외부 쓰기 API 전송 전에 중단되어 채널에 반영되지 않았습니다."
      ),
      externalAppliedUnknown: false,
    } as const;
  }

  if (input.requestStatus === SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying) {
    return {
      requestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
      attemptStatus: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous,
      failureStage: SALES_CHANNEL_WRITE_FAILURE_STAGE.externalVerification,
      errorCode: "PROCESS_INTERRUPTED_DURING_VERIFICATION",
      errorMessage: preserveKoreanSnapshot(
        "서버 처리가 채널 반영 확인 중 중단되었습니다. 외부 쓰기를 재전송하지 말고 판매 채널 동기화 점검에서 결과를 확인하세요."
      ),
      externalAppliedUnknown: true,
    } as const;
  }

  return {
    requestStatus: SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
    attemptStatus: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.ambiguous,
    failureStage: SALES_CHANNEL_WRITE_FAILURE_STAGE.writeTransport,
    errorCode: "PROCESS_INTERRUPTED_AFTER_DISPATCH",
    errorMessage: preserveKoreanSnapshot(
      "외부 쓰기 API 전송 이후 서버 처리가 중단되어 채널 반영 여부를 확정할 수 없습니다. 쓰기를 재전송하지 말고 판매 채널 동기화 점검에서 결과를 확인하세요."
    ),
    externalAppliedUnknown: true,
  } as const;
}

export async function recoverInterruptedSalesChannelWrites(
  options: RecoveryOptions = {}
) {
  const now = options.now ?? quickHackClock.nowDate();
  const staleAfterMinutes = positiveNumber(
    options.staleAfterMinutes,
    DEFAULT_STALE_AFTER_MINUTES
  );
  const staleBefore = new Date(
    now.getTime() - staleAfterMinutes * 60 * 1000
  );

  return runMeasuredTransaction(
    prisma,
    "sales-channel.write.recover-interrupted",
    async (tx) => {
      const candidates = await tx.sales_channel_write_requests.findMany({
        where: {
          request_status: { in: [...RECOVERABLE_REQUEST_STATUSES] },
          updated_at: { lte: staleBefore },
          active_review_attempt_id: null,
        },
        orderBy: { sales_channel_write_request_id: "asc" },
        select: {
          sales_channel_write_request_id: true,
          request_status: true,
          sending_at: true,
          verifying_at: true,
          updated_at: true,
          worker_job: {
            select: {
              status: true,
              started_at: true,
              lease_token: true,
              locked_until: true,
            },
          },
          attempts: {
            where: {
              attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending,
            },
            orderBy: { attempt_no: "desc" },
            take: 1,
            select: {
              sales_channel_write_request_attempt_id: true,
              attempt_type: true,
              attempt_status: true,
              request_dispatched: true,
            },
          },
        },
      });
      const recoveredIds: number[] = [];
      let activeOwnerCount = 0;
      let changedBeforeRecoveryCount = 0;
      let notAppliedCount = 0;
      let reviewRequiredCount = 0;

      for (const candidate of candidates) {
        const phaseStartedAt =
          candidate.request_status ===
          SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying
            ? candidate.verifying_at ?? candidate.updated_at
            : candidate.sending_at ?? candidate.updated_at;

        if (
          workerStillOwnsRequest({
            now,
            phaseStartedAt,
            worker: candidate.worker_job,
          })
        ) {
          activeOwnerCount += 1;
          continue;
        }

        const activeAttempt = candidate.attempts[0];
        const recovery = recoveryState({
          requestStatus: candidate.request_status,
          activeAttempt,
        });
        const updated = await tx.sales_channel_write_requests.updateMany({
          where: {
            sales_channel_write_request_id:
              candidate.sales_channel_write_request_id,
            request_status: candidate.request_status,
            updated_at: candidate.updated_at,
            active_review_attempt_id: null,
          },
          data: {
            request_status: recovery.requestStatus,
            failure_stage: recovery.failureStage,
            error_code: recovery.errorCode,
            error_message: recovery.errorMessage,
            review_required_at:
              recovery.requestStatus ===
              SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired
                ? now
                : null,
            updated_at: now,
          },
        });

        if (updated.count !== 1) {
          changedBeforeRecoveryCount += 1;
          continue;
        }

        await markPendingSalesChannelWriteTargets({
          tx,
          requestId: candidate.sales_channel_write_request_id,
          externalStatus:
            recovery.requestStatus ===
            SALES_CHANNEL_WRITE_REQUEST_STATUS.notApplied
              ? "NOT_APPLIED"
              : "UNKNOWN",
          resultCode: recovery.errorCode,
          receivedAt: now,
        });

        if (activeAttempt) {
          const attemptUpdated =
            await tx.sales_channel_write_request_attempts.updateMany({
              where: {
                sales_channel_write_request_attempt_id:
                  activeAttempt.sales_channel_write_request_attempt_id,
                sales_channel_write_request_id:
                  candidate.sales_channel_write_request_id,
                attempt_type: activeAttempt.attempt_type,
                attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.sending,
                request_dispatched: activeAttempt.request_dispatched,
              },
              data: {
                attempt_status: recovery.attemptStatus,
                completed_at: now,
                error_code: recovery.errorCode,
                error_message: recovery.errorMessage,
                external_applied_unknown: recovery.externalAppliedUnknown ? 1 : 0,
              },
            });

          if (attemptUpdated.count !== 1) {
            throw new Error(
              `판매 채널 쓰기 복구 중 attempt ${activeAttempt.sales_channel_write_request_attempt_id} 상태가 변경되었습니다.`
            );
          }
        }

        recoveredIds.push(candidate.sales_channel_write_request_id);
        if (
          recovery.requestStatus ===
          SALES_CHANNEL_WRITE_REQUEST_STATUS.notApplied
        ) {
          notAppliedCount += 1;
        } else {
          reviewRequiredCount += 1;
        }
      }

      if (recoveredIds.length > 0) {
        await tx.server_job_logs.create({
          data: {
            job_type: "SALES_CHANNEL_WRITE_RECOVERY",
            job_name: "Sales-channel interrupted write recovery",
            status: "SUCCESS",
            started_at: now,
            finished_at: now,
            duration_ms: 0,
            summary_text: `중단된 판매 채널 쓰기 ${recoveredIds.length}건을 안전 상태로 회수했습니다. 미전송 ${notAppliedCount}건, 직접 확인 필요 ${reviewRequiredCount}건입니다.`,
            summary_processed_count: candidates.length,
            summary_succeeded_count: recoveredIds.length,
            summary_failed_count: 0,
            summary_skipped_count:
              activeOwnerCount + changedBeforeRecoveryCount,
            summary_warning_count: reviewRequiredCount,
            created_at: now,
          },
        });
      }

      return {
        checkedCount: candidates.length,
        recoveredCount: recoveredIds.length,
        notAppliedCount,
        reviewRequiredCount,
        activeOwnerCount,
        changedBeforeRecoveryCount,
        recoveredIds,
        staleBefore,
      };
    }
  );
}
