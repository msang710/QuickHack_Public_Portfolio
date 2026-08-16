import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";

import {
  createStatisticsSnapshotFixture,
} from "../../support/statistics-snapshot-fixtures.ts";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import {
  QUICKHACK_TRACE_ID_HEADER,
} from "../../../quickhack_shared/observability/http-trace.ts";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-sales-statistics-api-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function request(path, token) {
  return new NextRequest(`http://localhost${path}`, {
    headers: token
      ? { cookie: `quickhack_session=${token}` }
      : undefined,
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const authService = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const salesApi = await import(
    "@/quickhack_server/api/statistics/sales"
  );
  const snapshotStore = await import(
    "@/quickhack_server/statistics/statistics-snapshot-store"
  );
  const timestamp = new Date("2026-07-20T09:00:00.000Z");
  const roles = ["LEADER", "MANAGER", "STAFF", "VIEWER"];
  const tokens = new Map();

  for (const role of roles) {
    const user = await prisma.users.create({
      data: {
        username: `sales-statistics-${role.toLowerCase()}`,
        password_hash: "test-only",
        role,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    tokens.set(role, await authService.createUserSession(user.user_id));
  }

  const unauthorized = await salesApi.GET(
    request("/api/statistics/sales")
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(
    (
      await salesApi.GET(
        request("/api/statistics/sales?q=legacy")
      )
    ).status,
    401
  );

  for (const role of ["MANAGER", "STAFF", "VIEWER"]) {
    const forbidden = await salesApi.GET(
      request("/api/statistics/sales", tokens.get(role))
    );
    assert.equal(
      forbidden.status,
      403,
      `${role} must not call the LEADER sales statistics API.`
    );
  }

  for (const invalidPath of [
    "/api/statistics/sales?fromDate=2026-07-01",
    "/api/statistics/sales?fromDate=invalid&toDate=2026-07-10",
    "/api/statistics/sales?fromDate=2026-07-10&toDate=2026-07-01",
    "/api/statistics/sales?fromDate=2026-07-01&toDate=2999-01-01",
  ]) {
    const invalidPeriod = await salesApi.GET(
      request(invalidPath, tokens.get("LEADER"))
    );
    assert.equal(invalidPeriod.status, 400);
  }

  for (const unsupportedSearchPath of [
    "/api/statistics/sales?q=",
    "/api/statistics/sales?q=Ledger",
  ]) {
    const unsupportedSearch = await salesApi.GET(
      request(unsupportedSearchPath, tokens.get("LEADER"))
    );
    assert.equal(unsupportedSearch.status, 400);
    assert.match(
      (await unsupportedSearch.json()).message,
      /통계 검색은 지원하지 않습니다/
    );
  }

  const empty = await salesApi.GET(
    request(
      "/api/statistics/sales?fromDate=2026-07-01&toDate=2026-07-10",
      tokens.get("LEADER")
    )
  );
  assert.equal(empty.status, 200);
  assert.ok(empty.headers.get(QUICKHACK_TRACE_ID_HEADER));
  const emptyBody = await empty.json();
  assert.equal(emptyBody.ok, true);
  assert.equal("query" in emptyBody.data, false);
  assert.deepEqual(emptyBody.data.calculation.period, {
    fromDate: "2026-07-01",
    toDate: "2026-07-10",
    dayCount: 10,
  });
  assert.equal(
    emptyBody.data.calculation.delivery.status,
    "LIVE_CUSTOM_PERIOD"
  );
  assert.equal(emptyBody.data.source.loadedSaleRecordCount, 0);
  assert.equal(emptyBody.data.summary.saleCount, 0);
  assert.equal(emptyBody.data.summary.salesAmount.amount, null);
  assert.equal(emptyBody.data.summary.grossProfit.amount, null);
  assert.deepEqual(emptyBody.data.productRows, []);
  assert.deepEqual(emptyBody.data.channelRows, []);
  assert.equal(emptyBody.data.priceGradeRows.length, 8);

  const defaultWithoutSnapshot = await salesApi.GET(
    request("/api/statistics/sales", tokens.get("LEADER"))
  );
  assert.equal(defaultWithoutSnapshot.status, 200);
  const defaultWithoutSnapshotBody =
    await defaultWithoutSnapshot.json();
  assert.equal(
    defaultWithoutSnapshotBody.data.calculation.delivery.status,
    "LIVE_FALLBACK"
  );
  assert.equal(
    defaultWithoutSnapshotBody.data.calculation.delivery.fallbackReason,
    "NOT_FOUND"
  );

  const firstDevice = await prisma.devices.create({
    data: {
      pg_no: "SALES-STATS-API-PG-1",
      imei: "366666666666661",
      model: "Ledger API Model",
      storage: "256GB",
      color: "Black",
      sale_grade: "A",
    },
  });
  const secondDevice = await prisma.devices.create({
    data: {
      pg_no: "SALES-STATS-API-PG-2",
      imei: "366666666666662",
      model: "Ledger API Model",
      storage: "512GB",
      color: "Blue",
      sale_grade: "B",
    },
  });

  async function createSale({
    index,
    device,
    status,
    salesPrice,
    purchasePrice,
    storage,
    color,
    grade,
  }) {
    const externalOrderId = `SALES-STATS-ORDER-${index}`;
    const externalShipmentId = `SALES-STATS-SHIP-${index}`;
    await prisma.coupang_order_raw.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_order_status: "DELIVERING",
        ordered_at: new Date("2026-05-10T09:00:00.000Z"),
        paid_at: new Date("2026-05-10T09:01:00.000Z"),
      },
    });
    const allocation = await prisma.match_worker_allocation.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_vendor_item_id: `SALES-STATS-ITEM-${index}`,
        vendor_item_name: "Ledger API Model",
        pg_no: device.pg_no,
        allocation_status: "CANCELED",
      },
    });
    await prisma.sales_records.create({
      data: {
        allocation_id: allocation.allocation_id,
        pg_no: device.pg_no,
        channel: index === 1 ? "COUPANG" : "OFFLINE",
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_vendor_item_id: `SALES-STATS-ITEM-${index}`,
        sold_at:
          index === 1
            ? new Date("2026-05-20T09:00:00.000Z")
            : new Date("2026-06-20T09:00:00.000Z"),
        sale_status: status,
        sales_price: salesPrice,
        purchase_price: purchasePrice,
        purchase_agreed_at: new Date("2026-05-01T09:00:00.000Z"),
        model: "Ledger API Model",
        storage,
        color,
        sale_grade: grade,
        warranty_group: "12개월",
      },
    });
  }

  await createSale({
    index: 1,
    device: firstDevice,
    status: "SOLD",
    salesPrice: 500_000,
    purchasePrice: 300_000,
    storage: "256GB",
    color: "Black",
    grade: "A",
  });
  await createSale({
    index: 2,
    device: secondDevice,
    status: "RETURNED",
    salesPrice: 600_000,
    purchasePrice: 350_000,
    storage: "512GB",
    color: "Blue",
    grade: "B",
  });

  const populated = await salesApi.GET(
    request("/api/statistics/sales", tokens.get("LEADER"))
  );
  assert.equal(populated.status, 200);
  assert.ok(populated.headers.get(QUICKHACK_TRACE_ID_HEADER));
  const populatedBody = await populated.json();
  assert.equal(populatedBody.data.source.loadedSaleRecordCount, 2);
  assert.equal(
    "matchedSaleRecordCount" in populatedBody.data.source,
    false
  );
  assert.equal(populatedBody.data.source.eligibleSaleRecordCount, 2);
  assert.equal(populatedBody.data.source.soldSaleRecordCount, 1);
  assert.equal(populatedBody.data.source.returnedSaleRecordCount, 1);
  assert.equal(populatedBody.data.summary.salesAmount.amount, 1_100_000);
  assert.equal(populatedBody.data.summary.purchaseCost.amount, 650_000);
  assert.equal(populatedBody.data.summary.grossProfit.amount, 450_000);
  assert.equal(populatedBody.data.productRows.length, 2);
  assert.equal(populatedBody.data.channelRows.length, 2);

  const serialized = JSON.stringify(populatedBody);
  for (const forbiddenValue of [
    "SALES-STATS-API-PG",
    "36666666666666",
    "SALES-STATS-ORDER",
    "SALES-STATS-SHIP",
    "SALES-STATS-ITEM",
  ]) {
    assert.equal(
      serialized.includes(forbiddenValue),
      false,
      `Aggregate response leaked forbidden identifier: ${forbiddenValue}`
    );
  }
  for (const forbiddenKey of [
    "pgNo",
    "imei",
    "externalOrderId",
    "externalShipmentId",
    "receiverName",
    "receiverAddress",
    "rawPayload",
  ]) {
    assert.equal(
      serialized.includes(forbiddenKey),
      false,
      `Aggregate response leaked forbidden key: ${forbiddenKey}`
    );
  }

  const snapshotCalculation = {
    ...populatedBody.data.calculation,
  };
  delete snapshotCalculation.delivery;
  const snapshotData = {
    ...populatedBody.data,
    calculation: snapshotCalculation,
  };
  const snapshotContract = {
    dataCutoffDate: snapshotCalculation.dataCutoffDate,
    periodFrom: snapshotCalculation.period.fromDate,
    periodTo: snapshotCalculation.period.toDate,
    dayCount: snapshotCalculation.period.dayCount,
    calculationVersion: "statistics-daily-v3",
  };
  const snapshotBatch =
    await snapshotStore.createStatisticsSnapshotBatch(
      prisma,
      snapshotContract
    );
  for (const domain of ["PURCHASE", "INVENTORY", "SALES", "RETURNS"]) {
    await snapshotStore.putStatisticsSnapshotItem(prisma, {
      snapshotBatchId: snapshotBatch.snapshot_batch_id,
      domain,
      data:
        domain === "SALES"
          ? snapshotData
          : createStatisticsSnapshotFixture(
              domain,
              snapshotContract
            ),
    });
  }
  await snapshotStore.completeStatisticsSnapshotBatch(prisma, {
    snapshotBatchId: snapshotBatch.snapshot_batch_id,
  });

  const stored = await salesApi.GET(
    request("/api/statistics/sales", tokens.get("LEADER"))
  );
  assert.equal(stored.status, 200);
  const storedBody = await stored.json();
  assert.equal(storedBody.data.calculation.mode, "SNAPSHOT");
  assert.equal(
    storedBody.data.calculation.delivery.status,
    "SNAPSHOT_CURRENT"
  );
  assert.equal(storedBody.data.source.eligibleSaleRecordCount, 2);

  await prisma.$executeRawUnsafe("DROP TABLE sales_records");
  const failed = await salesApi.GET(
    request(
      "/api/statistics/sales?fromDate=2026-07-01&toDate=2026-07-10",
      tokens.get("LEADER")
    )
  );
  assert.equal(failed.status, 500);
  const failedBody = await failed.json();
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.code, "INTERNAL_ERROR");
  assert.match(failedBody.traceId, /^[0-9a-f-]{36}$/);

  console.log(
    "Sales statistics API auth, unsupported-search, empty, ledger, PII, and failure contracts verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
