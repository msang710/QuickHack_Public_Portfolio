import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createStatisticsSnapshotFixture,
  statisticsSnapshotFixtureMarker,
} from "../../support/statistics-snapshot-fixtures.ts";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-statistics-snapshot-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

const baseBatch = {
  dataCutoffDate: "2026-07-29",
  periodFrom: "2026-05-01",
  periodTo: "2026-07-29",
  dayCount: 90,
  calculationVersion: "statistics-daily-v2",
};

const domains = ["PURCHASE", "INVENTORY", "SALES", "RETURNS"];

function apiDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function databaseDateTime(value) {
  return new Date(
    value.includes("T") ? value : value.replace(" ", "T") + ".000Z"
  );
}

function storedBatchContract(batch) {
  return {
    dataCutoffDate: apiDate(batch.data_cutoff_date),
    periodFrom: apiDate(batch.period_from),
    periodTo: apiDate(batch.period_to),
    dayCount: batch.day_count,
    calculationVersion: batch.calculation_version,
  };
}

async function fillBatch(store, batch, marker = 1) {
  for (const [index, domain] of domains.entries()) {
    await store.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: batch.snapshot_batch_id,
      domain,
      data: createStatisticsSnapshotFixture(
        domain,
        storedBatchContract(batch),
        marker + index
      ),
    });
  }
}

async function expectStoreCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const store = await import(
    "@/quickhack_server/statistics/statistics-snapshot-store"
  );

  const firstBatch = await store.createStatisticsSnapshotBatch(
    prisma,
    baseBatch
  );
  await fillBatch(store, firstBatch, 1);

  const firstComplete = await store.completeStatisticsSnapshotBatch(
    prisma,
    {
      snapshotBatchId: firstBatch.snapshot_batch_id,
    }
  );
  assert.equal(firstComplete.status, "COMPLETE");

  for (const domain of domains) {
    const read = await store.readStatisticsSnapshotItem(prisma, {
      snapshotBatchId: firstBatch.snapshot_batch_id,
      domain,
    });
    assert.equal(read.envelope.domain, domain);
    assert.equal(read.data.calculation.mode, "SNAPSHOT");
    assert.equal(read.data.calculation.isDefaultPeriod, true);
    assert.equal(read.data.calculation.period.dayCount, 90);
    assert.equal(
      statisticsSnapshotFixtureMarker(domain, read.data),
      1 + domains.indexOf(domain)
    );
  }

  const duplicateBatch = await store.createStatisticsSnapshotBatch(
    prisma,
    {
      ...baseBatch,
      calculationVersion: "duplicate-contract-v1",
    }
  );
  const duplicateItem = await store.putStatisticsSnapshotItem(prisma, {
    snapshotBatchId: duplicateBatch.snapshot_batch_id,
    domain: "PURCHASE",
    data: createStatisticsSnapshotFixture("PURCHASE", baseBatch, 10),
  });
  await assert.rejects(
    prisma.statistics_snapshot_items.create({
      data: {
        snapshot_batch_id: duplicateBatch.snapshot_batch_id,
        domain: "PURCHASE",
        payload_schema_version: duplicateItem.payload_schema_version,
        payload_text: duplicateItem.payload_text,
        payload_hash: duplicateItem.payload_hash,
        payload_size_bytes: duplicateItem.payload_size_bytes,
        generated_at: duplicateItem.generated_at,
      },
    })
  );
  await assert.rejects(
    prisma.statistics_snapshot_batches.update({
      where: {
        snapshot_batch_id: duplicateBatch.snapshot_batch_id,
      },
      data: {
        status: "COMPLETE",
        completed_at: databaseDateTime("2026-07-30 09:00:00"),
      },
    })
  );

  await expectStoreCode(
    store.completeStatisticsSnapshotBatch(prisma, {
      snapshotBatchId: duplicateBatch.snapshot_batch_id,
    }),
    "SNAPSHOT_BATCH_INCOMPLETE"
  );
  await expectStoreCode(
    store.readStatisticsSnapshotItem(prisma, {
      snapshotBatchId: duplicateBatch.snapshot_batch_id,
      domain: "PURCHASE",
    }),
    "SNAPSHOT_ITEM_NOT_READABLE"
  );
  const failedBatch = await store.failStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: duplicateBatch.snapshot_batch_id,
    errorCode: "TEST_INCOMPLETE",
    errorMessage: "Expected contract failure.",
  });
  assert.equal(failedBatch.status, "FAILED");
  await expectStoreCode(
    store.readStatisticsSnapshotItem(prisma, {
      snapshotBatchId: duplicateBatch.snapshot_batch_id,
      domain: "PURCHASE",
    }),
    "SNAPSHOT_ITEM_NOT_READABLE"
  );

  const latestAfterFailure =
    await store.findLatestCompleteStatisticsSnapshotBatch(prisma);
  assert.equal(
    latestAfterFailure?.snapshot_batch_id,
    firstBatch.snapshot_batch_id
  );

  const mismatchBatch = await store.createStatisticsSnapshotBatch(
    prisma,
    {
      ...baseBatch,
      calculationVersion: "metadata-contract-v1",
    }
  );
  const mismatchedSalesData = createStatisticsSnapshotFixture(
    "SALES",
    baseBatch,
    20
  );
  await assert.rejects(
    store.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: mismatchBatch.snapshot_batch_id,
      domain: "SALES",
      data: {
        ...mismatchedSalesData,
        calculation: {
          ...mismatchedSalesData.calculation,
          period: {
            fromDate: "2026-05-02",
            toDate: "2026-07-29",
            dayCount: 89,
          },
        },
      },
    }),
    (error) => error?.code === "SNAPSHOT_METADATA_MISMATCH"
  );
  await assert.rejects(
    store.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: mismatchBatch.snapshot_batch_id,
      domain: "RETURNS",
      data: {
        ...createStatisticsSnapshotFixture("RETURNS", baseBatch, 21),
        query: "customer search",
      },
    }),
    (error) => error?.code === "SNAPSHOT_FORBIDDEN_FIELD"
  );
  await assert.rejects(
    store.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: mismatchBatch.snapshot_batch_id,
      domain: "SALES",
      data: createStatisticsSnapshotFixture("PURCHASE", baseBatch, 22),
    }),
    (error) =>
      error?.code === "SNAPSHOT_INVALID_PAYLOAD" &&
      error.message.includes("data.source.loadedSaleRecordCount")
  );
  const missingFieldData = createStatisticsSnapshotFixture(
    "INVENTORY",
    baseBatch,
    23
  );
  delete missingFieldData.period;
  await assert.rejects(
    store.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: mismatchBatch.snapshot_batch_id,
      domain: "INVENTORY",
      data: missingFieldData,
    }),
    (error) =>
      error?.code === "SNAPSHOT_INVALID_PAYLOAD" &&
      error.message.includes("data.period")
  );
  const nonFiniteData = createStatisticsSnapshotFixture(
    "SALES",
    baseBatch,
    24
  );
  nonFiniteData.summary.saleCount = Number.NaN;
  await assert.rejects(
    store.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: mismatchBatch.snapshot_batch_id,
      domain: "SALES",
      data: nonFiniteData,
    }),
    (error) =>
      error?.code === "SNAPSHOT_INVALID_PAYLOAD" &&
      error.message.includes("data.summary.saleCount")
  );

  const rerunBatch = await store.createStatisticsSnapshotBatch(
    prisma,
    baseBatch
  );
  await fillBatch(store, rerunBatch, 30);
  await store.completeStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: rerunBatch.snapshot_batch_id,
  });

  const [supersededFirst, completeRerun] = await Promise.all([
    prisma.statistics_snapshot_batches.findUniqueOrThrow({
      where: {
        snapshot_batch_id: firstBatch.snapshot_batch_id,
      },
    }),
    prisma.statistics_snapshot_batches.findUniqueOrThrow({
      where: {
        snapshot_batch_id: rerunBatch.snapshot_batch_id,
      },
    }),
  ]);
  assert.equal(supersededFirst.status, "SUPERSEDED");
  assert.equal(completeRerun.status, "COMPLETE");
  const supersededRead = await store.readStatisticsSnapshotItem(prisma, {
    snapshotBatchId: firstBatch.snapshot_batch_id,
    domain: "PURCHASE",
  });
  assert.equal(supersededRead.batch.status, "SUPERSEDED");
  assert.equal(
    statisticsSnapshotFixtureMarker("PURCHASE", supersededRead.data),
    1
  );

  const uniqueDefenseBatch =
    await store.createStatisticsSnapshotBatch(prisma, baseBatch);
  await fillBatch(store, uniqueDefenseBatch, 35);
  await assert.rejects(
    prisma.statistics_snapshot_batches.update({
      where: {
        snapshot_batch_id: uniqueDefenseBatch.snapshot_batch_id,
      },
      data: {
        status: "COMPLETE",
        completed_at: databaseDateTime("2026-07-30 09:00:00"),
      },
    })
  );
  await store.failStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: uniqueDefenseBatch.snapshot_batch_id,
    errorCode: "TEST_UNIQUE_DEFENSE",
  });

  const formulaV2Batch = await store.createStatisticsSnapshotBatch(
    prisma,
    {
      ...baseBatch,
      calculationVersion: "statistics-daily-v3",
    }
  );
  await fillBatch(store, formulaV2Batch, 40);
  await store.completeStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: formulaV2Batch.snapshot_batch_id,
  });
  const [latestV1, latestV2] = await Promise.all([
    store.findLatestCompleteStatisticsSnapshotBatch(prisma),
    store.findLatestCompleteStatisticsSnapshotBatch(prisma, {
      calculationVersion: "statistics-daily-v3",
    }),
  ]);
  assert.equal(latestV1?.snapshot_batch_id, rerunBatch.snapshot_batch_id);
  assert.equal(latestV2?.snapshot_batch_id, formulaV2Batch.snapshot_batch_id);

  const tamperContract = {
    dataCutoffDate: "2026-07-28",
    periodFrom: "2026-04-30",
    periodTo: "2026-07-28",
    dayCount: 90,
    calculationVersion: "tamper-contract-v1",
  };
  const tamperBatch = await store.createStatisticsSnapshotBatch(
    prisma,
    tamperContract
  );
  await fillBatch(store, tamperBatch, 50);
  const tamperItem =
    await prisma.statistics_snapshot_items.findUniqueOrThrow({
      where: {
        snapshot_batch_id_domain: {
          snapshot_batch_id: tamperBatch.snapshot_batch_id,
          domain: "INVENTORY",
        },
      },
    });
  const tamperedText = tamperItem.payload_text.replace(
    '"inventoryRowCount":51',
    '"inventoryRowCount":99'
  );
  assert.notEqual(tamperedText, tamperItem.payload_text);
  await prisma.statistics_snapshot_items.update({
    where: {
      snapshot_item_id: tamperItem.snapshot_item_id,
    },
    data: {
      payload_text: tamperedText,
    },
  });
  await store.completeStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: tamperBatch.snapshot_batch_id,
  });
  await expectStoreCode(
    store.readStatisticsSnapshotItem(prisma, {
      snapshotBatchId: tamperBatch.snapshot_batch_id,
      domain: "INVENTORY",
    }),
    "SNAPSHOT_PAYLOAD_HASH_MISMATCH"
  );

  await assert.rejects(
    prisma.statistics_snapshot_items.update({
      where: {
        snapshot_item_id: tamperItem.snapshot_item_id,
      },
      data: {
        generated_at: databaseDateTime("2026-07-30 09:00:00"),
      },
    })
  );

  const sizeBatch = await store.createStatisticsSnapshotBatch(prisma, {
    ...tamperContract,
    calculationVersion: "size-contract-v1",
  });
  await fillBatch(store, sizeBatch, 60);
  const sizeItem =
    await prisma.statistics_snapshot_items.findUniqueOrThrow({
      where: {
        snapshot_batch_id_domain: {
          snapshot_batch_id: sizeBatch.snapshot_batch_id,
          domain: "SALES",
        },
      },
    });
  await prisma.statistics_snapshot_items.update({
    where: {
      snapshot_item_id: sizeItem.snapshot_item_id,
    },
    data: {
      payload_size_bytes: sizeItem.payload_size_bytes + 1,
    },
  });
  await store.completeStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: sizeBatch.snapshot_batch_id,
  });
  await expectStoreCode(
    store.readStatisticsSnapshotItem(prisma, {
      snapshotBatchId: sizeBatch.snapshot_batch_id,
      domain: "SALES",
    }),
    "SNAPSHOT_PAYLOAD_SIZE_MISMATCH"
  );

  const structureBatch =
    await store.createStatisticsSnapshotBatch(prisma, {
      ...tamperContract,
      calculationVersion: "structure-contract-v1",
    });
  await fillBatch(store, structureBatch, 70);
  const structureItem =
    await prisma.statistics_snapshot_items.findUniqueOrThrow({
      where: {
        snapshot_batch_id_domain: {
          snapshot_batch_id: structureBatch.snapshot_batch_id,
          domain: "SALES",
        },
      },
    });
  const structureEnvelope = JSON.parse(structureItem.payload_text);
  structureEnvelope.data = createStatisticsSnapshotFixture(
    "PURCHASE",
    storedBatchContract(structureBatch),
    99
  );
  structureEnvelope.data.calculation.mode = "SNAPSHOT";
  const structurePayloadText = JSON.stringify(structureEnvelope);
  await prisma.statistics_snapshot_items.update({
    where: {
      snapshot_item_id: structureItem.snapshot_item_id,
    },
    data: {
      payload_text: structurePayloadText,
      payload_hash: createHash("sha256")
        .update(structurePayloadText, "utf8")
        .digest("hex"),
      payload_size_bytes: Buffer.byteLength(
        structurePayloadText,
        "utf8"
      ),
      generated_at: databaseDateTime(structureEnvelope.data.generatedAt),
    },
  });
  await store.completeStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: structureBatch.snapshot_batch_id,
  });
  await expectStoreCode(
    store.readStatisticsSnapshotItem(prisma, {
      snapshotBatchId: structureBatch.snapshot_batch_id,
      domain: "SALES",
    }),
    "SNAPSHOT_INVALID_PAYLOAD"
  );

  for (const apiPath of [
    "quickhack_server/api/statistics/purchases.ts",
    "quickhack_server/api/statistics/inventory.ts",
    "quickhack_server/api/statistics/sales.ts",
    "quickhack_server/api/statistics/returns.ts",
  ]) {
    const source = readFileSync(path.join(process.cwd(), apiPath), "utf8");
    assert.equal(
      source.includes("statistics-snapshot-store"),
      false,
      `${apiPath} must remain on LIVE statistics in PR 5.`
    );
  }

  console.log(
    "Statistics snapshot storage contract, atomic promotion, versioning, and integrity checks verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
