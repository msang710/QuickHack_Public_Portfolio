import { prisma } from "@/quickhack_server/core/prisma";
import {
  parseKstSqlDateTime,
  quickHackClock,
} from "@/quickhack_shared/core/time";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

const NON_TERMINAL_STATUSES = ["PENDING", "RECEIVED", "PROCESSING"];
const INTERRUPTED_ERROR_CODE = "PROCESS_INTERRUPTED";
const DEFAULT_STALE_AFTER_MINUTES = 15;
const WORKER_LEASE_GRACE_SECONDS = 60;
const HEALTH_LOOKBACK_HOURS = 24;

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

function interruptionStage(input: {
  received_at: Date | null;
  processing_started_at: Date | null;
}) {
  if (input.processing_started_at) {
    return "PROCESSING";
  }

  if (input.received_at) {
    return "RECEIVED";
  }

  return "PENDING";
}

function workerStillOwnsCall(input: {
  now: Date;
  requestStartedAt: Date | string;
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
  const requestStartedAt = parseKstSqlDateTime(input.requestStartedAt);

  if (!lockedUntil || !workerStartedAt || !requestStartedAt) {
    return false;
  }

  const leaseGraceBoundary =
    input.now.getTime() - WORKER_LEASE_GRACE_SECONDS * 1000;

  return (
    lockedUntil.getTime() > leaseGraceBoundary &&
    requestStartedAt.getTime() >= workerStartedAt.getTime()
  );
}

export async function recoverInterruptedCoupangReadSyncs(
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
    "coupang.read-sync.recover-interrupted",
    async (tx) => {
    const candidates = await tx.coupang_api_call_log.findMany({
      where: {
        processed_status: { in: NON_TERMINAL_STATUSES },
        updated_at: { lte: staleBefore },
      },
      orderBy: { coupang_api_call_log_id: "asc" },
      select: {
        coupang_api_call_log_id: true,
        processed_status: true,
        request_started_at: true,
        updated_at: true,
        worker_job: {
          select: {
            status: true,
            started_at: true,
            lease_token: true,
            locked_until: true,
          },
        },
      },
    });
    const recoveredIds: number[] = [];
    let activeOwnerCount = 0;
    let changedBeforeRecoveryCount = 0;

    for (const candidate of candidates) {
      if (
        workerStillOwnsCall({
          now,
          requestStartedAt: candidate.request_started_at,
          worker: candidate.worker_job,
        })
      ) {
        activeOwnerCount += 1;
        continue;
      }

      const updated = await tx.coupang_api_call_log.updateMany({
        where: {
          coupang_api_call_log_id: candidate.coupang_api_call_log_id,
          processed_status: candidate.processed_status,
          updated_at: candidate.updated_at,
        },
        data: {
          processed_status: "FAILED",
          error_code: INTERRUPTED_ERROR_CODE,
          error_message:
            "서버 또는 worker가 종료되어 API 호출 처리 완료를 확인하지 못했습니다.",
          processed_at: now,
          updated_at: now,
        },
      });

      if (updated.count === 1) {
        recoveredIds.push(candidate.coupang_api_call_log_id);
      } else {
        changedBeforeRecoveryCount += 1;
      }
    }

    if (recoveredIds.length > 0) {
      await tx.server_job_logs.create({
        data: {
          job_type: "COUPANG_READ_SYNC_RECOVERY",
          job_name: "Coupang read sync interrupted-call recovery",
          status: "SUCCESS",
          started_at: now,
          finished_at: now,
          duration_ms: 0,
          summary_text: `중단된 쿠팡 읽기 API 호출 ${recoveredIds.length}건을 실패로 확정했습니다.`,
          summary_processed_count: candidates.length,
          summary_succeeded_count: recoveredIds.length,
          summary_failed_count: 0,
          summary_skipped_count:
            activeOwnerCount + changedBeforeRecoveryCount,
          summary_warning_count: recoveredIds.length,
          created_at: now,
        },
      });
    }

    return {
      checkedCount: candidates.length,
      recoveredCount: recoveredIds.length,
      activeOwnerCount,
      changedBeforeRecoveryCount,
      recoveredIds,
      staleBefore: requiredApiDateTime(staleBefore),
    };
  });
}

export async function getCoupangReadSyncHealth(options: { now?: Date } = {}) {
  const now = options.now ?? quickHackClock.nowDate();
  const since = new Date(
    now.getTime() - HEALTH_LOOKBACK_HOURS * 60 * 60 * 1000
  );
  const [activeCallCount, interruptedCount, latestInterrupted] =
    await Promise.all([
      prisma.coupang_api_call_log.count({
        where: { processed_status: { in: NON_TERMINAL_STATUSES } },
      }),
      prisma.coupang_api_call_log.count({
        where: {
          processed_status: "FAILED",
          error_code: INTERRUPTED_ERROR_CODE,
          processed_at: { gte: since },
        },
      }),
      prisma.coupang_api_call_log.findFirst({
        where: {
          processed_status: "FAILED",
          error_code: INTERRUPTED_ERROR_CODE,
          processed_at: { gte: since },
        },
        orderBy: [
          { processed_at: "desc" },
          { coupang_api_call_log_id: "desc" },
        ],
        select: {
          coupang_api_call_log_id: true,
          api_name: true,
          endpoint_path: true,
          status_filter: true,
          request_started_at: true,
          received_at: true,
          processing_started_at: true,
          processed_at: true,
          worker_job: {
            select: {
              worker_key: true,
              worker_name: true,
            },
          },
        },
      }),
    ]);

  return {
    lookbackHours: HEALTH_LOOKBACK_HOURS,
    activeCallCount,
    interruptedCount,
    latestInterrupted: latestInterrupted
      ? {
          apiCallLogId: latestInterrupted.coupang_api_call_log_id,
          apiName: latestInterrupted.api_name,
          endpointPath: latestInterrupted.endpoint_path ?? "",
          statusFilter: latestInterrupted.status_filter ?? "",
          requestStartedAt: requiredApiDateTime(
            latestInterrupted.request_started_at
          ),
          processedAt: apiDateTime(latestInterrupted.processed_at) ?? "",
          interruptedStage: interruptionStage(latestInterrupted),
          workerKey: latestInterrupted.worker_job?.worker_key ?? "",
          workerName: latestInterrupted.worker_job?.worker_name ?? "",
        }
      : null,
  };
}
