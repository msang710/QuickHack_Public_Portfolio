import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-statistics-snapshot-lifecycle-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    pruneStatisticsSnapshots,
    STATISTICS_COMPLETE_RETENTION_POLICY,
    STATISTICS_FAILED_RETENTION_POLICY,
  } = await import(
    "@/quickhack_server/statistics/statistics-snapshot-lifecycle"
  );
  const { lifecycleCutoffExclusive } = await import(
    "@/quickhack_shared/lifecycle/lifecycle-policy.mjs"
  );

  const now = new Date("2026-08-17T00:00:00.000Z");
  const completeCutoff = lifecycleCutoffExclusive(
    now,
    STATISTICS_COMPLETE_RETENTION_POLICY
  );
  const failedCutoff = lifecycleCutoffExclusive(
    now,
    STATISTICS_FAILED_RETENTION_POLICY,
    { useGrace: true }
  );

  async function createBatch(status, terminalAt, index) {
    return prisma.statistics_snapshot_batches.create({
      data: {
        data_cutoff_date: new Date("2026-01-01T00:00:00.000Z"),
        period_from: new Date("2025-10-01T00:00:00.000Z"),
        period_to: new Date("2026-01-01T00:00:00.000Z"),
        day_count: 93,
        calculation_version: `statistics-daily-r09-test-${index}`,
        status,
        started_at: new Date("2025-01-01T00:00:00.000Z"),
        completed_at:
          status === "COMPLETE" || status === "SUPERSEDED"
            ? terminalAt
            : null,
        failed_at: status === "FAILED" ? terminalAt : null,
      },
    });
  }

  const oldComplete = await createBatch(
    "BUILDING",
    null,
    1
  );
  await createBatch(
    "SUPERSEDED",
    new Date(completeCutoff.getTime() - 2),
    2
  );
  const oldFailed = await createBatch(
    "FAILED",
    new Date(failedCutoff.getTime() - 1),
    3
  );
  const exactComplete = await createBatch("COMPLETE", completeCutoff, 4);
  const exactFailed = await createBatch("FAILED", failedCutoff, 5);
  const building = await createBatch(
    "BUILDING",
    new Date("2020-01-01T00:00:00.000Z"),
    6
  );

  const payloadText = JSON.stringify({ schemaVersion: 1, data: {} });
  for (const domain of ["PURCHASE", "INVENTORY", "SALES", "RETURNS"]) {
    await prisma.statistics_snapshot_items.create({
      data: {
        snapshot_batch_id: oldComplete.snapshot_batch_id,
        domain,
        payload_schema_version: 1,
        payload_text: payloadText,
        payload_hash: createHash("sha256").update(payloadText).digest("hex"),
        payload_size_bytes: Buffer.byteLength(payloadText),
        generated_at: new Date("2025-01-01T00:00:00.000Z"),
      },
    });
  }
  await prisma.statistics_snapshot_batches.update({
    where: { snapshot_batch_id: oldComplete.snapshot_batch_id },
    data: {
      status: "COMPLETE",
      completed_at: new Date(completeCutoff.getTime() - 1),
    },
  });
  await assert.rejects(
    prisma.statistics_snapshot_items.deleteMany({
      where: { snapshot_batch_id: oldComplete.snapshot_batch_id },
    }),
    (error) =>
      error?.meta?.driverAdapterError?.cause?.code === "55000" ||
      error?.meta?.driverAdapterError?.cause?.originalCode === "55000",
    "Direct mutation of immutable completed snapshot items became possible."
  );

  const dryRun = await pruneStatisticsSnapshots({
    now,
    dryRun: true,
    maxBatchSize: 2,
  });
  assert.equal(dryRun.attemptedCount, 2);
  assert.equal(dryRun.changedCount, 0);
  assert.equal(dryRun.backlogCount, 3);

  const firstRun = await pruneStatisticsSnapshots({
    now,
    maxBatchSize: 2,
  });
  assert.equal(firstRun.changedCount, 2);
  assert.equal(firstRun.backlogCount, 1);
  assert.equal(
    await prisma.statistics_snapshot_items.count({
      where: { snapshot_batch_id: oldComplete.snapshot_batch_id },
    }),
    0,
    "Snapshot items did not cascade with an eligible batch."
  );
  const secondRun = await pruneStatisticsSnapshots({
    now,
    maxBatchSize: 2,
  });
  assert.equal(secondRun.changedCount, 1);
  assert.equal(secondRun.backlogCount, 0);
  assert.equal(
    await prisma.statistics_snapshot_batches.findUnique({
      where: { snapshot_batch_id: oldFailed.snapshot_batch_id },
    }),
    null
  );

  for (const retained of [exactComplete, exactFailed, building]) {
    assert.notEqual(
      await prisma.statistics_snapshot_batches.findUnique({
        where: { snapshot_batch_id: retained.snapshot_batch_id },
      }),
      null,
      `Retained batch ${retained.snapshot_batch_id} was deleted.`
    );
  }

  console.log("Statistics snapshot 400-day and 7-day lifecycle verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
