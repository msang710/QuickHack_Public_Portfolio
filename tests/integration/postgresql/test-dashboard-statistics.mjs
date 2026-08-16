import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-dashboard-statistics-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function databaseDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function databaseDateTime(value) {
  return new Date(value.replace(" ", "T") + ".000Z");
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
  const { getDashboardStatisticsData } = await import(
    "@/quickhack_server/statistics/statistics-service"
  );

  const previousDayFirst = await prisma.inbound_batches.create({
    data: {
      batch_date: databaseDate("2026-07-26"),
      batch_no: 1,
      expected_quantity: 99,
      note: "이전 업무일 동일 차수",
    },
  });
  const todayFirst = await prisma.inbound_batches.create({
    data: {
      batch_date: databaseDate("2026-07-27"),
      batch_no: 1,
      expected_quantity: 4,
      note: "부족 차수",
    },
  });
  const todaySecond = await prisma.inbound_batches.create({
    data: {
      batch_date: databaseDate("2026-07-27"),
      batch_no: 2,
      expected_quantity: 1,
      note: "초과 차수",
    },
  });

  await prisma.devices.createMany({
    data: "ABCDEFG".split("").map((suffix, index) => ({
      pg_no: `DASH-${suffix}`,
      model: index < 4 ? "Galaxy S24" : "Galaxy S24 Ultra",
      storage: index % 2 === 0 ? "256GB" : "512GB",
      color: index % 2 === 0 ? "블랙" : "그레이",
      sale_grade: index % 3 === 0 ? "A" : "B",
    })),
  });

  const dashAInbound = await createInbound({
    pgNo: "DASH-A",
    inboundBatchId: todayFirst.inbound_batch_id,
    inboundStatus: "INSPECTED",
    createdAt: "2026-07-27 08:00:00",
  });
  const dashBTodayInbound = await createInbound({
    pgNo: "DASH-B",
    inboundBatchId: todayFirst.inbound_batch_id,
    inboundStatus: "INSPECTING",
    createdAt: "2026-07-27 08:05:00",
  });
  await createInbound({
    pgNo: "DASH-B",
    inboundBatchId: previousDayFirst.inbound_batch_id,
    inboundStatus: "SUPPLIER_RETURN",
    createdAt: "2026-07-27 09:00:00",
  });
  const dashCInbound = await createInbound({
    pgNo: "DASH-C",
    inboundBatchId: todayFirst.inbound_batch_id,
    inboundStatus: "SUPPLIER_RETURN",
    createdAt: "2026-07-27 08:10:00",
  });
  await createInbound({
    pgNo: "DASH-D",
    inboundBatchId: todayFirst.inbound_batch_id,
    inboundStatus: "INSPECTING",
    createdAt: "2026-07-27 08:15:00",
  });
  const dashEInbound = await createInbound({
    pgNo: "DASH-E",
    inboundBatchId: todaySecond.inbound_batch_id,
    inboundStatus: "PURCHASED",
    createdAt: "2026-07-27 08:20:00",
  });
  await createInbound({
    pgNo: "DASH-F",
    inboundBatchId: todaySecond.inbound_batch_id,
    inboundStatus: "RECEIVED",
    createdAt: "2026-07-27 08:25:00",
  });
  const dashGInbound = await createInbound({
    pgNo: "DASH-G",
    inboundStatus: "INSPECTED",
    createdAt: "2026-07-27 08:30:00",
  });

  await prisma.inspections.createMany({
    data: [
      {
        pg_no: "DASH-A",
        inbound_id: dashAInbound.inbound_id,
        inspection_type: "APPEARANCE",
        appearance_checked_at: databaseDateTime("2026-07-27 08:30:00"),
      },
      {
        pg_no: "DASH-A",
        inbound_id: dashAInbound.inbound_id,
        inspection_type: "FUNCTION",
        function_checked_at: databaseDateTime("2026-07-27 08:40:00"),
      },
      {
        pg_no: "DASH-A",
        inbound_id: dashAInbound.inbound_id,
        inspection_type: "APPEARANCE",
        appearance_checked_at: databaseDateTime("2026-07-26 08:30:00"),
      },
      {
        pg_no: "DASH-B",
        inbound_id: dashBTodayInbound.inbound_id,
        inspection_type: "APPEARANCE",
        appearance_checked_at: databaseDateTime("2026-07-27 09:10:00"),
      },
      {
        pg_no: "DASH-C",
        inbound_id: dashCInbound.inbound_id,
        inspection_type: "APPEARANCE",
        appearance_checked_at: databaseDateTime("2026-07-27 09:20:00"),
        return_yn: "Y",
      },
      {
        pg_no: "DASH-E",
        inbound_id: dashEInbound.inbound_id,
        inspection_type: "FUNCTION",
        function_checked_at: databaseDateTime("2026-07-27 09:30:00"),
      },
      {
        pg_no: "DASH-G",
        inbound_id: dashGInbound.inbound_id,
        inspection_type: "APPEARANCE",
        appearance_checked_at: databaseDateTime("2026-07-27 09:40:00"),
      },
    ],
  });

  const data = await getDashboardStatisticsData(prisma, {
    businessDate: "2026-07-27",
  });

  assert.equal(data.today, "2026-07-27");
  assert.equal(data.batches.length, 2);
  assert.deepEqual(
    data.batches.map((batch) => batch.inboundBatchId),
    [todaySecond.inbound_batch_id, todayFirst.inbound_batch_id],
    "대시보드 차수는 오늘 업무일의 실제 batch ID 순서로 반환되어야 합니다."
  );
  assert.equal(
    data.batches.some(
      (batch) => batch.inboundBatchId === previousDayFirst.inbound_batch_id
    ),
    false,
    "날짜가 다른 동일 batch_no가 오늘 차수에 섞였습니다."
  );

  const first = data.batches.find(
    (batch) => batch.inboundBatchId === todayFirst.inbound_batch_id
  );
  assert.ok(first);
  assert.equal(first.expectedQuantity, 4);
  assert.equal(first.linkedQuantity, 3);
  assert.equal(first.normalInboundTargetQuantity, 2);
  assert.equal(first.supplierReturnQuantity, 1);
  assert.equal(first.arrivalDifference, -1);
  assert.equal(first.shortageQuantity, 1);
  assert.equal(first.excessQuantity, 0);
  assert.equal(first.inspectedToday, 2);
  assert.equal(first.appearanceCompletedCount, 2);
  assert.equal(first.functionCompletedCount, 1);
  assert.equal(first.purchasePendingCount, 1);
  assert.equal(first.appearancePercent, 50);
  assert.equal(first.functionPercent, 25);
  assert.equal(first.purchasePendingPercent, 25);

  const second = data.batches.find(
    (batch) => batch.inboundBatchId === todaySecond.inbound_batch_id
  );
  assert.ok(second);
  assert.equal(second.expectedQuantity, 1);
  assert.equal(second.linkedQuantity, 2);
  assert.equal(second.normalInboundTargetQuantity, 2);
  assert.equal(second.supplierReturnQuantity, 0);
  assert.equal(second.arrivalDifference, 1);
  assert.equal(second.shortageQuantity, 0);
  assert.equal(second.excessQuantity, 1);
  assert.equal(second.inspectedToday, 1);
  assert.equal(second.appearanceCompletedCount, 0);
  assert.equal(second.functionCompletedCount, 1);
  assert.equal(second.purchasePendingCount, 0);

  assert.deepEqual(data.summary, {
    batchCount: 2,
    expectedQuantity: 5,
    linkedQuantity: 5,
    inspectedToday: 3,
    normalInboundTargetQuantity: 4,
    supplierReturnQuantity: 1,
    arrivalDifference: 0,
    shortageQuantity: 1,
    excessQuantity: 1,
  });

  console.log("Dashboard statistics reconciliation verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
