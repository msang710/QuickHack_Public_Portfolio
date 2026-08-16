import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-observability-retention-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
let databaseDateTime;
let requiredApiDateTime;

async function createServerLog(input) {
  return prisma.server_job_logs.create({
    data: {
      job_type: input.jobType,
      job_name: input.jobType,
      status: "SUCCESS",
      started_at: databaseDateTime(input.startedAt),
      finished_at: databaseDateTime(input.startedAt),
      created_at: databaseDateTime(input.startedAt),
      fields: input.fieldName
        ? {
            create: {
              field_name: input.fieldName,
              field_value: "fixture",
              created_at: databaseDateTime(input.startedAt),
            },
          }
        : undefined,
    },
    include: { fields: true },
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  ({ databaseDateTime, requiredApiDateTime } = await import(
    "@/quickhack_server/core/database/time-boundary"
  ));
  const { runObservabilityTraceRetention } = await import(
    "@/quickhack_server/observability/trace-retention-service"
  );
  const referenceDate = new Date("2026-07-31T03:00:00.000Z");

  const oldUserTrace = await createServerLog({
    jobType: "USER_OPERATION_TRACE",
    startedAt: "2026-07-17 11:59:59",
    fieldName: "trace.old",
  });
  const boundaryUserTrace = await createServerLog({
    jobType: "USER_OPERATION_TRACE",
    startedAt: "2026-07-17 12:00:00",
    fieldName: "trace.boundary",
  });
  const workerDetailOnly = await createServerLog({
    jobType: "WORKER_TEST",
    startedAt: "2026-07-10 12:00:00",
    fieldName: "performance.duration",
  });
  const oldWorkerParent = await createServerLog({
    jobType: "WORKER_TEST",
    startedAt: "2026-05-01 11:59:59",
    fieldName: "performance.old-parent",
  });
  const boundaryWorkerParent = await createServerLog({
    jobType: "WORKER_TEST",
    startedAt: "2026-05-02 12:00:00",
    fieldName: "performance.boundary-parent",
  });
  const developerSentinel = await createServerLog({
    jobType: "DEVELOPER_DATA",
    startedAt: "2020-01-01 00:00:00",
    fieldName: "sentinel.developer",
  });
  const recoverySentinel = await createServerLog({
    jobType: "COUPANG_READ_SYNC_RECOVERY",
    startedAt: "2020-01-01 00:00:00",
    fieldName: "sentinel.recovery",
  });

  await prisma.client_http_trace_observations.createMany({
    data: [
      {
        trace_id: "old-client-trace",
        response_status: 200,
        header_received_ms: 10,
        observed_at: new Date("2099-12-31T23:59:59.999Z"),
        created_at: databaseDateTime("2026-07-17 11:59:59"),
      },
      {
        trace_id: "boundary-client-trace",
        response_status: 200,
        header_received_ms: 10,
        observed_at: new Date("2000-01-01T00:00:00.000Z"),
        created_at: databaseDateTime("2026-07-17 12:00:00"),
      },
    ],
  });
  await prisma.employee_activity_logs.create({
    data: {
      action_type: "RETENTION_SENTINEL",
      target_type: "TEST",
      target_id: "never-delete",
      result: "SUCCESS",
      created_at: databaseDateTime("2020-01-01 00:00:00"),
      changes: {
        create: {
          field_name: "sentinel",
          before_value: null,
          after_value: "preserved",
        },
      },
    },
  });

  let leaseChecks = 0;
  const progress = [];
  const context = {
    async assertLeaseActive() {
      leaseChecks += 1;
    },
    async updateProgress(current, total) {
      progress.push([current, total]);
    },
  };
  const capped = await runObservabilityTraceRetention({
    context,
    referenceDate,
    batchSize: 1,
    maxBatches: 2,
  });
  assert.equal(capped.batchCount, 2);
  assert.equal(capped.backlog, true);
  assert.deepEqual(capped.backlogCategories, [
    "WORKER_DETAIL",
    "WORKER_PARENT",
  ]);
  assert.equal(progress.at(-1)?.[0], 2);

  const completed = await runObservabilityTraceRetention({
    context,
    referenceDate,
  });
  assert.equal(completed.backlog, false);
  assert.equal(completed.deletedCount, 4);
  assert.equal(
    await prisma.server_job_logs.findUnique({
      where: { id: oldUserTrace.id },
    }),
    null
  );
  assert.ok(
    await prisma.server_job_logs.findUnique({
      where: { id: boundaryUserTrace.id },
    })
  );
  assert.ok(
    await prisma.server_job_logs.findUnique({
      where: { id: workerDetailOnly.id },
    })
  );
  assert.equal(
    await prisma.server_job_log_fields.count({
      where: { server_job_log_id: workerDetailOnly.id },
    }),
    0
  );
  assert.equal(
    await prisma.server_job_logs.findUnique({
      where: { id: oldWorkerParent.id },
    }),
    null
  );
  assert.ok(
    await prisma.server_job_logs.findUnique({
      where: { id: boundaryWorkerParent.id },
    })
  );
  assert.ok(
    await prisma.server_job_logs.findUnique({
      where: { id: developerSentinel.id },
    })
  );
  assert.ok(
    await prisma.server_job_logs.findUnique({
      where: { id: recoverySentinel.id },
    })
  );
  assert.ok(
    await prisma.client_http_trace_observations.findUnique({
      where: { trace_id: "boundary-client-trace" },
    })
  );
  assert.equal(
    await prisma.client_http_trace_observations.findUnique({
      where: { trace_id: "old-client-trace" },
    }),
    null,
    "Client-reported future time must not bypass server-authored retention."
  );
  assert.equal(await prisma.employee_activity_logs.count(), 1);
  assert.equal(await prisma.employee_activity_log_changes.count(), 1);

  const idempotent = await runObservabilityTraceRetention({
    context,
    referenceDate,
  });
  assert.equal(idempotent.deletedCount, 0);
  assert.equal(idempotent.backlog, false);

  await createServerLog({
    jobType: "USER_OPERATION_TRACE",
    startedAt: "2026-07-01 00:00:00",
  });
  await createServerLog({
    jobType: "USER_OPERATION_TRACE",
    startedAt: "2026-07-01 00:00:01",
  });
  let guardedChecks = 0;
  await assert.rejects(
    () =>
      runObservabilityTraceRetention({
        referenceDate,
        batchSize: 1,
        maxBatches: 10,
        context: {
          async assertLeaseActive() {
            guardedChecks += 1;
            if (guardedChecks > 1) {
              throw new Error("TEST_WORKER_LEASE_LOST");
            }
          },
          async updateProgress() {},
        },
      }),
    /TEST_WORKER_LEASE_LOST/
  );
  assert.equal(
    await prisma.server_job_logs.count({
      where: {
        job_type: "USER_OPERATION_TRACE",
        started_at: { lt: databaseDateTime("2026-07-17 12:00:00") },
      },
    }),
    1,
    "No second batch may start after the lease is lost."
  );
  assert.ok(leaseChecks > 0);

  const {
    ensureRegisteredWorkerJobs,
    runWorkerJobImmediately,
  } = await import("@/quickhack_server/workers/worker-jobs");
  const { OBSERVABILITY_WORKER_KEY } = await import(
    "@/quickhack_server/workers/worker-keys"
  );
  await ensureRegisteredWorkerJobs();
  const registeredJob = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: {
      worker_key: OBSERVABILITY_WORKER_KEY.traceRetention,
    },
  });
  assert.equal(registeredJob.schedule_enabled, 1);
  assert.match(requiredApiDateTime(registeredJob.next_run_at), / 04:10:00$/);
  assert.ok(
    (registeredJob.next_run_at ?? "") > registeredJob.created_at,
    "The new retention worker must wait for its first 04:10 schedule."
  );

  const manualRun = await runWorkerJobImmediately(
    OBSERVABILITY_WORKER_KEY.traceRetention
  );
  assert.equal(manualRun.ok, true);
  const completedWorker = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: {
      worker_key: OBSERVABILITY_WORKER_KEY.traceRetention,
    },
  });
  assert.match(
    completedWorker.result_summary_text ?? "",
    /만료 trace [1-9]\d*건 정리/
  );
  assert.ok((completedWorker.result_processed_count ?? 0) > 0);

  console.log(
    "Observability trace retention boundaries, exclusions, backlog, idempotency, and lease guard verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
