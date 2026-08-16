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
  "quickhack-return-statistics-api-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function databaseDateTime(value) {
  return new Date(value.replace(" ", "T") + ".000Z");
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
  const returnsApi = await import(
    "@/quickhack_server/api/statistics/returns"
  );
  const snapshotStore = await import(
    "@/quickhack_server/statistics/statistics-snapshot-store"
  );
  const timestamp = databaseDateTime("2026-07-27 09:00:00");
  const roles = ["LEADER", "MANAGER", "STAFF", "VIEWER"];
  const tokens = new Map();

  for (const role of roles) {
    const user = await prisma.users.create({
      data: {
        username: `return-statistics-${role.toLowerCase()}`,
        password_hash: "test-only",
        role,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    tokens.set(role, await authService.createUserSession(user.user_id));
  }

  const unauthorized = await returnsApi.GET(
    request("/api/statistics/returns")
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(
    (
      await returnsApi.GET(
        request("/api/statistics/returns?q=legacy")
      )
    ).status,
    401
  );

  for (const role of ["MANAGER", "STAFF", "VIEWER"]) {
    const forbidden = await returnsApi.GET(
      request("/api/statistics/returns", tokens.get(role))
    );
    assert.equal(
      forbidden.status,
      403,
      `${role} must not call the LEADER return statistics API.`
    );
  }

  for (const invalidPath of [
    "/api/statistics/returns?fromDate=2026-07-01",
    "/api/statistics/returns?fromDate=invalid&toDate=2026-07-10",
    "/api/statistics/returns?fromDate=2026-07-10&toDate=2026-07-01",
    "/api/statistics/returns?fromDate=2026-07-01&toDate=2999-01-01",
  ]) {
    const invalidPeriod = await returnsApi.GET(
      request(invalidPath, tokens.get("LEADER"))
    );
    assert.equal(invalidPeriod.status, 400);
  }

  for (const unsupportedSearchPath of [
    "/api/statistics/returns?q=",
    "/api/statistics/returns?q=API",
  ]) {
    const unsupportedSearch = await returnsApi.GET(
      request(unsupportedSearchPath, tokens.get("LEADER"))
    );
    assert.equal(unsupportedSearch.status, 400);
    assert.match(
      (await unsupportedSearch.json()).message,
      /통계 검색은 지원하지 않습니다/
    );
  }

  const ok = await returnsApi.GET(
    request(
      "/api/statistics/returns?fromDate=2026-07-01&toDate=2026-07-10",
      tokens.get("LEADER")
    )
  );
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get(QUICKHACK_TRACE_ID_HEADER));
  const okBody = await ok.json();
  assert.equal(okBody.ok, true);
  assert.equal("query" in okBody.data, false);
  assert.deepEqual(okBody.data.calculation.period, {
    fromDate: "2026-07-01",
    toDate: "2026-07-10",
    dayCount: 10,
  });
  assert.equal(
    okBody.data.calculation.delivery.status,
    "LIVE_CUSTOM_PERIOD"
  );
  assert.equal(okBody.data.source.observedReturnReceiptCount, 0);
  assert.equal(okBody.data.summary.requestRate30Day.value, null);
  assert.equal(okBody.data.overview.receiptCount, 0);
  assert.equal(okBody.data.overview.receiptLinkRate.value, null);
  assert.deepEqual(okBody.data.productRows, []);

  const defaultWithoutSnapshot = await returnsApi.GET(
    request("/api/statistics/returns", tokens.get("LEADER"))
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

  const serialized = JSON.stringify(okBody);

  for (const forbiddenKey of [
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

  const device = await prisma.devices.create({
    data: {
      pg_no: "RETURN-STATS-API-PG",
      model: "API Model",
      storage: "256GB",
      color: "Black",
      sale_grade: "A",
    },
  });
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: "API-ORDER-1",
      external_shipment_id: "API-SHIP-1",
      external_order_status: "DELIVERING",
      ordered_at: databaseDateTime("2026-06-10 09:00:00"),
      paid_at: databaseDateTime("2026-06-10 09:01:00"),
    },
  });
  const allocation = await prisma.match_worker_allocation.create({
    data: {
      external_order_id: "API-ORDER-1",
      external_shipment_id: "API-SHIP-1",
      external_vendor_item_id: "API-ITEM-1",
      vendor_item_name: "API Model 256GB",
      pg_no: device.pg_no,
      allocation_status: "CANCELED",
    },
  });
  await prisma.sales_records.create({
    data: {
      allocation_id: allocation.allocation_id,
      pg_no: device.pg_no,
      channel: "COUPANG",
      external_order_id: "API-ORDER-1",
      external_shipment_id: "API-SHIP-1",
      external_vendor_item_id: "API-ITEM-1",
      sold_at: databaseDateTime("2026-06-12 09:00:00"),
      sale_status: "RETURNED",
      sales_price: 500_000,
      purchase_price: 350_000,
      model: "API Model",
      storage: "256GB",
      sale_grade: "A",
    },
  });
  const returnRaw = await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: "API-RETURN-1",
      external_order_id: "API-ORDER-1",
      external_shipment_id: "API-SHIP-1",
      cancel_type: "RETURN",
      cancel_count: 1,
      items: {
        create: {
          external_receipt_id: "API-RETURN-1",
          external_order_id: "API-ORDER-1",
          external_shipment_id: "API-SHIP-1",
          external_vendor_item_id: "API-ITEM-1",
          vendor_item_name: "API Model 256GB",
          cancel_count: 1,
        },
      },
    },
  });
  const event = await prisma.coupang_raw_change_event.create({
    data: {
      source_table: "coupang_return_raw",
      source_pk: "API-RETURN-1",
      external_order_id: "API-ORDER-1",
      external_shipment_id: "API-SHIP-1",
      external_receipt_id: "API-RETURN-1",
      event_type: "COUPANG_RETURN_OBSERVED",
      change_hash: "api-contract-return-observed",
      process_status: "DONE",
      detected_at: databaseDateTime("2026-06-17 10:00:00"),
      processed_at: databaseDateTime("2026-06-17 10:00:00"),
      fields: {
        create: Object.entries({
          external_created_at: "2026-06-17T00:00:00.000Z",
          external_modified_at: "2026-06-17T00:00:00.000Z",
          external_completed_at: "2026-06-18T00:00:00.000Z",
          external_completion_type: "VENDOR_CONFIRM",
          receipt_type: "RETURN",
          receipt_status: "RETURNS_COMPLETED",
          release_status: "COMPLETED",
          fault_by_type: "VENDOR",
          reason_code: "DEFECT",
          reason_label: "상품 불량",
          reason_category: "상품 문제",
          reason_detail: "전원 불량",
          cancel_count: "1",
        }).map(([field_name, after_value]) => ({
          field_name,
          before_value: null,
          after_value,
          created_at: databaseDateTime("2026-06-17 10:00:00"),
        })),
      },
    },
  });
  assert.ok(event.coupang_raw_change_event_id > 0);
  const returnAllocation = await prisma.coupang_return_allocation.create({
    data: {
      coupang_return_raw_id: returnRaw.coupang_return_raw_id,
      allocation_id: allocation.allocation_id,
      external_receipt_id: "API-RETURN-1",
      external_order_id: "API-ORDER-1",
      external_shipment_id: "API-SHIP-1",
      external_vendor_item_id: "API-ITEM-1",
      pg_no: device.pg_no,
      action_type: "approve",
      linked_at: databaseDateTime("2026-06-18 09:00:00"),
    },
  });
  await prisma.inspections.create({
    data: {
      pg_no: device.pg_no,
      inspection_type: "RETURN_CHECK",
      source_type: "COUPANG_RETURN",
      coupang_return_allocation_id:
        returnAllocation.coupang_return_allocation_id,
      inspection_result: "PASSED",
      checked_at: databaseDateTime("2026-06-18 09:00:00"),
    },
  });
  await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "RETURN_APPROVAL",
      request_status: "COMPLETED",
      external_order_id: "API-ORDER-1",
      target_type: "COUPANG_RETURN_RECEIPT",
      target_external_id: "API-RETURN-1",
      idempotency_key: "return-statistics-api-contract",
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: "/mock/returns/API-RETURN-1/approval",
      source_menu_key: "return-after-shipment",
      source_entity_type: "COUPANG_RETURN_RECEIPT",
      source_entity_id: "API-RETURN-1",
      requested_at: databaseDateTime("2026-06-18 08:00:00"),
      local_finalized_at: databaseDateTime("2026-06-18 09:00:00"),
    },
  });

  const populated = await returnsApi.GET(
    request("/api/statistics/returns", tokens.get("LEADER"))
  );
  assert.equal(populated.status, 200);
  const populatedBody = await populated.json();
  assert.equal(populatedBody.data.source.cohortSalesCount, 1);
  assert.equal(
    populatedBody.data.source.observedReturnReceiptCount,
    1
  );
  assert.equal(populatedBody.data.source.confirmedAllocationLinkCount, 1);
  assert.equal(populatedBody.data.overview.receiptCount, 1);
  assert.equal(populatedBody.data.overview.returnQuantity, 1);
  assert.equal(populatedBody.data.overview.linkedReceiptCount, 1);
  assert.equal(populatedBody.data.overview.linkedSaleRecordCount, 1);
  assert.equal(populatedBody.data.overview.completedReceiptCount, 1);
  assert.equal(populatedBody.data.overview.receiptLinkRate.value, 100);
  assert.equal(populatedBody.data.summary.requestRate30Day.numerator, 1);
  assert.equal(populatedBody.data.summary.requestRate30Day.denominator, 1);
  assert.equal(populatedBody.data.inspectionOutcome.recoveredCount, 1);
  assert.equal(
    populatedBody.data.leadTimes.observationToApprovalRequest.sampleCount,
    1
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
        domain === "RETURNS"
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
  const stored = await returnsApi.GET(
    request("/api/statistics/returns", tokens.get("LEADER"))
  );
  assert.equal(stored.status, 200);
  const storedBody = await stored.json();
  assert.equal(
    storedBody.data.calculation.delivery.status,
    "SNAPSHOT_CURRENT"
  );
  assert.equal(storedBody.data.overview.receiptCount, 1);

  const indexRows = await prisma.$queryRawUnsafe(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'idx_sales_records_status',
          'idx_coupang_raw_change_event_type',
          'idx_sales_channel_write_requests_channel_type',
          'idx_coupang_raw_change_event_field_event_id'
        )`
  );
  const indexNames = new Set(indexRows.map((row) => row.indexname));
  assert.deepEqual(indexNames, new Set([
    "idx_sales_records_status",
    "idx_coupang_raw_change_event_type",
    "idx_sales_channel_write_requests_channel_type",
    "idx_coupang_raw_change_event_field_event_id",
  ]));

  await prisma.$executeRawUnsafe("DROP TABLE sales_records");
  const failed = await returnsApi.GET(
    request(
      "/api/statistics/returns?fromDate=2026-07-01&toDate=2026-07-10",
      tokens.get("LEADER")
    )
  );
  assert.equal(failed.status, 500);
  const failedBody = await failed.json();
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.code, "INTERNAL_ERROR");
  assert.match(failedBody.traceId, /^[0-9a-f-]{36}$/);

  console.log(
    "Return statistics API auth, unsupported-search, empty, PII, failure, and query-plan contracts verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
