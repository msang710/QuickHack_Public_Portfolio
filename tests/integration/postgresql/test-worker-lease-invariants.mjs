import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-worker-lease-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
const workerKey = "test-worker-lease-invariant";
const retryWorkerKey = "test-worker-retry-cycle-invariant";
const shutdownWorkerKey = "test-worker-shutdown-invariant";
const disabledBeforeFirstRunWorkerKey =
  "test-worker-disabled-before-first-run-invariant";
const dueWorkerKeys = [
  "test-worker-skip-locked-first",
  "test-worker-skip-locked-second",
];
const scheduleRaceWorkerKey = "test-worker-schedule-finalization-race";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let prisma;
let registeredWorkers;
let firstRunRelease;
let scheduleRaceRelease;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  ({ registeredWorkers } = await import("@/quickhack_server/workers/registry"));
  const {
    ensureRegisteredWorkerJobs,
    runDueWorkerJobs,
    runWorkerJob,
    updateWorkerSchedule,
  } = await import("@/quickhack_server/workers/worker-jobs");
  const { beginWorkerShutdown } = await import(
    "@/quickhack_server/workers/shutdown-runtime"
  );

  let invocationCount = 0;
  const executionLeaseTokens = [];
  const executionRunTokens = [];
  let firstRunStarted;
  const firstRunStartedPromise = new Promise((resolve) => {
    firstRunStarted = resolve;
  });
  const firstRunReleasePromise = new Promise((resolve) => {
    firstRunRelease = resolve;
  });

  registeredWorkers.push({
    key: workerKey,
    name: "Worker lease invariant test",
    type: "TEST",
    maxAttempts: 1,
    lockSeconds: 1,
    async run(context) {
      invocationCount += 1;
      executionLeaseTokens.push(context.leaseToken);
      executionRunTokens.push(context.runToken);
      assert(
        typeof context.leaseToken === "string" && context.leaseToken.length > 0,
        "The worker execution context did not expose its lease token."
      );

      if (invocationCount === 1) {
        firstRunStarted();
        await firstRunReleasePromise;
        await context.updateProgress(99, 100);
        return {
          summary: { processedCount: 99, invocation: "stale" },
          progressCurrent: 99,
          progressTotal: 100,
        };
      }

      await context.updateProgress(1, 1);
      return {
        summary: { processedCount: 1, invocation: "owner" },
        progressCurrent: 1,
        progressTotal: 1,
      };
    },
  });

  const firstRun = runWorkerJob(workerKey);
  await firstRunStartedPromise;
  await delay(2_500);

  const secondRun = await runWorkerJob(workerKey);
  assert(secondRun.ok === true, "The replacement worker did not acquire the expired lease.");

  firstRunRelease();

  let firstRunError = null;
  try {
    await firstRun;
  } catch (error) {
    firstRunError = error;
  }

  assert(firstRunError, "The stale worker unexpectedly completed successfully.");
  assert(
    executionLeaseTokens.length === 2 &&
      new Set(executionLeaseTokens).size === 2,
    "Replacement worker executions did not receive distinct lease tokens."
  );
  assert(
    executionRunTokens.length === 2 &&
      new Set(executionRunTokens).size === 1,
    "A stale logical run did not preserve its run token across lease takeover."
  );
  assert(
    String(firstRunError.message).includes("Worker lease lost"),
    `Unexpected stale worker error: ${firstRunError.message}`
  );

  const job = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: workerKey },
  });

  assert(job.status === "SUCCESS", `Unexpected final worker status: ${job.status}`);
  assert(job.locked_by === null, "The completed owner worker left a lock behind.");
  assert(job.lease_token === null, "The completed owner worker left a lease token behind.");
  assert(job.claim_generation === 2, "The replacement claim generation was not persisted.");
  assert(job.progress_current === 1, "The stale worker overwrote owner progress.");
  assert(job.progress_total === 1, "The stale worker overwrote owner progress total.");
  assert(
    job.result_processed_count === 1,
    "The stale worker overwrote the owner result snapshot."
  );

  const logs = await prisma.server_job_logs.findMany({
    where: { job_name: "Worker lease invariant test" },
    orderBy: { id: "asc" },
  });

  assert(logs.length === 2, `Expected two worker logs, found ${logs.length}.`);
  assert(
    logs.some((log) => log.status === "SUCCESS"),
    "The owner worker success log is missing."
  );
  assert(
    logs.some(
      (log) =>
        log.status === "FAILED" && log.error_code === "WORKER_LEASE_LOST"
    ),
    "The stale worker lease-loss log is missing."
  );

  let retryWorkerInvocationCount = 0;
  const retryRunTokens = [];
  registeredWorkers.push({
    key: retryWorkerKey,
    name: "Worker retry cycle invariant test",
    type: "TEST",
    defaultIntervalSeconds: 3_600,
    defaultScheduleEnabled: true,
    maxAttempts: 2,
    lockSeconds: 10,
    async run(context) {
      retryWorkerInvocationCount += 1;
      retryRunTokens.push(context.runToken);
      throw new Error("forced scheduled worker failure");
    },
  });

  await runWorkerJob(retryWorkerKey).catch(() => undefined);

  const failedJob = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: retryWorkerKey },
  });

  assert(
    failedJob.status === "RETRY_WAITING",
    "The retryable worker did not enter RETRY_WAITING."
  );
  assert(failedJob.attempt_count === 1, "The first retry cycle attempt count is incorrect.");
  assert(Boolean(failedJob.last_run_at), "A failed run did not update last_run_at.");
  assert(
    Boolean(failedJob.next_run_at) && failedJob.next_run_at > failedJob.finished_at,
    "A retryable scheduled worker was not deferred."
  );

  await runWorkerJob(retryWorkerKey).catch(() => undefined);
  const exhaustedJob = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: retryWorkerKey },
  });
  assert(exhaustedJob.status === "FAILED", "The exhausted worker did not remain FAILED.");
  assert(exhaustedJob.attempt_count === 2, "The retry budget was not exhausted.");
  assert(
    retryRunTokens.length === 2 && new Set(retryRunTokens).size === 1,
    "A scheduled retry changed its logical run token."
  );

  await prisma.server_worker_jobs.update({
    where: { worker_key: retryWorkerKey },
    data: { next_run_at: null },
  });
  await ensureRegisteredWorkerJobs();

  const repairedSchedule = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: retryWorkerKey },
  });

  assert(
    Boolean(repairedSchedule.next_run_at),
    "A legacy scheduled worker with no next run was not repaired."
  );

  await prisma.server_worker_jobs.update({
    where: { worker_key: retryWorkerKey },
    data: {
      status: "FAILED",
      attempt_count: 999,
    },
  });
  await runWorkerJob(retryWorkerKey).catch(() => undefined);

  const restartedCycle = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: retryWorkerKey },
  });

  assert(retryWorkerInvocationCount === 3, "The new retry cycle did not run exactly once.");
  assert(
    restartedCycle.attempt_count === 1,
    "An exhausted worker did not reset its attempt count for a new run cycle."
  );
  assert(
    retryRunTokens[2] !== retryRunTokens[1],
    "A new worker retry cycle reused the exhausted logical run token."
  );

  const dueInvocationCounts = new Map(dueWorkerKeys.map((key) => [key, 0]));
  for (const key of dueWorkerKeys) {
    registeredWorkers.push({
      key,
      name: key,
      type: "TEST",
      defaultIntervalSeconds: 3_600,
      defaultScheduleEnabled: true,
      maxAttempts: 1,
      lockSeconds: 10,
      async run() {
        dueInvocationCounts.set(key, dueInvocationCounts.get(key) + 1);
        await delay(100);
        return { summary: { processedCount: 1 } };
      },
    });
  }
  await ensureRegisteredWorkerJobs();
  await prisma.server_worker_jobs.updateMany({
    where: { worker_key: { in: dueWorkerKeys } },
    data: {
      status: "IDLE",
      schedule_enabled: 1,
      next_run_at: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const dueExclusions = registeredWorkers
    .map((worker) => worker.key)
    .filter((key) => !dueWorkerKeys.includes(key));
  await Promise.all([
    runDueWorkerJobs(null, { excludeWorkerKeys: dueExclusions }),
    runDueWorkerJobs(null, { excludeWorkerKeys: dueExclusions }),
  ]);
  for (const key of dueWorkerKeys) {
    assert(
      dueInvocationCounts.get(key) === 1,
      `SKIP LOCKED scheduling did not execute ${key} exactly once.`
    );
    const dueJob = await prisma.server_worker_jobs.findUniqueOrThrow({
      where: { worker_key: key },
    });
    assert(dueJob.status === "SUCCESS", `${key} did not finalize successfully.`);
    assert(dueJob.claim_generation === 1, `${key} was claimed more than once.`);
  }

  let scheduleRaceStarted;
  const scheduleRaceStartedPromise = new Promise((resolve) => {
    scheduleRaceStarted = resolve;
  });
  const scheduleRaceReleasePromise = new Promise((resolve) => {
    scheduleRaceRelease = resolve;
  });
  registeredWorkers.push({
    key: scheduleRaceWorkerKey,
    name: "Worker schedule finalization race test",
    type: "TEST",
    defaultIntervalSeconds: 3_600,
    defaultScheduleEnabled: true,
    maxAttempts: 1,
    lockSeconds: 10,
    async run() {
      scheduleRaceStarted();
      await scheduleRaceReleasePromise;
      return { summary: { processedCount: 1 } };
    },
  });
  const scheduleRaceRun = runWorkerJob(scheduleRaceWorkerKey);
  await scheduleRaceStartedPromise;
  const disableSchedule = updateWorkerSchedule({
    workerKey: scheduleRaceWorkerKey,
    scheduleEnabled: false,
    triggeredBy: null,
  });
  scheduleRaceRelease();
  await Promise.all([scheduleRaceRun, disableSchedule]);
  const disabledAfterFinalization =
    await prisma.server_worker_jobs.findUniqueOrThrow({
      where: { worker_key: scheduleRaceWorkerKey },
    });
  assert(
    disabledAfterFinalization.schedule_enabled === 0 &&
      disabledAfterFinalization.next_run_at === null,
    "Worker finalization overwrote a concurrent operator schedule disable."
  );

  let shutdownWorkerStarted;
  const shutdownWorkerStartedPromise = new Promise((resolve) => {
    shutdownWorkerStarted = resolve;
  });
  registeredWorkers.push({
    key: shutdownWorkerKey,
    name: "Worker shutdown invariant test",
    type: "TEST",
    defaultIntervalSeconds: 3_600,
    defaultScheduleEnabled: true,
    maxAttempts: 3,
    lockSeconds: 10,
    async run(context) {
      shutdownWorkerStarted();
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(
            context.signal.reason instanceof Error
              ? context.signal.reason
              : new Error("Worker shutdown signal was missing a reason.")
          );
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });

  const shutdownRun = runWorkerJob(shutdownWorkerKey);
  await shutdownWorkerStartedPromise;
  beginWorkerShutdown("test-shutdown");

  let shutdownError = null;
  try {
    await shutdownRun;
  } catch (error) {
    shutdownError = error;
  }
  assert(shutdownError, "The active worker ignored server shutdown.");
  assert(
    shutdownError.code === "WORKER_SHUTDOWN_REQUESTED",
    `Unexpected shutdown error code: ${shutdownError.code}`
  );

  const shutdownJob = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: shutdownWorkerKey },
  });
  assert(
    shutdownJob.status === "RETRY_WAITING",
    `Shutdown worker status is ${shutdownJob.status}.`
  );
  assert(
    shutdownJob.attempt_count === 0,
    "Planned shutdown consumed the worker retry budget."
  );
  assert(
    shutdownJob.last_error_code === "WORKER_SHUTDOWN_REQUESTED",
    "Planned shutdown error code was not persisted."
  );
  assert(
    shutdownJob.locked_by === null &&
      shutdownJob.lease_token === null &&
      shutdownJob.locked_until === null,
    "Planned shutdown left the worker lease locked."
  );

  const shutdownLog = await prisma.server_job_logs.findFirst({
    where: { job_name: "Worker shutdown invariant test" },
    orderBy: { id: "desc" },
  });
  assert(
    shutdownLog?.status === "CANCELED",
    "Planned shutdown was not recorded as CANCELED."
  );

  let newRunError = null;
  try {
    await runWorkerJob(shutdownWorkerKey);
  } catch (error) {
    newRunError = error;
  }
  assert(
    newRunError?.code === "WORKER_SHUTDOWN_REQUESTED",
    "A new worker run entered after the shutdown gate opened."
  );

  registeredWorkers.push({
    key: disabledBeforeFirstRunWorkerKey,
    name: "Worker disabled before first run invariant test",
    type: "TEST",
    defaultIntervalSeconds: 3_600,
    defaultScheduleEnabled: true,
    maxAttempts: 1,
    async run() {
      throw new Error("The disabled worker must not run in this test.");
    },
  });
  await ensureRegisteredWorkerJobs();
  await prisma.server_worker_jobs.update({
    where: { worker_key: disabledBeforeFirstRunWorkerKey },
    data: {
      schedule_enabled: 0,
      next_run_at: null,
    },
  });
  await ensureRegisteredWorkerJobs();
  const disabledBeforeFirstRun =
    await prisma.server_worker_jobs.findUniqueOrThrow({
      where: { worker_key: disabledBeforeFirstRunWorkerKey },
    });
  assert(
    disabledBeforeFirstRun.schedule_enabled === 0 &&
      disabledBeforeFirstRun.next_run_at === null,
    "Worker bootstrap overwrote an operator disable made before the first run."
  );

  console.log(
    "Worker lease ownership, retry scheduling, and planned shutdown invariants verified."
  );
} finally {
  firstRunRelease?.();
  scheduleRaceRelease?.();

  if (registeredWorkers) {
    for (const key of [
      workerKey,
      retryWorkerKey,
      shutdownWorkerKey,
      disabledBeforeFirstRunWorkerKey,
      scheduleRaceWorkerKey,
      ...dueWorkerKeys,
    ]) {
      const index = registeredWorkers.findIndex((worker) => worker.key === key);
      if (index >= 0) {
        registeredWorkers.splice(index, 1);
      }
    }
  }

  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
