import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createStatisticsSnapshotFixture,
} from "../../support/statistics-snapshot-fixtures.ts";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-statistics-snapshot-worker-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const fixedNow = new Date("2026-07-30T01:00:00.000Z");
let prisma;

function createContext(input) {
  const controller = input.controller ?? new AbortController();
  const progress = [];

  return {
    progress,
    context: {
      workerJobId: input.workerJobId,
      workerKey: "statistics-daily-snapshot",
      triggeredBy: input.manual
        ? {
            userId: 1,
            username: "leader",
            role: "LEADER",
            displayName: "Leader",
          }
        : null,
      signal: controller.signal,
      async assertLeaseActive() {
        if (controller.signal.aborted) {
          throw new Error("TEST_WORKER_LEASE_LOST");
        }
      },
      async updateProgress(current, total = null) {
        progress.push({ current, total });
      },
    },
  };
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    ensureRegisteredWorkerJobs,
    runWorkerJob,
    updateWorkerSchedule,
  } = await import("@/quickhack_server/workers/worker-jobs");
  const { registeredWorkers } = await import(
    "@/quickhack_server/workers/registry"
  );
  const workerService = await import(
    "@/quickhack_server/statistics/statistics-snapshot-worker"
  );
  const store = await import(
    "@/quickhack_server/statistics/statistics-snapshot-store"
  );

  await ensureRegisteredWorkerJobs();

  const registeredWorker = registeredWorkers.find(
    (worker) => worker.key === "statistics-daily-snapshot"
  );
  assert.ok(registeredWorker, "The daily statistics worker is not registered.");
  assert.equal(registeredWorker.defaultScheduleEnabled, true);
  assert.equal(registeredWorker.dailyScheduleKstTime, "03:30");
  assert.equal(registeredWorker.maxAttempts, 3);
  assert.equal(registeredWorker.lockSeconds, 1_800);

  const workerJob = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: {
      worker_key: "statistics-daily-snapshot",
    },
  });
  assert.equal(workerJob.schedule_enabled, 1);
  assert.equal(workerJob.interval_seconds, 86_400);

  const scheduleUpdate = await updateWorkerSchedule({
    workerKey: "statistics-daily-snapshot",
    scheduleEnabled: true,
    intervalSeconds: 17,
    triggeredBy: null,
  });
  assert.equal(
    scheduleUpdate.interval_seconds,
    86_400,
    "A client-supplied interval must not override a fixed daily schedule."
  );

  const legacyContract = {
    dataCutoffDate: "2026-07-29",
    periodFrom: "2026-05-01",
    periodTo: "2026-07-29",
    dayCount: 90,
    calculationVersion: "statistics-daily-v1",
  };
  const legacyBatch = await store.createStatisticsSnapshotBatch(prisma, {
    ...legacyContract,
    workerJobId: workerJob.worker_job_id,
    startedAt: fixedNow,
  });
  for (const [index, domain] of [
    "PURCHASE",
    "INVENTORY",
    "SALES",
    "RETURNS",
  ].entries()) {
    await store.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: legacyBatch.snapshot_batch_id,
      domain,
      payloadSchemaVersion: 1,
      data: createStatisticsSnapshotFixture(
        domain,
        legacyContract,
        index
      ),
    });
  }
  await store.completeStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: legacyBatch.snapshot_batch_id,
  });

  const firstContext = createContext({
    workerJobId: workerJob.worker_job_id,
  });
  const first = await workerService.runDailyStatisticsSnapshot({
    context: firstContext.context,
    now: fixedNow,
  });

  assert.equal(first.dataCutoffDate, "2026-07-29");
  assert.equal(first.dayCount, 90);
  assert.equal(first.completedDomainCount, 4);
  assert.equal(first.processedCount, 4);
  assert.equal(first.createdCount, 1);
  assert.equal(first.skippedCount, 0);
  assert.ok(first.payloadSizeBytes > 0);
  assert.deepEqual(
    first.domains.map((domain) => domain.domain),
    ["PURCHASE", "INVENTORY", "SALES", "RETURNS"]
  );
  assert.deepEqual(firstContext.progress.at(-1), {
    current: 4,
    total: 4,
  });

  const firstBatch =
    await prisma.statistics_snapshot_batches.findUniqueOrThrow({
      where: {
        snapshot_batch_id: first.snapshotBatchId,
      },
      include: {
        items: true,
      },
    });
  assert.equal(firstBatch.status, "COMPLETE");
  assert.equal(firstBatch.calculation_version, "statistics-daily-v3");
  assert.equal(firstBatch.items.length, 4);
  assert.equal(
    firstBatch.items.every((item) => item.payload_schema_version === 2),
    true
  );
  assert.equal(
    (
      await prisma.statistics_snapshot_batches.findUniqueOrThrow({
        where: {
          snapshot_batch_id: legacyBatch.snapshot_batch_id,
        },
      })
    ).status,
    "COMPLETE"
  );

  const scheduledContext = createContext({
    workerJobId: workerJob.worker_job_id,
  });
  const scheduled = await workerService.runDailyStatisticsSnapshot({
    context: scheduledContext.context,
    now: fixedNow,
  });
  assert.equal(scheduled.snapshotBatchId, first.snapshotBatchId);
  assert.equal(scheduled.skippedCount, 1);
  assert.equal(scheduled.createdCount, 0);
  assert.equal(scheduled.skipReason, "COMPLETE_SNAPSHOT_ALREADY_EXISTS");

  const batchCountAfterSkip =
    await prisma.statistics_snapshot_batches.count();
  assert.equal(batchCountAfterSkip, 2);

  const manualContext = createContext({
    workerJobId: workerJob.worker_job_id,
    manual: true,
  });
  const manual = await workerService.runDailyStatisticsSnapshot({
    context: manualContext.context,
    now: fixedNow,
  });
  assert.notEqual(manual.snapshotBatchId, first.snapshotBatchId);
  assert.equal(manual.createdCount, 1);

  const supersededFirst =
    await prisma.statistics_snapshot_batches.findUniqueOrThrow({
      where: {
        snapshot_batch_id: first.snapshotBatchId,
      },
    });
  const manualBatch =
    await prisma.statistics_snapshot_batches.findUniqueOrThrow({
      where: {
        snapshot_batch_id: manual.snapshotBatchId,
      },
    });
  assert.equal(supersededFirst.status, "SUPERSEDED");
  assert.equal(manualBatch.status, "COMPLETE");

  const orphan = await store.createStatisticsSnapshotBatch(prisma, {
    dataCutoffDate: "2026-07-29",
    periodFrom: "2026-05-01",
    periodTo: "2026-07-29",
    dayCount: 90,
    calculationVersion: "statistics-daily-v1",
    workerJobId: workerJob.worker_job_id,
    startedAt: fixedNow,
  });
  const recoveryContext = createContext({
    workerJobId: workerJob.worker_job_id,
  });
  const recovered = await workerService.runDailyStatisticsSnapshot({
    context: recoveryContext.context,
    now: fixedNow,
  });
  assert.equal(recovered.recoveredBuildingBatchCount, 1);
  assert.equal(recovered.skippedCount, 1);
  assert.equal(
    (
      await prisma.statistics_snapshot_batches.findUniqueOrThrow({
        where: {
          snapshot_batch_id: orphan.snapshot_batch_id,
        },
      })
    ).status,
    "FAILED"
  );

  const failureContext = createContext({
    workerJobId: workerJob.worker_job_id,
    manual: true,
  });
  await assert.rejects(
    workerService.runDailyStatisticsSnapshot({
      context: failureContext.context,
      now: fixedNow,
      calculators: {
        INVENTORY: async () => {
          throw new Error("EXPECTED_INVENTORY_FAILURE");
        },
      },
    }),
    /EXPECTED_INVENTORY_FAILURE/
  );

  const failedBatch =
    await prisma.statistics_snapshot_batches.findFirstOrThrow({
      where: {
        status: "FAILED",
        error_code: "STATISTICS_SNAPSHOT_BUILD_FAILED",
      },
      orderBy: {
        snapshot_batch_id: "desc",
      },
    });
  assert.match(failedBatch.error_message ?? "", /EXPECTED_INVENTORY_FAILURE/);
  assert.equal(
    (
      await store.findCompleteStatisticsSnapshotBatchForCutoff(prisma, {
        dataCutoffDate: "2026-07-29",
      })
    )?.snapshot_batch_id,
    manual.snapshotBatchId,
    "A failed rebuild must preserve the latest complete snapshot."
  );

  const abortController = new AbortController();
  const abortContext = createContext({
    workerJobId: workerJob.worker_job_id,
    manual: true,
    controller: abortController,
  });
  await assert.rejects(
    workerService.runDailyStatisticsSnapshot({
      context: abortContext.context,
      now: fixedNow,
      calculators: {
        PURCHASE: async () => {
          abortController.abort();
          return {};
        },
      },
    }),
    /TEST_WORKER_LEASE_LOST/
  );
  assert.equal(
    await prisma.statistics_snapshot_batches.count({
      where: {
        status: "BUILDING",
        worker_job_id: workerJob.worker_job_id,
      },
    }),
    1,
    "An aborted owner must leave its batch for the next lease owner to recover."
  );

  await prisma.statistics_snapshot_batches.updateMany({
    where: {
      status: "COMPLETE",
    },
    data: {
      status: "SUPERSEDED",
      updated_at: fixedNow,
    },
  });
  const runnerResult = await runWorkerJob(
    "statistics-daily-snapshot"
  );
  assert.equal(runnerResult.ok, true);
  assert.equal(runnerResult.skipped, false);
  assert.equal(runnerResult.result.completedDomainCount, 4);

  const finalizedWorkerJob =
    await prisma.server_worker_jobs.findUniqueOrThrow({
      where: {
        worker_key: "statistics-daily-snapshot",
      },
    });
  assert.equal(finalizedWorkerJob.status, "SUCCESS");
  assert.ok(finalizedWorkerJob.next_run_at instanceof Date);
  assert.equal(
    finalizedWorkerJob.next_run_at.getUTCHours(),
    18,
    "A successful daily worker must realign its next run to 03:30 KST."
  );
  assert.equal(finalizedWorkerJob.next_run_at.getUTCMinutes(), 30);

  const workerLog = await prisma.server_job_logs.findFirstOrThrow({
    where: {
      job_type: "WORKER_STATISTICS_SNAPSHOT",
    },
    orderBy: {
      id: "desc",
    },
    include: {
      fields: true,
    },
  });
  const workerLogFields = new Map(
    workerLog.fields.map((field) => [
      field.field_name,
      field.field_value ?? "",
    ])
  );
  assert.equal(workerLog.status, "SUCCESS");
  assert.ok(Number(workerLogFields.get("query.count")) > 0);
  assert.ok(Number(workerLogFields.get("query.total_ms")) >= 0);

  for (const apiPath of [
    "quickhack_server/api/statistics/purchases.ts",
    "quickhack_server/api/statistics/inventory.ts",
    "quickhack_server/api/statistics/sales.ts",
    "quickhack_server/api/statistics/returns.ts",
  ]) {
    const source = readFileSync(path.join(process.cwd(), apiPath), "utf8");
    assert.equal(
      source.includes("statistics-snapshot-worker"),
      false,
      `${apiPath} must remain on LIVE statistics in PR 6.`
    );
  }

  console.log(
    "Daily statistics snapshot worker, duplicate policy, manual rebuild, recovery, and failure safety verified."
  );
  console.log(
    JSON.stringify({
      emptyDatabaseSnapshotDurationMs:
        runnerResult.result.totalDurationMs,
      emptyDatabaseSnapshotPayloadSizeBytes:
        runnerResult.result.payloadSizeBytes,
      emptyDatabaseSnapshotQueryCount: Number(
        workerLogFields.get("query.count")
      ),
      emptyDatabaseSnapshotQueryTimeMs: Number(
        workerLogFields.get("query.total_ms")
      ),
    })
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
