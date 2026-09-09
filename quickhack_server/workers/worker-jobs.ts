import os from "node:os";
import { Prisma } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { serverJobLogSummaryData } from "@/quickhack_server/audit/structured-log-values";
import {
  addSeconds,
  parseKstSqlDateTime,
  quickHackClock,
  type DateTimeInput,
} from "@/quickhack_shared/core/time";
import {
  databaseDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  assertOwnedWorkMutation,
  claimWork,
  type WorkClaimIdentity,
} from "@/quickhack_server/core/database/work-claim";
import {
  runOperationTrace,
  setOperationTraceField,
  type OperationTraceSnapshot,
} from "@/quickhack_server/observability/operation-trace";
import { operationTraceLogFields } from "@/quickhack_server/observability/trace-log-queue";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { publicConflict } from "@/quickhack_server/core/public-error";
import {
  findRegisteredWorker,
  registeredWorkers,
} from "@/quickhack_server/workers/registry";
import {
  nextRegisteredWorkerRunAt,
  registeredWorkerIntervalSeconds,
} from "@/quickhack_server/workers/schedule";
import {
  assertWorkerRunsAllowed,
  isWorkerShutdownRequestedError,
  registerActiveWorker,
} from "@/quickhack_server/workers/shutdown-runtime";
import type {
  RegisteredWorker,
  WorkerRunResult,
} from "@/quickhack_server/workers/types";

const DEFAULT_LOCK_SECONDS = 300;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const DEFAULT_IMMEDIATE_RUN_WAIT_MS = 60_000;
const IMMEDIATE_RUN_POLL_MS = 200;
const MIN_HEARTBEAT_SECONDS = 5;
const MAX_HEARTBEAT_SECONDS = 30;
const WORKER_INSTANCE_ID = `${os.hostname()}:${process.pid}`;
type WorkerJobRow = Prisma.server_worker_jobsGetPayload<Record<string, never>>;
type AcquiredWorkerJob = {
  job: WorkerJobRow;
  leaseToken: string;
  claimGeneration: number;
  lockedUntil: Date;
  lockSeconds: number;
};

class WorkerLeaseLostError extends Error {
  readonly code = "WORKER_LEASE_LOST";

  constructor(workerKey: string, detail?: string) {
    super(
      detail
        ? `Worker lease lost (${workerKey}): ${detail}`
        : `Worker lease lost (${workerKey}).`
    );
    this.name = "WorkerLeaseLostError";
  }
}

function kstAfter(seconds: number) {
  return addSeconds(quickHackClock.nowDate(), seconds);
}

function assertWorkerClaimMutation(
  count: number,
  workerKey: string,
  detail: string
) {
  try {
    assertOwnedWorkMutation(count, workerKey, detail);
  } catch {
    throw new WorkerLeaseLostError(workerKey, detail);
  }
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function durationMs(startedAt: DateTimeInput, finishedAt: DateTimeInput) {
  const started = parseKstSqlDateTime(startedAt);
  const finished = parseKstSqlDateTime(finishedAt);

  if (!started || !finished) {
    return null;
  }

  return Math.max(0, finished.getTime() - started.getTime());
}

function normalizeWorkerResult(result: WorkerRunResult | unknown): WorkerRunResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { summary: result };
  }

  const maybeResult = result as WorkerRunResult;

  return {
    summary: maybeResult.summary ?? result,
    summaryText: maybeResult.summaryText,
    progressCurrent: maybeResult.progressCurrent,
    progressTotal: maybeResult.progressTotal,
  };
}

type WorkerResultSnapshot = {
  result_summary_text: string | null;
  result_processed_count: number | null;
  result_succeeded_count: number | null;
  result_failed_count: number | null;
  result_skipped_count: number | null;
  result_created_count: number | null;
  result_updated_count: number | null;
  result_warning_count: number | null;
};

const WORKER_RESULT_COUNT_KEYS = {
  processed: [
    "processedCount",
    "processedItemCount",
    "scanned",
    "checkedBackupCount",
    "orders",
    "returns",
    "exchanges",
  ],
  succeeded: [
    "succeededCount",
    "successCount",
    "matchedDeviceCount",
    "fullyMatchedItemCount",
  ],
  failed: [
    "failedCount",
    "failureCount",
    "errorCount",
  ],
  skipped: ["skippedCount"],
  created: ["createdCount"],
  updated: ["updated", "updatedCount"],
  warning: [
    "warningCount",
    "conflictCount",
    "issueTypeCount",
    "addressRefreshFailedCount",
  ],
} as const;

function safeCount(value: unknown) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return null;
  }

  return Math.trunc(number);
}

function collectCountByKeys(
  value: unknown,
  keys: readonly string[],
  depth = 0
): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) {
    return null;
  }

  const row = value as Record<string, unknown>;
  let total = 0;
  let found = false;

  for (const key of keys) {
    const count = safeCount(row[key]);

    if (count !== null) {
      total += count;
      found = true;
    }
  }

  for (const child of Object.values(row)) {
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      continue;
    }

    const count = collectCountByKeys(child, keys, depth + 1);

    if (count !== null) {
      total += count;
      found = true;
    }
  }

  return found ? total : null;
}

function workerResultSnapshot(
  summary: unknown,
  summaryText?: string
): WorkerResultSnapshot {
  const processed = collectCountByKeys(
    summary,
    WORKER_RESULT_COUNT_KEYS.processed
  );
  const succeeded = collectCountByKeys(
    summary,
    WORKER_RESULT_COUNT_KEYS.succeeded
  );
  const failed = collectCountByKeys(summary, WORKER_RESULT_COUNT_KEYS.failed);
  const skipped = collectCountByKeys(
    summary,
    WORKER_RESULT_COUNT_KEYS.skipped
  );
  const created = collectCountByKeys(summary, WORKER_RESULT_COUNT_KEYS.created);
  const updated = collectCountByKeys(summary, WORKER_RESULT_COUNT_KEYS.updated);
  const warning = collectCountByKeys(summary, WORKER_RESULT_COUNT_KEYS.warning);
  const summaryParts = [
    processed !== null ? `processed=${processed}` : null,
    succeeded !== null ? `succeeded=${succeeded}` : null,
    failed !== null ? `failed=${failed}` : null,
    skipped !== null ? `skipped=${skipped}` : null,
    created !== null ? `created=${created}` : null,
    updated !== null ? `updated=${updated}` : null,
    warning !== null ? `warning=${warning}` : null,
  ].filter((part): part is string => Boolean(part));

  return {
    result_summary_text:
      summaryText?.trim() ||
      (summaryParts.length > 0 ? summaryParts.join(" / ") : "Completed"),
    result_processed_count: processed,
    result_succeeded_count: succeeded,
    result_failed_count: failed,
    result_skipped_count: skipped,
    result_created_count: created,
    result_updated_count: updated,
    result_warning_count: warning,
  };
}

function emptyWorkerResultSnapshot(): WorkerResultSnapshot {
  return {
    result_summary_text: null,
    result_processed_count: null,
    result_succeeded_count: null,
    result_failed_count: null,
    result_skipped_count: null,
    result_created_count: null,
    result_updated_count: null,
    result_warning_count: null,
  };
}

async function writeWorkerLog(input: {
  worker: RegisteredWorker;
  status: "SUCCESS" | "FAILED" | "CANCELED";
  triggeredBy: AuthUser | null;
  startedAt: Date | string;
  finishedAt: Date | string;
  summary?: unknown;
  summaryText?: string;
  errorCode?: string;
  errorMessage?: string;
  rawContext?: unknown;
  performanceTrace?: OperationTraceSnapshot | null;
}) {
  const startedAt = databaseDateTime(input.startedAt);
  const finishedAt = databaseDateTime(input.finishedAt);
  await prisma.server_job_logs.create({
    data: {
      job_type: `WORKER_${input.worker.type}`,
      job_name: input.worker.name,
      status: input.status,
      triggered_by_user_id: input.triggeredBy?.userId ?? null,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs(startedAt, finishedAt),
      ...serverJobLogSummaryData({
        summary: input.summary,
        summaryText: input.summaryText,
        rawContext: input.rawContext,
      }),
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      created_at: finishedAt,
      fields: input.performanceTrace
        ? {
            createMany: {
              data: operationTraceLogFields(input.performanceTrace),
            },
          }
        : undefined,
    },
  });
}

export async function ensureRegisteredWorkerJobs() {
  const nowDate = quickHackClock.nowDate();
  const now = nowDate;

  for (const worker of registeredWorkers) {
    const intervalSeconds =
      registeredWorkerIntervalSeconds(worker);
    const unschedulableUpdate = intervalSeconds
      ? {}
      : {
          schedule_enabled: 0,
          interval_seconds: null,
          next_run_at: null,
        };
    const initialNextRunAt =
      worker.initialScheduleMode === "NEXT_SCHEDULE"
        ? nextRegisteredWorkerRunAt(worker, nowDate, intervalSeconds)
        : now;

    await prisma.server_worker_jobs.upsert({
      where: { worker_key: worker.key },
      create: {
        worker_key: worker.key,
        worker_name: worker.name,
        worker_type: worker.type,
        status: "IDLE",
        schedule_enabled:
          worker.scheduleRequired || worker.defaultScheduleEnabled ? 1 : 0,
        interval_seconds: intervalSeconds,
        next_run_at:
          worker.scheduleRequired || worker.defaultScheduleEnabled
            ? initialNextRunAt
            : null,
        max_attempts: worker.maxAttempts ?? 3,
        created_at: now,
        updated_at: now,
      },
      update: {
        worker_name: worker.name,
        worker_type: worker.type,
        ...unschedulableUpdate,
        ...(worker.scheduleRequired
          ? {
              schedule_enabled: 1,
              interval_seconds: intervalSeconds,
            }
          : {}),
        max_attempts: worker.maxAttempts ?? 3,
        updated_at: now,
      },
    });

    if (intervalSeconds) {
      await prisma.server_worker_jobs.updateMany({
        where: {
          worker_key: worker.key,
          schedule_enabled: 1,
          next_run_at: null,
          status: { not: "RUNNING" },
        },
        data: {
          next_run_at: initialNextRunAt,
          updated_at: now,
        },
      });
    }
  }
}

export async function listWorkerJobs() {
  await ensureRegisteredWorkerJobs();
  const registeredWorkerKeys = registeredWorkers.map((worker) => worker.key);

  return prisma.server_worker_jobs.findMany({
    where: {
      worker_key: { in: registeredWorkerKeys },
    },
    orderBy: [{ worker_type: "asc" }, { worker_key: "asc" }],
    include: {
      users: {
        select: {
          username: true,
          employee_profiles: {
            select: {
              display_name: true,
            },
          },
        },
      },
    },
  });
}

function heartbeatSeconds(lockSeconds: number) {
  return Math.max(
    MIN_HEARTBEAT_SECONDS,
    Math.min(MAX_HEARTBEAT_SECONDS, Math.floor(lockSeconds / 3))
  );
}

async function acquireWorkerLock(
  worker: RegisteredWorker,
  triggeredBy: AuthUser | null
): Promise<AcquiredWorkerJob | null> {
  await ensureRegisteredWorkerJobs();

  const startedAt = databaseNow();
  const lockSeconds = worker.lockSeconds ?? DEFAULT_LOCK_SECONDS;
  const claimed = await claimWork<WorkerJobRow>({
    owner: prisma,
    name: `server_worker_job.${worker.key}`,
    lockSeconds,
    claim: (tx, seed) => tx.$queryRaw<Array<WorkerJobRow>>`
      WITH candidate AS (
        SELECT worker_job_id
        FROM server_worker_jobs
        WHERE worker_key = ${worker.key}
          AND (
            status <> 'RUNNING'
            OR lease_token IS NULL
            OR locked_until IS NULL
            OR locked_until < ${startedAt}
          )
        FOR UPDATE
      )
      UPDATE server_worker_jobs AS job
      SET status = 'RUNNING',
          started_at = ${startedAt},
          finished_at = NULL,
          locked_by = ${WORKER_INSTANCE_ID},
          lease_token = ${seed.leaseToken}::uuid,
          run_token = CASE
            WHEN job.status IN ('RETRY_WAITING', 'RUNNING')
              AND job.run_token IS NOT NULL
            THEN job.run_token
            ELSE ${seed.leaseToken}::uuid
          END,
          claim_generation = job.claim_generation + 1,
          locked_until = ${seed.lockedUntil},
          progress_current = 0,
          progress_total = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          result_summary_text = NULL,
          result_processed_count = NULL,
          result_succeeded_count = NULL,
          result_failed_count = NULL,
          result_skipped_count = NULL,
          result_created_count = NULL,
          result_updated_count = NULL,
          result_warning_count = NULL,
          triggered_by_user_id = ${triggeredBy?.userId ?? null},
          attempt_count = CASE
            WHEN job.status = 'FAILED' AND job.attempt_count >= job.max_attempts THEN 1
            ELSE job.attempt_count + 1
          END,
          updated_at = ${startedAt}
      FROM candidate
      WHERE job.worker_job_id = candidate.worker_job_id
      RETURNING job.*
    `,
    generationOf: (row) => row.claim_generation,
  });

  if (!claimed) return null;

  return {
    job: claimed.row,
    leaseToken: claimed.leaseToken,
    claimGeneration: claimed.claimGeneration,
    lockedUntil: claimed.lockedUntil,
    lockSeconds,
  };
}

async function acquireNextDueWorkerLock(
  triggeredBy: AuthUser | null,
  excludedWorkerKeys: readonly string[]
): Promise<AcquiredWorkerJob | null> {
  const eligibleWorkerKeys = registeredWorkers.map((worker) => worker.key);
  if (eligibleWorkerKeys.length === 0) return null;
  const startedAt = databaseNow();
  const excluded = excludedWorkerKeys.length > 0
    ? Prisma.sql`AND worker_key NOT IN (${Prisma.join(excludedWorkerKeys)})`
    : Prisma.empty;
  const claimed = await claimWork<WorkerJobRow>({
    owner: prisma,
    name: "server_worker_job.due",
    lockSeconds: DEFAULT_LOCK_SECONDS,
    claim: (tx, seed) => tx.$queryRaw<Array<WorkerJobRow>>`
      WITH candidate AS (
        SELECT worker_job_id
        FROM server_worker_jobs
        WHERE worker_key IN (${Prisma.join(eligibleWorkerKeys)})
          ${excluded}
          AND schedule_enabled = 1
          AND interval_seconds IS NOT NULL
          AND next_run_at <= ${startedAt}
          AND status <> 'DISABLED'
          AND (
            status <> 'RUNNING'
            OR lease_token IS NULL
            OR locked_until IS NULL
            OR locked_until < ${startedAt}
          )
        ORDER BY next_run_at ASC, worker_key ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE server_worker_jobs AS job
      SET status = 'RUNNING',
          started_at = ${startedAt},
          finished_at = NULL,
          locked_by = ${WORKER_INSTANCE_ID},
          lease_token = ${seed.leaseToken}::uuid,
          run_token = CASE
            WHEN job.status IN ('RETRY_WAITING', 'RUNNING')
              AND job.run_token IS NOT NULL
            THEN job.run_token
            ELSE ${seed.leaseToken}::uuid
          END,
          claim_generation = job.claim_generation + 1,
          locked_until = ${seed.lockedUntil},
          progress_current = 0,
          progress_total = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          result_summary_text = NULL,
          result_processed_count = NULL,
          result_succeeded_count = NULL,
          result_failed_count = NULL,
          result_skipped_count = NULL,
          result_created_count = NULL,
          result_updated_count = NULL,
          result_warning_count = NULL,
          triggered_by_user_id = ${triggeredBy?.userId ?? null},
          attempt_count = CASE
            WHEN job.status = 'FAILED' AND job.attempt_count >= job.max_attempts THEN 1
            ELSE job.attempt_count + 1
          END,
          updated_at = ${startedAt}
      FROM candidate
      WHERE job.worker_job_id = candidate.worker_job_id
      RETURNING job.*
    `,
    generationOf: (row) => row.claim_generation,
  });
  if (!claimed) return null;
  const worker = findRegisteredWorker(claimed.row.worker_key);
  if (!worker) throw new Error(`Unknown claimed worker: ${claimed.row.worker_key}`);
  return {
    job: claimed.row,
    leaseToken: claimed.leaseToken,
    claimGeneration: claimed.claimGeneration,
    lockedUntil: claimed.lockedUntil,
    lockSeconds: worker.lockSeconds ?? DEFAULT_LOCK_SECONDS,
  };
}

function createWorkerLease(input: {
  workerKey: string;
  leaseToken: string;
  claimGeneration: number;
  lockedUntil: Date;
  lockSeconds: number;
}) {
  const controller = new AbortController();
  const intervalSeconds = heartbeatSeconds(input.lockSeconds);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let activeHeartbeat: Promise<void> | null = null;
  let leaseError: WorkerLeaseLostError | null = null;
  let leaseExpiresAtMs = input.lockedUntil.getTime();

  function loseLease(error: unknown) {
    if (leaseError) {
      return leaseError;
    }

    leaseError =
      error instanceof WorkerLeaseLostError
        ? error
        : new WorkerLeaseLostError(input.workerKey, safeErrorMessage(error));
    controller.abort(leaseError);
    return leaseError;
  }

  async function renew() {
    if (leaseError) {
      throw leaseError;
    }

    try {
      const now = databaseNow();
      const result = await prisma.server_worker_jobs.updateMany({
        where: {
          worker_key: input.workerKey,
          status: "RUNNING",
          lease_token: input.leaseToken,
          claim_generation: input.claimGeneration,
        },
        data: {
          locked_until: kstAfter(input.lockSeconds),
          updated_at: now,
        },
      });

      assertWorkerClaimMutation(
        result.count,
        input.workerKey,
        "heartbeat could not renew the owned lock"
      );
      leaseExpiresAtMs =
        quickHackClock.nowDate().getTime() + input.lockSeconds * 1000;
    } catch (error) {
      if (error instanceof WorkerLeaseLostError) {
        throw loseLease(error);
      }

      if (quickHackClock.nowDate().getTime() >= leaseExpiresAtMs) {
        throw loseLease(
          new WorkerLeaseLostError(
            input.workerKey,
            `heartbeat failed through lease expiry: ${safeErrorMessage(error)}`
          )
        );
      }

      throw error;
    }
  }

  function runHeartbeat() {
    if (activeHeartbeat) {
      return activeHeartbeat;
    }

    activeHeartbeat = renew().finally(() => {
      activeHeartbeat = null;
    });
    return activeHeartbeat;
  }

  heartbeatTimer = setInterval(
    () => void runHeartbeat().catch(() => undefined),
    intervalSeconds * 1000
  );
  heartbeatTimer.unref?.();

  return {
    signal: controller.signal,
    get error() {
      return leaseError;
    },
    async assertActive() {
      if (leaseError) {
        throw leaseError;
      }

      await runHeartbeat();
    },
    async updateProgress(current: number, total: number | null) {
      if (leaseError) {
        throw leaseError;
      }

      try {
        const now = databaseNow();
        const result = await prisma.server_worker_jobs.updateMany({
          where: {
            worker_key: input.workerKey,
            status: "RUNNING",
            lease_token: input.leaseToken,
            claim_generation: input.claimGeneration,
          },
          data: {
            progress_current: current,
            progress_total: total,
            locked_until: kstAfter(input.lockSeconds),
            updated_at: now,
          },
        });

        assertWorkerClaimMutation(
          result.count,
          input.workerKey,
          "progress update no longer owns the lock"
        );
        leaseExpiresAtMs =
          quickHackClock.nowDate().getTime() + input.lockSeconds * 1000;
      } catch (error) {
        if (error instanceof WorkerLeaseLostError) {
          throw loseLease(error);
        }

        throw error;
      }
    },
    async stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      await activeHeartbeat?.catch(() => undefined);
    },
    loseLease,
  };
}

type WorkerExecutionOverride = {
  run: RegisteredWorker["run"];
  mode: "MANUAL_EXCLUSIVE";
};

async function lockOwnedWorkerJob(
  tx: Prisma.TransactionClient,
  workerKey: string,
  claim: Pick<WorkClaimIdentity, "leaseToken" | "claimGeneration">
) {
  await tx.$queryRaw`
    SELECT worker_job_id
    FROM server_worker_jobs
    WHERE worker_key = ${workerKey}
    FOR UPDATE
  `;
  const row = await tx.server_worker_jobs.findUnique({
    where: { worker_key: workerKey },
  });
  if (
    !row ||
    row.status !== "RUNNING" ||
    row.lease_token !== claim.leaseToken ||
    row.claim_generation !== claim.claimGeneration
  ) {
    throw new WorkerLeaseLostError(
      workerKey,
      "finalization no longer owns the claimed generation"
    );
  }
  return row;
}

async function executeWorkerJob(
  workerKey: string,
  triggeredBy: AuthUser | null,
  executionOverride?: WorkerExecutionOverride,
  preclaimed?: AcquiredWorkerJob
) {
  if (!preclaimed) assertWorkerRunsAllowed();
  const worker = findRegisteredWorker(workerKey);

  if (!worker) {
    throw new Error(`Unknown worker: ${workerKey}`);
  }

  const acquired = preclaimed ?? await acquireWorkerLock(worker, triggeredBy);

  if (!acquired) {
    return {
      ok: false,
      skipped: true,
      message: "Worker is already running.",
      workerKey,
    };
  }

  const {
    job: lockedJob,
    leaseToken,
    claimGeneration,
    lockedUntil,
    lockSeconds,
  } = acquired;
  const runToken = lockedJob.run_token;
  const startedAt = lockedJob.started_at ?? databaseNow();
  const lease = createWorkerLease({
    workerKey: worker.key,
    leaseToken,
    claimGeneration,
    lockedUntil,
    lockSeconds,
  });
  const activeWorker = registerActiveWorker({
    workerKey: worker.key,
    workerJobId: lockedJob.worker_job_id,
    leaseSignal: lease.signal,
  });
  let performanceTrace: OperationTraceSnapshot | null = null;
  let completionCommitted = false;
  const executionMode = executionOverride?.mode ?? "REGISTERED";
  const execute = executionOverride?.run ?? worker.run;

  try {
    assertWorkerRunsAllowed();
    if (!runToken) {
      throw new Error(`Worker ${worker.key} did not acquire a logical run token.`);
    }
    activeWorker.throwIfAborted();
    await lease.assertActive();
    const rawResult = await runOperationTrace(
      {
        operationName: `worker.${worker.key}`,
        source: "WORKER",
        persist: false,
        onComplete: (snapshot) => {
          performanceTrace = snapshot;
        },
      },
      () => {
        setOperationTraceField("worker.key", worker.key);
        setOperationTraceField("worker.job_id", lockedJob.worker_job_id);
        setOperationTraceField("worker.execution_mode", executionMode);

        return execute({
          workerJobId: lockedJob.worker_job_id,
          leaseToken,
          runToken,
          claimGeneration,
          workerKey: worker.key,
          triggeredBy,
          signal: activeWorker.signal,
          assertLeaseActive: lease.assertActive,
          updateProgress: async (current, total = null) => {
            await lease.updateProgress(current, total);
          },
        });
      }
    );
    await lease.stopHeartbeat();
    await lease.assertActive();

    const result = normalizeWorkerResult(rawResult);
    const resultSnapshot = workerResultSnapshot(
      result.summary,
      result.summaryText
    );
    const finishedAtDate = quickHackClock.nowDate();
    const finishedAt = finishedAtDate;
    await runMeasuredTransaction(
      prisma,
      "worker_job.finalize_success",
      async (tx) => {
        const current = await lockOwnedWorkerJob(tx, worker.key, {
          leaseToken,
          claimGeneration,
        });
        const nextRunAt =
          current.schedule_enabled && current.interval_seconds
            ? nextRegisteredWorkerRunAt(
                worker,
                finishedAtDate,
                current.interval_seconds
              )
            : null;
        const finalized = await tx.server_worker_jobs.updateMany({
          where: {
            worker_job_id: current.worker_job_id,
            status: "RUNNING",
            lease_token: leaseToken,
            claim_generation: claimGeneration,
          },
          data: {
            status: "SUCCESS",
            finished_at: finishedAt,
            last_run_at: finishedAt,
            next_run_at: nextRunAt,
            locked_by: null,
            lease_token: null,
            locked_until: null,
            progress_current:
              result.progressCurrent ?? current.progress_current,
            progress_total: result.progressTotal ?? null,
            attempt_count: 0,
            ...resultSnapshot,
            updated_at: finishedAt,
          },
        });
        assertWorkerClaimMutation(
          finalized.count,
          worker.key,
          "success result could not finalize the owned claim"
        );
      }
    );
    completionCommitted = true;

    await writeWorkerLog({
      worker,
      status: "SUCCESS",
      triggeredBy,
      startedAt,
      finishedAt,
      summary: result.summary,
      summaryText: result.summaryText,
      rawContext: {
        workerKey: worker.key,
        workerJobId: lockedJob.worker_job_id,
        instanceId: WORKER_INSTANCE_ID,
        leaseToken,
        claimGeneration,
        executionMode,
      },
      performanceTrace,
    });

    return {
      ok: true,
      skipped: false,
      workerKey,
      result: result.summary,
    };
  } catch (error) {
    await lease.stopHeartbeat();
    if (completionCommitted) throw error;

    const finishedAtDate = quickHackClock.nowDate();
    const finishedAt = finishedAtDate;
    const finalError = lease.error ?? error;
    const errorMessage = safeErrorMessage(finalError);
    const plannedShutdown = isWorkerShutdownRequestedError(finalError);
    const errorCode = plannedShutdown
      ? finalError.code
      : finalError instanceof WorkerLeaseLostError
        ? finalError.code
        : "WORKER_JOB_FAILED";
    const manualExecution = executionMode === "MANUAL_EXCLUSIVE";
    const willRetry =
      plannedShutdown ||
      (!manualExecution && lockedJob.attempt_count < lockedJob.max_attempts);
    try {
      await runMeasuredTransaction(
        prisma,
        "worker_job.finalize_failure",
        async (tx) => {
          const current = await lockOwnedWorkerJob(tx, worker.key, {
            leaseToken,
            claimGeneration,
          });
          const nextRunAt = !current.schedule_enabled
            ? null
            : plannedShutdown
              ? finishedAt
              : !manualExecution && willRetry
                ? kstAfter(DEFAULT_RETRY_DELAY_SECONDS)
                : current.interval_seconds
                  ? nextRegisteredWorkerRunAt(
                      worker,
                      finishedAtDate,
                      current.interval_seconds
                    )
                  : null;
          const finalized = await tx.server_worker_jobs.updateMany({
            where: {
              worker_job_id: current.worker_job_id,
              status: "RUNNING",
              lease_token: leaseToken,
              claim_generation: claimGeneration,
            },
            data: {
              status: willRetry ? "RETRY_WAITING" : "FAILED",
              finished_at: finishedAt,
              last_run_at: plannedShutdown ? current.last_run_at : finishedAt,
              next_run_at: nextRunAt,
              locked_by: null,
              lease_token: null,
              locked_until: null,
              last_error_code: errorCode,
              last_error_message: errorMessage,
              attempt_count:
                plannedShutdown || manualExecution
                  ? { decrement: 1 }
                  : undefined,
              updated_at: finishedAt,
            },
          });
          assertWorkerClaimMutation(
            finalized.count,
            worker.key,
            "failure result could not finalize the owned claim"
          );
        }
      );
    } catch (finalizationError) {
      if (!(finalizationError instanceof WorkerLeaseLostError)) {
        throw finalizationError;
      }
    }

    await writeWorkerLog({
      worker,
      status: plannedShutdown ? "CANCELED" : "FAILED",
      triggeredBy,
      startedAt,
      finishedAt,
      errorCode,
      errorMessage,
      rawContext: {
        workerKey: worker.key,
        workerJobId: lockedJob.worker_job_id,
        instanceId: WORKER_INSTANCE_ID,
        leaseToken,
        claimGeneration,
        executionMode,
      },
      performanceTrace,
    });

    throw finalError;
  } finally {
    activeWorker.unregister();
  }
}

export async function runWorkerJob(
  workerKey: string,
  triggeredBy: AuthUser | null = null
) {
  return executeWorkerJob(workerKey, triggeredBy);
}

export async function runWorkerJobWithExecutor(
  workerKey: string,
  triggeredBy: AuthUser | null,
  run: RegisteredWorker["run"]
) {
  return executeWorkerJob(workerKey, triggeredBy, {
    run,
    mode: "MANUAL_EXCLUSIVE",
  });
}

export async function runWorkerJobImmediately(
  workerKey: string,
  triggeredBy: AuthUser | null = null,
  options: { waitTimeoutMs?: number } = {}
) {
  const waitTimeoutMs = Math.max(
    IMMEDIATE_RUN_POLL_MS,
    options.waitTimeoutMs ?? DEFAULT_IMMEDIATE_RUN_WAIT_MS
  );
  const deadline = Date.now() + waitTimeoutMs;

  while (true) {
    const result = await runWorkerJob(workerKey, triggeredBy);

    if (!result.skipped) {
      return result;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Worker remained busy while waiting for an immediate run: ${workerKey}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, IMMEDIATE_RUN_POLL_MS));
  }
}

export async function runDueWorkerJobs(
  triggeredBy: AuthUser | null = null,
  options: { excludeWorkerKeys?: readonly string[] } = {}
) {
  assertWorkerRunsAllowed();
  await ensureRegisteredWorkerJobs();

  const excludedWorkerKeys = Array.from(
    new Set(
      (options.excludeWorkerKeys ?? [])
        .map((workerKey) => String(workerKey).trim())
        .filter(Boolean)
    )
  );
  const results = [];

  for (let claimedCount = 0; claimedCount < 10; claimedCount += 1) {
    assertWorkerRunsAllowed();
    const acquired = await acquireNextDueWorkerLock(
      triggeredBy,
      excludedWorkerKeys
    );
    if (!acquired) break;
    try {
      results.push(
        await executeWorkerJob(
          acquired.job.worker_key,
          triggeredBy,
          undefined,
          acquired
        )
      );
    } catch (error) {
      results.push({
        ok: false,
        skipped: false,
        workerKey: acquired.job.worker_key,
        message: safeErrorMessage(error),
      });
    }
  }

  return results;
}

export async function updateWorkerSchedule(input: {
  workerKey: string;
  scheduleEnabled: boolean;
  intervalSeconds?: number | null;
  triggeredBy: AuthUser | null;
}) {
  await ensureRegisteredWorkerJobs();

  const worker = findRegisteredWorker(input.workerKey);

  if (!worker) {
    throw new Error(`Unknown worker: ${input.workerKey}`);
  }

  if (worker.scheduleRequired && !input.scheduleEnabled) {
    throw publicConflict(
      "WORKER_SCHEDULE_REQUIRED",
      "WORKER_SCHEDULE_REQUIRED"
    );
  }

  const defaultIntervalSeconds =
    registeredWorkerIntervalSeconds(worker);

  if (
    input.scheduleEnabled &&
    !input.intervalSeconds &&
    !defaultIntervalSeconds
  ) {
    throw new Error("이 worker는 수동 실행 전용이라 스케줄을 켤 수 없습니다.");
  }

  const now = databaseNow();
  const intervalSeconds =
    worker.dailyScheduleKstTime
      ? defaultIntervalSeconds
      : input.intervalSeconds && input.intervalSeconds > 0
      ? Math.trunc(input.intervalSeconds)
      : defaultIntervalSeconds;

  return runMeasuredTransaction(
    prisma,
    "worker_job.update_schedule",
    async (tx) => {
      await tx.$queryRaw`
        SELECT worker_job_id
        FROM server_worker_jobs
        WHERE worker_key = ${input.workerKey}
        FOR UPDATE
      `;
      return tx.server_worker_jobs.update({
        where: { worker_key: input.workerKey },
        data: {
          schedule_enabled: input.scheduleEnabled ? 1 : 0,
          interval_seconds: intervalSeconds,
          next_run_at: input.scheduleEnabled ? now : null,
          triggered_by_user_id: input.triggeredBy?.userId ?? null,
          updated_at: now,
        },
      });
    }
  );
}
