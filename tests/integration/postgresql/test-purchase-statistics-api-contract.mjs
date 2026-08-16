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
import {
  addSeconds,
  quickHackClock,
} from "../../../quickhack_shared/core/time.ts";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-purchase-statistics-api-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

const TEST_DAY_SECONDS = 24 * 60 * 60;
function dateKeyDaysAgo(daysAgo) {
  return quickHackClock.formatKstDate(
    addSeconds(quickHackClock.nowDate(), -daysAgo * TEST_DAY_SECONDS)
  );
}
function dateDaysAgo(daysAgo) {
  return new Date(`${dateKeyDaysAgo(daysAgo)}T00:00:00.000Z`);
}
function dateTimeDaysAgo(daysAgo, time) {
  return new Date(`${dateKeyDaysAgo(daysAgo)}T${time}+09:00`);
}

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
  const purchasesApi = await import(
    "@/quickhack_server/api/statistics/purchases"
  );
  const snapshotStore = await import(
    "@/quickhack_server/statistics/statistics-snapshot-store"
  );
  const timestamp = new Date("2026-07-28T09:00:00+09:00");
  const roles = ["LEADER", "MANAGER", "STAFF", "VIEWER"];
  const tokens = new Map();

  for (const role of roles) {
    const user = await prisma.users.create({
      data: {
        username: `purchase-statistics-${role.toLowerCase()}`,
        password_hash: "test-only",
        role,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    tokens.set(role, await authService.createUserSession(user.user_id));
  }

  const unauthorized = await purchasesApi.GET(
    request("/api/statistics/purchases")
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(
    (
      await purchasesApi.GET(
        request("/api/statistics/purchases?q=legacy")
      )
    ).status,
    401
  );

  for (const role of ["MANAGER", "STAFF", "VIEWER"]) {
    const forbidden = await purchasesApi.GET(
      request("/api/statistics/purchases", tokens.get(role))
    );
    assert.equal(
      forbidden.status,
      403,
      `${role} must not call the LEADER purchase statistics API.`
    );
  }

  for (const invalidPath of [
    "/api/statistics/purchases?fromDate=2026-07-01",
    "/api/statistics/purchases?fromDate=invalid&toDate=2026-07-10",
    "/api/statistics/purchases?fromDate=2026-07-10&toDate=2026-07-01",
    "/api/statistics/purchases?fromDate=2026-07-01&toDate=2999-01-01",
  ]) {
    const invalidPeriod = await purchasesApi.GET(
      request(invalidPath, tokens.get("LEADER"))
    );
    assert.equal(invalidPeriod.status, 400);
  }

  for (const unsupportedSearchPath of [
    "/api/statistics/purchases?q=",
    "/api/statistics/purchases?q=API",
  ]) {
    const unsupportedSearch = await purchasesApi.GET(
      request(unsupportedSearchPath, tokens.get("LEADER"))
    );
    assert.equal(unsupportedSearch.status, 400);
    assert.match(
      (await unsupportedSearch.json()).message,
      /통계 검색은 지원하지 않습니다/
    );
  }

  const empty = await purchasesApi.GET(
    request(
      "/api/statistics/purchases?fromDate=2026-07-01&toDate=2026-07-10",
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
  assert.equal(emptyBody.data.source.terminalInboundCount, 0);
  assert.equal(emptyBody.data.summary.purchaseCount, 0);
  assert.equal(emptyBody.data.summary.purchaseAmount.amount, null);
  assert.equal(emptyBody.data.summary.supplierReturnRate.value, null);
  assert.deepEqual(emptyBody.data.productRows, []);
  assert.deepEqual(emptyBody.data.supplierRows, []);
  assert.equal(emptyBody.data.pricePolicyRows.length, 4);

  const defaultWithoutSnapshot = await purchasesApi.GET(
    request("/api/statistics/purchases", tokens.get("LEADER"))
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

  const batch = await prisma.inbound_batches.create({
    data: {
      batch_date: dateDaysAgo(30),
      batch_no: 7,
      expected_quantity: 2,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const purchasedDevice = await prisma.devices.create({
    data: {
      pg_no: "PURCHASE-STATS-API-PG-1",
      imei: "355555555555551",
      model: "API Model",
      storage: "256GB",
      color: "Black",
      sale_grade: "A",
    },
  });
  const returnedDevice = await prisma.devices.create({
    data: {
      pg_no: "PURCHASE-STATS-API-PG-2",
      imei: "355555555555552",
      model: "API Model",
      storage: "256GB",
      color: "Blue",
      sale_grade: "B",
    },
  });
  const purchasedInbound = await prisma.inbounds.create({
    data: {
      pg_no: purchasedDevice.pg_no,
      inbound_batch_id: batch.inbound_batch_id,
      supplier_name: "공급처 API",
      purchase_price: 350_000,
      purchase_price_reference_amount: 340_000,
      purchase_price_entry_mode: "OVERRIDE",
      received_at: dateTimeDaysAgo(30, "09:00:00"),
      price_agreed_at: dateTimeDaysAgo(28, "09:00:00"),
      inbound_status: "PURCHASED",
      created_at: dateTimeDaysAgo(30, "09:00:00"),
      updated_at: dateTimeDaysAgo(28, "09:00:00"),
    },
  });
  await prisma.inspections.create({
    data: {
      pg_no: purchasedDevice.pg_no,
      inbound_id: purchasedInbound.inbound_id,
      inspection_type: "APPEARANCE",
      source_type: "INBOUND",
      checked_at: dateTimeDaysAgo(29, "09:00:00"),
      appearance_checked_at: dateTimeDaysAgo(29, "09:00:00"),
      appearance_grade: "A",
      appearance_defect: "하자 없음",
      return_yn: "N",
      created_at: dateTimeDaysAgo(29, "09:00:00"),
    },
  });
  await prisma.inbounds.create({
    data: {
      pg_no: returnedDevice.pg_no,
      inbound_batch_id: batch.inbound_batch_id,
      supplier_name: "공급처 API",
      received_at: dateTimeDaysAgo(30, "09:00:00"),
      supplier_returned_at: dateTimeDaysAgo(29, "18:00:00"),
      inbound_status: "SUPPLIER_RETURN",
      created_at: dateTimeDaysAgo(30, "09:00:00"),
      updated_at: dateTimeDaysAgo(29, "18:00:00"),
    },
  });
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: "PURCHASE-STATS-ORDER-1",
      external_shipment_id: "PURCHASE-STATS-SHIP-1",
      external_order_status: "DELIVERING",
      ordered_at: dateTimeDaysAgo(20, "09:00:00"),
      paid_at: dateTimeDaysAgo(20, "09:01:00"),
    },
  });
  const allocation = await prisma.match_worker_allocation.create({
    data: {
      external_order_id: "PURCHASE-STATS-ORDER-1",
      external_shipment_id: "PURCHASE-STATS-SHIP-1",
      external_vendor_item_id: "PURCHASE-STATS-ITEM-1",
      vendor_item_name: "API Model 256GB",
      pg_no: purchasedDevice.pg_no,
      allocation_status: "CANCELED",
    },
  });
  await prisma.sales_records.create({
    data: {
      allocation_id: allocation.allocation_id,
      pg_no: purchasedDevice.pg_no,
      channel: "COUPANG",
      external_order_id: "PURCHASE-STATS-ORDER-1",
      external_shipment_id: "PURCHASE-STATS-SHIP-1",
      external_vendor_item_id: "PURCHASE-STATS-ITEM-1",
      sold_at: dateTimeDaysAgo(10, "09:00:00"),
      sale_status: "RETURNED",
      sales_price: 500_000,
      purchase_price: 350_000,
      purchase_inbound_id: purchasedInbound.inbound_id,
      supplier_name: "공급처 API",
      purchase_agreed_at: dateTimeDaysAgo(28, "09:00:00"),
      model: "API Model",
      storage: "256GB",
      color: "Black",
      sale_grade: "A",
    },
  });

  const populated = await purchasesApi.GET(
    request("/api/statistics/purchases", tokens.get("LEADER"))
  );
  assert.equal(populated.status, 200);
  assert.ok(populated.headers.get(QUICKHACK_TRACE_ID_HEADER));
  const populatedBody = await populated.json();
  assert.equal(populatedBody.data.source.terminalInboundCount, 2);
  assert.equal(populatedBody.data.source.purchaseCount, 1);
  assert.equal(populatedBody.data.source.supplierReturnCount, 1);
  assert.equal(populatedBody.data.source.purchaseInboundLinkedSaleCount, 1);
  assert.equal(populatedBody.data.summary.purchaseAmount.amount, 350_000);
  assert.equal(populatedBody.data.summary.supplierReturnRate.value, 50);
  assert.equal(populatedBody.data.productRows.length, 2);
  assert.equal(populatedBody.data.supplierRows.length, 1);
  assert.equal(
    populatedBody.data.supplierRows[0].customerReturnConfirmationRate.value,
    100
  );
  assert.equal(
    populatedBody.data.pricePolicyRows.find(
      (row) => row.entryMode === "OVERRIDE"
    ).averageAdjustmentAmount,
    10_000
  );

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
    calculationVersion: "statistics-daily-v2",
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
        domain === "PURCHASE"
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
  const stored = await purchasesApi.GET(
    request("/api/statistics/purchases", tokens.get("LEADER"))
  );
  assert.equal(stored.status, 200);
  const storedBody = await stored.json();
  assert.equal(
    storedBody.data.calculation.delivery.status,
    "SNAPSHOT_CURRENT"
  );
  assert.equal(storedBody.data.summary.purchaseAmount.amount, 350_000);

  const serialized = JSON.stringify(populatedBody);
  for (const forbiddenKey of [
    "pgNo",
    "imei",
    "externalOrderId",
    "externalShipmentId",
    "receiver_name",
    "receiver_phone",
    "receiver_address",
    "delivery_memo",
    "raw_payload",
    "worker_status",
    "next_action",
  ]) {
    assert.equal(
      serialized.includes(forbiddenKey),
      false,
      `Aggregate response leaked forbidden key: ${forbiddenKey}`
    );
  }

  const indexRows = await prisma.$queryRawUnsafe(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'idx_inbounds_status',
          'idx_inspections_inbound_id',
          'idx_sales_records_status',
          'idx_sales_records_purchase_inbound_id'
        )`
  );
  const indexNames = new Set(indexRows.map((row) => row.indexname));
  assert.deepEqual(indexNames, new Set([
    "idx_inbounds_status",
    "idx_inspections_inbound_id",
    "idx_sales_records_status",
    "idx_sales_records_purchase_inbound_id",
  ]));

  await prisma.$executeRawUnsafe("DROP TABLE sales_records");
  const failed = await purchasesApi.GET(
    request(
      "/api/statistics/purchases?fromDate=2026-07-01&toDate=2026-07-10",
      tokens.get("LEADER")
    )
  );
  assert.equal(failed.status, 500);
  const failedBody = await failed.json();
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.code, "INTERNAL_ERROR");
  assert.match(failedBody.traceId, /^[0-9a-f-]{36}$/);

  console.log(
    "Purchase statistics API auth, unsupported-search, empty, PII, failure, and query-plan contracts verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
