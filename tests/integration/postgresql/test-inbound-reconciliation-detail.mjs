import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-inbound-reconciliation-detail-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function databaseDateTime(value) {
  if (value instanceof Date) return value;
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

function request(path, token) {
  return new NextRequest(`http://localhost${path}`, {
    headers: token
      ? { cookie: `quickhack_session=${token}` }
      : undefined,
  });
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
  const authService = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const reconciliationService = await import(
    "@/quickhack_server/inbound/inbound-reconciliation-service"
  );
  const reconciliationApi = await import(
    "@/quickhack_server/api/inventory/inbound-reconciliation"
  );
  const timestamp = databaseDateTime("2026-07-27 09:00:00");
  const [viewer, staff] = await Promise.all([
    prisma.users.create({
      data: {
        username: "reconciliation-viewer",
        password_hash: "test-only",
        role: "VIEWER",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
    prisma.users.create({
      data: {
        username: "reconciliation-staff",
        password_hash: "test-only",
        role: "STAFF",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
  ]);
  const [viewerToken, staffToken] = await Promise.all([
    authService.createUserSession(viewer.user_id),
    authService.createUserSession(staff.user_id),
  ]);
  const shortageBatch = await prisma.inbound_batches.create({
    data: {
      batch_date: new Date("2026-07-27T00:00:00.000Z"),
      batch_no: 1,
      expected_quantity: 2,
      note: "부족 차수",
    },
  });
  const excessBatch = await prisma.inbound_batches.create({
    data: {
      batch_date: new Date("2026-07-27T00:00:00.000Z"),
      batch_no: 2,
      expected_quantity: 1,
      note: "초과 차수",
    },
  });
  const pgNos = [
    "DETAIL-SHORTAGE",
    "DETAIL-EXCESS-1",
    "DETAIL-EXCESS-2",
    "DETAIL-UNASSIGNED",
  ];
  await prisma.devices.createMany({
    data: pgNos.map((pgNo, index) => ({
      pg_no: pgNo,
      model: index === 0 ? "Galaxy S24" : "Galaxy S24 Ultra",
      storage: index % 2 === 0 ? "256GB" : "512GB",
      color: index % 2 === 0 ? "블랙" : "그레이",
      sale_grade: index % 2 === 0 ? "A" : "B",
      created_at: timestamp,
      updated_at: timestamp,
    })),
  });
  await createInbound({
    pgNo: "DETAIL-SHORTAGE",
    inboundBatchId: shortageBatch.inbound_batch_id,
    inboundStatus: "INSPECTING",
    createdAt: "2026-07-27 09:01:00",
  });
  await createInbound({
    pgNo: "DETAIL-EXCESS-1",
    inboundBatchId: excessBatch.inbound_batch_id,
    inboundStatus: "INSPECTED",
    createdAt: "2026-07-27 09:02:00",
  });
  await createInbound({
    pgNo: "DETAIL-EXCESS-2",
    inboundBatchId: excessBatch.inbound_batch_id,
    inboundStatus: "SUPPLIER_RETURN",
    createdAt: "2026-07-27 09:03:00",
  });
  await createInbound({
    pgNo: "DETAIL-UNASSIGNED",
    inboundStatus: "RECEIVED",
    createdAt: "2026-07-27 09:04:00",
  });

  const summary =
    await reconciliationService.getInboundReconciliation(prisma, {
      batchDate: "2026-07-27",
      businessDate: "2026-07-27",
    });
  const unassigned =
    reconciliationService.buildInboundReconciliationDetail(
      summary,
      "UNASSIGNED"
    );
  const mismatched =
    reconciliationService.buildInboundReconciliationDetail(
      summary,
      "MISMATCHED"
    );
  const shortage =
    reconciliationService.buildInboundReconciliationDetail(
      summary,
      "SHORTAGE"
    );
  const excess =
    reconciliationService.buildInboundReconciliationDetail(
      summary,
      "EXCESS"
    );

  assert.equal(unassigned.scopeQuantity, 1);
  assert.deepEqual(
    unassigned.devices.map((device) => device.pgNo),
    ["DETAIL-UNASSIGNED"]
  );
  assert.deepEqual(unassigned.batches, []);
  assert.equal(mismatched.scopeQuantity, 2);
  assert.deepEqual(
    mismatched.batches.map((batch) => batch.inboundBatchId).sort(),
    [
      shortageBatch.inbound_batch_id,
      excessBatch.inbound_batch_id,
    ].sort()
  );
  assert.equal(shortage.scopeQuantity, 1);
  assert.deepEqual(
    shortage.batches.map((batch) => batch.inboundBatchId),
    [shortageBatch.inbound_batch_id]
  );
  assert.equal(excess.scopeQuantity, 1);
  assert.deepEqual(
    excess.batches.map((batch) => batch.inboundBatchId),
    [excessBatch.inbound_batch_id]
  );
  assert.equal(excess.batches[0].devices.length, 2);

  assert.equal(
    reconciliationService.normalizeInboundReconciliationDetailScope(
      " shortage "
    ),
    "SHORTAGE"
  );
  assert.throws(
    () =>
      reconciliationService.normalizeInboundReconciliationDetailScope(
        "UNKNOWN"
      ),
    /scope는/
  );

  const unauthorized = await reconciliationApi.GET(
    request(
      "/api/inventory/inbound-reconciliation?businessDate=2026-07-27&scope=SHORTAGE"
    )
  );
  assert.equal(unauthorized.status, 401);

  const forbidden = await reconciliationApi.GET(
    request(
      "/api/inventory/inbound-reconciliation?businessDate=2026-07-27&scope=SHORTAGE",
      viewerToken
    )
  );
  assert.equal(forbidden.status, 403);

  const ok = await reconciliationApi.GET(
    request(
      "/api/inventory/inbound-reconciliation?businessDate=2026-07-27&scope=SHORTAGE",
      staffToken
    )
  );
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.data.scope, "SHORTAGE");
  assert.equal(okBody.data.scopeQuantity, 1);
  assert.deepEqual(
    okBody.data.batches.map((batch) => batch.inboundBatchId),
    [shortageBatch.inbound_batch_id]
  );

  const invalidScope = await reconciliationApi.GET(
    request(
      "/api/inventory/inbound-reconciliation?businessDate=2026-07-27&scope=UNKNOWN",
      staffToken
    )
  );
  assert.equal(invalidScope.status, 400);

  const invalidDate = await reconciliationApi.GET(
    request(
      "/api/inventory/inbound-reconciliation?businessDate=2026-02-30&scope=SHORTAGE",
      staffToken
    )
  );
  assert.equal(invalidDate.status, 400);

  console.log("Inbound reconciliation detail contracts verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
