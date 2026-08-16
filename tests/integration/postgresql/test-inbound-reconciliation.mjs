import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-inbound-reconciliation-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function databaseDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

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
  const { loadLatestInbounds } = await import(
    "@/quickhack_server/inbound/latest-inbound-loader"
  );
  const { getInboundReconciliation } = await import(
    "@/quickhack_server/inbound/inbound-reconciliation-service"
  );

  const batch26First = await prisma.inbound_batches.create({
    data: {
      batch_date: databaseDate("2026-07-26"),
      batch_no: 1,
      expected_quantity: 4,
      note: "26일 1차",
    },
  });
  const batch27First = await prisma.inbound_batches.create({
    data: {
      batch_date: databaseDate("2026-07-27"),
      batch_no: 1,
      expected_quantity: 1,
      note: "27일 1차",
    },
  });
  const batch26Second = await prisma.inbound_batches.create({
    data: {
      batch_date: databaseDate("2026-07-26"),
      batch_no: 2,
      expected_quantity: 1,
      note: "도착 없음",
    },
  });
  const batch26Third = await prisma.inbound_batches.create({
    data: {
      batch_date: databaseDate("2026-07-26"),
      batch_no: 3,
      expected_quantity: 1,
      note: "초과 도착",
    },
  });

  await prisma.devices.createMany({
    data: "ABCDEFGH".split("").map((suffix, index) => ({
      pg_no: `PG-${suffix}`,
      model: index < 4 ? "Galaxy S24" : "Galaxy S24 Ultra",
      storage: index % 2 === 0 ? "256GB" : "512GB",
      color: index % 2 === 0 ? "블랙" : "그레이",
      sale_grade: index % 3 === 0 ? "A" : "B",
    })),
  });

  const oldA = await createInbound({
    pgNo: "PG-A",
    inboundBatchId: batch26First.inbound_batch_id,
    inboundStatus: "RECEIVED",
    createdAt: "2026-07-25 18:00:00",
  });
  const latestA = await createInbound({
    pgNo: "PG-A",
    inboundBatchId: batch26First.inbound_batch_id,
    inboundStatus: "INSPECTED",
    createdAt: "2026-07-26 08:00:00",
  });
  await createInbound({
    pgNo: "PG-B",
    inboundBatchId: batch26First.inbound_batch_id,
    inboundStatus: "INSPECTING",
    createdAt: "2026-07-26 08:05:00",
  });
  const latestB = await createInbound({
    pgNo: "PG-B",
    inboundBatchId: batch27First.inbound_batch_id,
    inboundStatus: "SUPPLIER_RETURN",
    createdAt: "2026-07-27 08:00:00",
  });
  await createInbound({
    pgNo: "PG-C",
    inboundBatchId: batch26First.inbound_batch_id,
    inboundStatus: "SUPPLIER_RETURN",
    createdAt: "2026-07-26 08:10:00",
  });
  await createInbound({
    pgNo: "PG-D",
    inboundStatus: "INSPECTING",
    createdAt: "2026-07-26 08:15:00",
  });
  await createInbound({
    pgNo: "PG-E",
    inboundBatchId: batch26Third.inbound_batch_id,
    inboundStatus: "PURCHASED",
    createdAt: "2026-07-26 08:20:00",
  });
  await createInbound({
    pgNo: "PG-F",
    inboundBatchId: batch26Third.inbound_batch_id,
    inboundStatus: "RECEIVED",
    createdAt: "2026-07-26 08:25:00",
  });
  await createInbound({
    pgNo: "PG-G",
    inboundStatus: "INSPECTING",
    createdAt: "2026-07-26 08:30:00",
  });
  await createInbound({
    pgNo: "PG-G",
    inboundBatchId: batch26First.inbound_batch_id,
    inboundStatus: "PURCHASED",
    createdAt: "2026-07-26 08:35:00",
  });
  await createInbound({
    pgNo: "PG-H",
    inboundBatchId: batch26First.inbound_batch_id,
    inboundStatus: "RECEIVED",
    createdAt: "2026-07-25 19:00:00",
  });
  await createInbound({
    pgNo: "PG-H",
    inboundStatus: "INSPECTED",
    createdAt: "2026-07-26 08:40:00",
  });

  const latest = await loadLatestInbounds(prisma);
  assert.equal(latest.length, 8, "PG별 최신 inbound 한 건만 남지 않았습니다.");
  assert.equal(
    latest.find((row) => row.pgNo === "PG-A")?.inboundId,
    latestA.inbound_id,
    "PG-A의 과거 inbound가 최신 행으로 선택되었습니다."
  );
  assert.notEqual(
    latest.find((row) => row.pgNo === "PG-A")?.inboundId,
    oldA.inbound_id,
    "PG-A의 과거 inbound가 제거되지 않았습니다."
  );
  assert.equal(
    latest.find((row) => row.pgNo === "PG-B")?.inboundId,
    latestB.inbound_id,
    "차수가 바뀐 PG의 최신 inbound를 선택하지 못했습니다."
  );

  const july26 = await getInboundReconciliation(prisma, {
    batchDate: "2026-07-26",
    businessDate: "2026-07-26",
  });
  assert.equal(july26.batches.length, 3);
  assert.equal(july26.unassignedPgQuantity, 2);
  assert.deepEqual(
    july26.unassignedDevices.map((row) => row.pgNo).sort(),
    ["PG-D", "PG-H"],
    "과거 미지정 행 또는 이미 차수에 연결된 PG가 미지정 수량에 섞였습니다."
  );
  assert.equal(july26.mismatchedBatchQuantity, 3);
  assert.equal(july26.shortageQuantity, 2);
  assert.equal(july26.excessQuantity, 1);

  const july26First = july26.batches.find(
    (batch) =>
      batch.inboundBatchId === batch26First.inbound_batch_id
  );
  assert.ok(july26First);
  assert.equal(july26First.linkedQuantity, 3);
  assert.equal(july26First.supplierReturnQuantity, 1);
  assert.equal(july26First.normalInboundTargetQuantity, 2);
  assert.equal(july26First.arrivalDifference, -1);
  assert.equal(july26First.shortageQuantity, 1);
  assert.equal(july26First.excessQuantity, 0);
  assert.deepEqual(july26First.statusCounts, {
    INSPECTED: 1,
    SUPPLIER_RETURN: 1,
    PURCHASED: 1,
  });
  assert.equal(
    july26First.devices.some((row) => row.pgNo === "PG-B"),
    false,
    "다른 날짜의 동일 차수번호로 이동한 PG가 과거 차수에 남았습니다."
  );
  assert.equal(
    july26First.devices.some((row) => row.pgNo === "PG-H"),
    false,
    "최신 inbound에서 차수가 제거된 PG가 연결 수량에 남았습니다."
  );

  const july26Second = july26.batches.find(
    (batch) =>
      batch.inboundBatchId === batch26Second.inbound_batch_id
  );
  assert.ok(july26Second);
  assert.equal(july26Second.linkedQuantity, 0);
  assert.equal(july26Second.arrivalDifference, -1);

  const july26Third = july26.batches.find(
    (batch) =>
      batch.inboundBatchId === batch26Third.inbound_batch_id
  );
  assert.ok(july26Third);
  assert.equal(july26Third.linkedQuantity, 2);
  assert.equal(july26Third.normalInboundTargetQuantity, 2);
  assert.equal(july26Third.arrivalDifference, 1);
  assert.equal(july26Third.excessQuantity, 1);

  const allBatches = await getInboundReconciliation(prisma, {
    businessDate: "2026-07-26",
  });
  const sameNumberBatches = allBatches.batches.filter(
    (batch) => batch.batchNo === 1
  );
  assert.equal(
    sameNumberBatches.length,
    2,
    "날짜가 다른 동일 batch_no가 한 차수로 합쳐졌습니다."
  );
  assert.deepEqual(
    new Set(sameNumberBatches.map((batch) => batch.inboundBatchId)).size,
    2
  );
  const july27First = allBatches.batches.find(
    (batch) =>
      batch.inboundBatchId === batch27First.inbound_batch_id
  );
  assert.ok(july27First);
  assert.equal(july27First.linkedQuantity, 1);
  assert.equal(july27First.supplierReturnQuantity, 1);
  assert.equal(july27First.normalInboundTargetQuantity, 0);
  assert.equal(july27First.arrivalDifference, 0);

  const emptyDate = await getInboundReconciliation(prisma, {
    batchDate: "2026-07-28",
    businessDate: "2026-07-28",
  });
  assert.deepEqual(emptyDate.batches, []);
  assert.deepEqual(emptyDate.unassignedDevices, []);
  assert.equal(emptyDate.unassignedPgQuantity, 0);

  await assert.rejects(
    () =>
      getInboundReconciliation(prisma, {
        batchDate: "2026-02-30",
      }),
    /실제로 존재하는 날짜/,
    "존재하지 않는 날짜가 허용되었습니다."
  );

  console.log("Inbound latest-state reconciliation verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
