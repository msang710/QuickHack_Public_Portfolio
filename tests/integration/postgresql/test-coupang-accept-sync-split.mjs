import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const scope = createTemporaryDatabase("quickhack-accept-sync-split-");
configureIntegrationTestEnvironment(scope.databaseUrl);

const { prisma } = await import("@/quickhack_server/core/prisma");
const {
  syncCoupangAcceptOrders,
  syncCoupangRecentAcceptOrders,
} = await import("@/quickhack_server/sales-channel/coupang/sync-service");
const { ensureRegisteredWorkerJobs } = await import(
  "@/quickhack_server/workers/worker-jobs"
);

function credentialContext() {
  return {
    context: {
      providerType: "USB_QHKEY",
      channel: "COUPANG",
      status: "ACTIVE",
      keyAlias: "accept-sync-split-test",
      keyFingerprint: "ACCEPT-SYNC-SPLIT",
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

function response(data) {
  const payload = { code: "SUCCESS", data, nextToken: null };
  return {
    mode: "mock",
    source: "mock:/ordersheets",
    requestPath: "/ordersheets?status=ACCEPT",
    httpStatusCode: 200,
    responseHash: `rows-${data.length}`,
    rawPayloadText: JSON.stringify(payload),
    auth: {
      providerType: "USB_QHKEY",
      keyAlias: "accept-sync-split-test",
      keyFingerprint: "ACCEPT-SYNC-SPLIT",
      authStatus: "SUCCEEDED",
      warningMessage: null,
    },
    payload,
  };
}

try {
  await prisma.server_worker_jobs.create({
    data: {
      worker_key: "coupang-accept-order-sync",
      worker_name: "Existing ACCEPT sync",
      worker_type: "COUPANG_SYNC",
      status: "IDLE",
      schedule_enabled: 1,
      interval_seconds: 60,
      next_run_at: new Date(),
    },
  });
  await ensureRegisteredWorkerJobs();
  const reconciliationWorker = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: "coupang-order-reconciliation" },
  });
  assert.equal(reconciliationWorker.schedule_enabled, 1);
  assert.equal(reconciliationWorker.interval_seconds, 3600);
  await prisma.server_worker_jobs.update({
    where: { worker_key: "coupang-accept-order-sync" },
    data: { schedule_enabled: 0, next_run_at: null },
  });
  await prisma.server_worker_jobs.delete({
    where: { worker_key: "coupang-order-reconciliation" },
  });
  await ensureRegisteredWorkerJobs();
  const disabledReconciliation = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: "coupang-order-reconciliation" },
  });
  assert.equal(disabledReconciliation.schedule_enabled, 0);
  assert.equal(disabledReconciliation.next_run_at, null);

  const orderTime = new Date(Date.now() - 15 * 60_000);
  const order = {
    orderId: "935770000000009909",
    shipmentBoxId: "884440000000009909",
    status: "ACCEPT",
    orderedAt: orderTime.toISOString(),
    paidAt: orderTime.toISOString(),
    orderer: { name: "Orderer" },
    receiver: {
      name: "Receiver",
      safeNumber: "050700001234",
      addr1: "Seoul test address 1",
      addr2: "101",
      postCode: "01234",
    },
    parcelPrintMessage: "Door",
    orderItems: [{
      vendorItemId: "3187044909",
      vendorItemName: "Split test item",
      shippingCount: 1,
      holdCountForCancel: 0,
      cancelCount: 0,
      canceled: false,
      salesPrice: 1000,
    }],
  };
  let visible = false;
  const recentInputs = [];
  const recentDependencies = {
    openCredentialContext: credentialContext,
    async getOrdersheets(input) {
      recentInputs.push(input);
      assert.equal(input.searchType, "timeFrame");
      assert.equal(input.maxPerPage, undefined);
      const inside = Date.parse(input.createdAtFrom) <= orderTime.getTime() &&
        orderTime.getTime() < Date.parse(input.createdAtTo) + 60_000;
      return response(visible && inside ? [order] : []);
    },
  };

  assert.equal((await syncCoupangRecentAcceptOrders({}, recentDependencies)).orders, 0);
  visible = true;
  assert.ok((await syncCoupangRecentAcceptOrders({}, recentDependencies)).orders >= 1);
  await syncCoupangRecentAcceptOrders({}, recentDependencies);
  assert.ok(recentInputs.length >= 9);
  assert.equal(await prisma.coupang_order_raw.count(), 1);
  assert.equal(await prisma.order_matching_work_queue.count(), 1);

  const recentCursor = await prisma.channel_sync_cursors.findUniqueOrThrow({
    where: { channel_resource_status_filter: {
      channel: "COUPANG",
      resource: "ordersheets.accept.recent",
      status_filter: "ACCEPT",
    } },
  });
  assert.ok(recentCursor.last_window_to);

  const oldSuccess = new Date(Date.now() - 72 * 60 * 60_000);
  const transitionedTime = new Date(Date.now() - 60 * 60 * 60_000);
  const transitionedOrder = {
    ...order,
    orderId: "935770000000009910",
    shipmentBoxId: "884440000000009910",
    status: "INSTRUCT",
    orderedAt: transitionedTime.toISOString(),
    paidAt: transitionedTime.toISOString(),
  };
  await prisma.channel_sync_cursors.create({
    data: {
      channel: "COUPANG",
      resource: "ordersheets.accept",
      status_filter: "ACCEPT",
      last_success_at: oldSuccess,
    },
  });
  const fullInputs = [];
  const fullDependencies = {
    openCredentialContext: credentialContext,
    async getOrdersheets(input) {
      fullInputs.push(input);
      assert.equal(input.searchType, undefined);
      const inside = Date.parse(`${input.createdAtFrom}T00:00:00+09:00`) <=
        transitionedTime.getTime() &&
        transitionedTime.getTime() <
        Date.parse(`${input.createdAtTo}T00:00:00+09:00`) + 86_400_000;
      return response(input.status === "INSTRUCT" && inside
        ? [transitionedOrder]
        : []);
    },
  };
  await assert.rejects(
    syncCoupangAcceptOrders({}, {
      openCredentialContext: credentialContext,
      async getOrdersheets() { throw new Error("initial provider outage"); },
    }),
    /initial provider outage/
  );
  const initialFailedCursor = await prisma.channel_sync_cursors.findUniqueOrThrow({
    where: { channel_resource_status_filter: {
      channel: "COUPANG",
      resource: "ordersheets.reconciliation",
      status_filter: "ACCEPT",
    } },
  });
  assert.equal(initialFailedCursor.last_window_to, null);
  assert.ok(initialFailedCursor.last_window_from);
  const first = await syncCoupangAcceptOrders({}, fullDependencies);
  assert.ok(first.backlogSeconds > 40 * 60 * 60);
  assert.equal(first.caughtUp, false);
  assert.equal(first.expiredWorkItems, 0);
  const second = await syncCoupangAcceptOrders({}, fullDependencies);
  assert.ok(second.backlogSeconds > 16 * 60 * 60);
  const third = await syncCoupangAcceptOrders({}, fullDependencies);
  assert.ok(third.backlogSeconds < 60);
  assert.equal(third.caughtUp, true);
  assert.ok(fullInputs.some((input) => input.status === "INSTRUCT"));
  assert.equal(await prisma.coupang_order_raw.count(), 2);
  assert.equal(await prisma.order_matching_work_queue.count(), 2);

  const cursorKey = { channel_resource_status_filter: {
    channel: "COUPANG",
    resource: "ordersheets.reconciliation",
    status_filter: "ACCEPT",
  } };
  const coveredTo = (await prisma.channel_sync_cursors.findUniqueOrThrow({
    where: cursorKey,
  })).last_window_to.toISOString();
  await assert.rejects(
    syncCoupangAcceptOrders({}, {
      openCredentialContext: credentialContext,
      async getOrdersheets() { throw new Error("provider unavailable"); },
    }),
    /provider unavailable/
  );
  const failedCursor = await prisma.channel_sync_cursors.findUniqueOrThrow({
    where: cursorKey,
  });
  assert.equal(failedCursor.last_window_to.toISOString(), coveredTo);
  assert.ok(failedCursor.last_failure_at);

  console.log("Recent and reconciliation ACCEPT sync paths passed.");
} finally {
  await prisma.$disconnect();
  scope.cleanup();
}
