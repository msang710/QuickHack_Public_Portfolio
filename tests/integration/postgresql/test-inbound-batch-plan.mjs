import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-inbound-batch-plan-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function databaseDateTime(value) {
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

async function createInbound({
  pgNo,
  inboundBatchId = null,
  inboundStatus,
  createdAt,
}) {
  return prisma.inbounds.create({
    data: {
      pg_no: pgNo,
      inbound_batch_id: inboundBatchId,
      inbound_status: inboundStatus,
      created_at: databaseDateTime(createdAt),
      updated_at: databaseDateTime(createdAt),
    },
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { listInboundBatchPlanRows } = await import(
    "@/quickhack_server/inbound/inbound-batch-plan-query-service"
  );
  const { updateInboundBatch, deleteInboundBatch } = await import(
    "@/quickhack_server/inbound/inbound-batch-service"
  );
  const databaseUser = await prisma.users.create({
    data: {
      username: "inbound-batch-plan-test",
      password_hash: "integration-test-only",
      role: "STAFF",
      is_active: 1,
    },
  });
  const user = {
    userId: databaseUser.user_id,
    username: databaseUser.username,
    displayName: databaseUser.username,
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
  };

  const firstBatch = await prisma.inbound_batches.create({
    data: {
      batch_date: new Date("2026-07-26T00:00:00.000Z"),
      batch_no: 1,
      expected_quantity: 2,
      note: "첫 차수",
    },
  });
  const secondBatch = await prisma.inbound_batches.create({
    data: {
      batch_date: new Date("2026-07-26T00:00:00.000Z"),
      batch_no: 2,
      expected_quantity: 1,
      note: "이동 목적지",
    },
  });
  const emptyBatch = await prisma.inbound_batches.create({
    data: {
      batch_date: new Date("2026-07-26T00:00:00.000Z"),
      batch_no: 3,
      expected_quantity: 1,
      note: "입고 이력 없음",
    },
  });
  const nextDaySameNumber = await prisma.inbound_batches.create({
    data: {
      batch_date: new Date("2026-07-27T00:00:00.000Z"),
      batch_no: 1,
      expected_quantity: 1,
      note: "다음 날 같은 차수",
    },
  });

  await prisma.devices.createMany({
    data: [
      {
        pg_no: "PG-MOVED",
        model: "Galaxy S24",
        storage: "256GB",
        color: "Black",
        sale_grade: "A",
      },
      {
        pg_no: "PG-FIRST",
        model: "Galaxy S24",
        storage: "512GB",
        color: "Gray",
        sale_grade: "A",
      },
      {
        pg_no: "PG-UNASSIGNED",
        model: "Galaxy S24 Ultra",
        storage: "512GB",
        color: "Titanium",
        sale_grade: "B",
      },
    ],
  });

  await createInbound({
    pgNo: "PG-MOVED",
    inboundBatchId: firstBatch.inbound_batch_id,
    inboundStatus: "INSPECTING",
    createdAt: "2026-07-26 08:00:00",
  });
  await createInbound({
    pgNo: "PG-MOVED",
    inboundBatchId: secondBatch.inbound_batch_id,
    inboundStatus: "SUPPLIER_RETURN",
    createdAt: "2026-07-26 09:00:00",
  });
  await createInbound({
    pgNo: "PG-FIRST",
    inboundBatchId: firstBatch.inbound_batch_id,
    inboundStatus: "INSPECTED",
    createdAt: "2026-07-26 08:30:00",
  });
  await createInbound({
    pgNo: "PG-UNASSIGNED",
    inboundBatchId: nextDaySameNumber.inbound_batch_id,
    inboundStatus: "INSPECTING",
    createdAt: "2026-07-27 08:00:00",
  });
  await createInbound({
    pgNo: "PG-UNASSIGNED",
    inboundStatus: "INSPECTED",
    createdAt: "2026-07-27 09:00:00",
  });

  const rows = await listInboundBatchPlanRows(prisma);
  assert.equal(rows.length, 4);

  const first = rows.find((row) => row.id === firstBatch.inbound_batch_id);
  assert.ok(first);
  assert.equal(first.linkedQuantity, 1);
  assert.equal(first.historicalInboundQuantity, 2);
  assert.equal(first.supplierReturnQuantity, 0);
  assert.equal(first.normalInboundTargetQuantity, 1);
  assert.equal(first.arrivalDifference, -1);
  assert.equal(first.shortageQuantity, 1);
  assert.equal(first.excessQuantity, 0);

  const second = rows.find((row) => row.id === secondBatch.inbound_batch_id);
  assert.ok(second);
  assert.equal(second.linkedQuantity, 1);
  assert.equal(second.historicalInboundQuantity, 1);
  assert.equal(second.supplierReturnQuantity, 1);
  assert.equal(second.normalInboundTargetQuantity, 0);
  assert.equal(second.arrivalDifference, 0);

  const empty = rows.find((row) => row.id === emptyBatch.inbound_batch_id);
  assert.ok(empty);
  assert.equal(empty.linkedQuantity, 0);
  assert.equal(empty.historicalInboundQuantity, 0);

  const nextDay = rows.find(
    (row) => row.id === nextDaySameNumber.inbound_batch_id
  );
  assert.ok(nextDay);
  assert.equal(nextDay.batchNo, first.batchNo);
  assert.notEqual(nextDay.batchDate, first.batchDate);
  assert.equal(nextDay.linkedQuantity, 0);
  assert.equal(nextDay.historicalInboundQuantity, 1);
  assert.equal(nextDay.arrivalDifference, -1);

  for (const row of rows) {
    assert.equal(
      "devices" in row,
      false,
      "The batch plan payload must not preload PG detail rows."
    );
    assert.equal(
      "statusCounts" in row,
      false,
      "The batch plan payload must not preload the full status map."
    );
  }

  const competingUpdates = await Promise.allSettled([
    updateInboundBatch(
      prisma,
      emptyBatch.inbound_batch_id,
      {
        expectedRevision: emptyBatch.revision,
        batchDate: "2026-07-26",
        batchNo: 3,
        expectedQuantity: 2,
        note: "first writer",
      },
      user
    ),
    updateInboundBatch(
      prisma,
      emptyBatch.inbound_batch_id,
      {
        expectedRevision: emptyBatch.revision,
        batchDate: "2026-07-26",
        batchNo: 3,
        expectedQuantity: 3,
        note: "second writer",
      },
      user
    ),
  ]);
  const competingUpdateFailureCodes = competingUpdates
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.code ?? result.reason?.message ?? "UNKNOWN")
    .join(", ");
  assert.equal(
    competingUpdates.filter((result) => result.status === "fulfilled").length,
    1,
    `Exactly one stale batch editor must win the revision CAS. Rejections: ${competingUpdateFailureCodes}`
  );
  assert.equal(
    competingUpdates.filter(
      (result) =>
        result.status === "rejected" && result.reason?.code === "INBOUND_BATCH_CHANGED"
    ).length,
    1
  );
  const currentEmptyBatch = await prisma.inbound_batches.findUniqueOrThrow({
    where: { inbound_batch_id: emptyBatch.inbound_batch_id },
  });
  assert.equal(currentEmptyBatch.revision, emptyBatch.revision + 1);
  await assert.rejects(
    deleteInboundBatch(
      prisma,
      emptyBatch.inbound_batch_id,
      { expectedRevision: emptyBatch.revision },
      user
    ),
    (error) => error?.code === "INBOUND_BATCH_CHANGED"
  );
  await deleteInboundBatch(
    prisma,
    emptyBatch.inbound_batch_id,
    { expectedRevision: currentEmptyBatch.revision },
    user
  );
  assert.equal(
    await prisma.inbound_batches.count({
      where: { inbound_batch_id: emptyBatch.inbound_batch_id },
    }),
    0
  );

  console.log("Inbound batch plan reconciliation projection verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
