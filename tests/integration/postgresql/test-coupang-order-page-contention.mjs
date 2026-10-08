import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const scope = createTemporaryDatabase("quickhack-coupang-order-page-contention-");
configureIntegrationTestEnvironment(scope.databaseUrl);

const { prisma } = await import("@/quickhack_server/core/prisma");
const { lockAggregateKey } = await import(
  "@/quickhack_server/core/database/aggregate-command"
);
const {
  syncCoupangRecentAcceptOrders,
  syncCoupangOrderReconciliation,
} = await import("@/quickhack_server/sales-channel/coupang/sync-service");

const lockIdentity = { namespace: "COUPANG_ORDERSHEET_PAGE", key: "COUPANG" };
const orderedAt = new Date(Date.now() - 5 * 60_000).toISOString();

function order(orderId, shipmentId, vendorIds) {
  return {
    orderId,
    shipmentBoxId: shipmentId,
    status: "ACCEPT",
    orderedAt,
    paidAt: orderedAt,
    orderer: { name: "Orderer" },
    receiver: {
      name: "Receiver",
      safeNumber: "050700001234",
      addr1: "Seoul test address 1",
      addr2: "101",
      postCode: "01234",
    },
    parcelPrintMessage: "Door",
    orderItems: vendorIds.map((vendorItemId) => ({
      vendorItemId,
      vendorItemName: `Item ${vendorItemId}`,
      shippingCount: 1,
      holdCountForCancel: 0,
      cancelCount: 0,
      canceled: false,
      salesPrice: 1000,
    })),
  };
}

function response(orders) {
  const payload = { code: "SUCCESS", data: orders, nextToken: null };
  return {
    mode: "mock",
    source: "mock:/ordersheets",
    requestPath: "/ordersheets?status=ACCEPT",
    httpStatusCode: 200,
    responseHash: `rows-${orders.length}`,
    rawPayloadText: JSON.stringify(payload),
    auth: {
      providerType: "USB_QHKEY",
      keyAlias: "order-page-contention-test",
      keyFingerprint: "ORDER-PAGE-CONTENTION",
      authStatus: "SUCCEEDED",
      warningMessage: null,
    },
    payload,
  };
}

function credentialContext() {
  return {
    context: {
      providerType: "USB_QHKEY",
      channel: "COUPANG",
      status: "ACTIVE",
      keyAlias: "order-page-contention-test",
      keyFingerprint: "ORDER-PAGE-CONTENTION",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2036-01-01T00:00:00.000Z",
      warningMessage: null,
      errorMessage: null,
      readEnabled: true,
      writeEnabled: true,
      mode: "mock",
      apiHost: "http://127.0.0.1:3100",
      vendorId: "TEST-VENDOR",
      timeoutMs: 1_000,
    },
    sign() { throw new Error("Injected reader must not sign."); },
  };
}

async function waitForBothPageTransactions() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [processing, waiting] = await Promise.all([
      prisma.coupang_api_call_log.count({
        where: {
          api_name: { in: ["ordersheets.accept.recent", "ordersheets.reconciliation"] },
          processed_status: "PROCESSING",
        },
      }),
      prisma.$queryRaw`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `,
    ]);
    if (processing === 2 && waiting[0]?.count === 2) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [logs, activity] = await Promise.all([
    prisma.coupang_api_call_log.findMany({
      select: { api_name: true, processed_status: true, response_row_count: true, error_message: true },
    }),
    prisma.$queryRaw`
      SELECT state, wait_event_type, wait_event, left(query, 100) AS query
      FROM pg_stat_activity WHERE datname = current_database()
    `,
  ]);
  throw new Error(`Both order pages did not wait on the shared transaction lock: ${JSON.stringify({ logs, activity })}`);
}

let releaseHolder;
let holder;
let projections;

try {
  await prisma.sales_channel_product_mappings.createMany({
    data: ["3187044901", "3187044902"].map((external_vendor_item_id) => ({
      channel: "COUPANG",
      external_vendor_item_id,
    })),
  });

  const holderReleased = new Promise((resolve) => { releaseHolder = resolve; });
  let holderReady;
  const holderAcquired = new Promise((resolve) => { holderReady = resolve; });
  holder = prisma.$transaction(async (tx) => {
    await lockAggregateKey(tx, lockIdentity);
    holderReady();
    await holderReleased;
  }, { timeout: 15_000 });
  await holderAcquired;

  let recentResponded = false;
  const recent = syncCoupangRecentAcceptOrders({}, {
    openCredentialContext: credentialContext,
    async getOrdersheets() {
      if (recentResponded) return response([]);
      recentResponded = true;
      return response([order("935770000000009901", "884440000000009901", ["3187044901", "3187044902"])]);
    },
  });
  let reconciliationResponded = false;
  const reconciliation = syncCoupangOrderReconciliation({}, {
    openCredentialContext: credentialContext,
    async getOrdersheets(input) {
      if (input.status !== "ACCEPT" || reconciliationResponded) return response([]);
      reconciliationResponded = true;
      return response([order("935770000000009902", "884440000000009902", ["3187044902", "3187044901"])]);
    },
  });
  projections = Promise.allSettled([recent, reconciliation]);

  await waitForBothPageTransactions();
  assert.equal(await prisma.coupang_order_raw.count(), 0);
  releaseHolder();
  await holder;
  const results = await projections;
  assert(results.every((result) => result.status === "fulfilled"),
    `Concurrent order pages failed: ${results.map((result) => result.reason ?? "ok")}`);
  assert.equal(await prisma.coupang_order_raw.count(), 2);
  assert.equal(await prisma.order_matching_work_queue.count(), 4);
  assert.equal(await prisma.sales_channel_product_mappings.count(), 2);
  assert.equal(await prisma.coupang_api_call_log.count({
    where: { processed_status: "FAILED" },
  }), 0);
  assert.equal(await prisma.coupang_api_call_log.count({
    where: { processed_status: "SUCCESS", response_row_count: 1 },
  }), 2);

  await prisma.$executeRawUnsafe("CREATE SEQUENCE test_ordersheet_deadlock_once");
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_ordersheet_deadlock_once() RETURNS trigger AS $$
    BEGIN
      IF nextval('test_ordersheet_deadlock_once') = 1 THEN
        RAISE EXCEPTION 'one-shot ordersheet transaction conflict' USING ERRCODE = '40P01';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER test_ordersheet_deadlock_once
    BEFORE INSERT ON order_matching_work_queue
    FOR EACH ROW EXECUTE FUNCTION test_ordersheet_deadlock_once()
  `);
  let retryResponded = false;
  const retried = await syncCoupangRecentAcceptOrders({}, {
    openCredentialContext: credentialContext,
    async getOrdersheets() {
      if (retryResponded) return response([]);
      retryResponded = true;
      return response([order("935770000000009903", "884440000000009903", ["3187044901"])]);
    },
  });
  assert.equal(retried.orders, 1);
  assert.equal(await prisma.coupang_order_raw.count(), 3);
  assert.equal(await prisma.order_matching_work_queue.count(), 5);
  const retryCount = await prisma.$queryRawUnsafe(
    "SELECT last_value::int AS value FROM test_ordersheet_deadlock_once"
  );
  assert.equal(retryCount[0].value, 2, "The whole page transaction was not retried once.");
  assert.equal(await prisma.coupang_api_call_log.count({
    where: { processed_status: "FAILED" },
  }), 0);
  console.log("Concurrent order pages serialize their writes, and a 40P01 page retries atomically.");
} finally {
  releaseHolder?.();
  if (holder) await Promise.allSettled([holder]);
  if (projections) await projections;
  await prisma.$disconnect();
  scope.cleanup();
}
