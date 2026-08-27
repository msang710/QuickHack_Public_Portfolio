import assert from "node:assert/strict";
import {
  createInventoryCatalogFixture,
  createSellableDeviceFixtures,
} from "../../support/inventory-business-fixtures.mjs";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { createDeterministicConcurrencyHarness } from "../../support/deterministic-concurrency-harness.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-manual-order-match-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
const prioritySeed = Number(process.env.QUICKHACK_PRIORITY_ITERATION ?? 1);
function seededChoice(salt) {
  const value = Math.imul(prioritySeed ^ salt, 1_664_525) + 1_013_904_223;
  return (value >>> 0) % 2 === 0;
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const {
    executeManualOrderMatch,
    listManualOrderMatchCandidates,
    previewManualOrderMatch,
  } = await import(
    "@/quickhack_server/sales-channel/coupang/manual-order-match-service"
  );
  const { matchCoupangOrders } = await import(
    "@/quickhack_server/sales-channel/coupang/order-matching-service"
  );
  const {
    filterTargetsWithoutManualOrderMatchIntent,
    hasActiveManualOrderMatchIntent,
  } = await import(
    "@/quickhack_server/sales-channel/coupang/manual-order-match-intent-service"
  );
  const { ensureRegisteredWorkerJobs } = await import(
    "@/quickhack_server/workers/worker-jobs"
  );
  const { ORDER_MATCHING_WORKER_KEY } = await import(
    "@/quickhack_server/workers/worker-keys"
  );
  const { lockDeviceAggregates } = await import(
    "@/quickhack_server/inventory/device-aggregate-lock"
  );
  const timestamp = new Date("2026-08-26T09:00:00.000Z");
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "manual-order-match",
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalog,
    { count: 2, timestamp }
  );
  const userRow = await prisma.users.create({
    data: {
      username: "manual-order-match-manager",
      password_hash: "integration-test-only",
      role: "MANAGER",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: userRow.username,
    role: "MANAGER",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };
  await ensureRegisteredWorkerJobs();
  const matchingWorkerJob = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: ORDER_MATCHING_WORKER_KEY },
  });
  const matchingWorkerLease = {
    workerJobId: matchingWorkerJob.worker_job_id,
    leaseToken: "manual-order-match-priority-test",
    signal: new AbortController().signal,
    assertLeaseActive: async () => undefined,
  };
  const otherUserRow = await prisma.users.create({
    data: {
      username: "manual-order-match-other-manager",
      password_hash: "integration-test-only",
      role: "MANAGER",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const otherUser = { ...user, userId: otherUserRow.user_id, username: otherUserRow.username };
  const externalOrderId = "ORDER-MANUAL-1";
  const externalShipmentId = "SHIP-MANUAL-1";
  const externalVendorItemId = "VENDOR-MANUAL-1";

  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_order_status: "INSTRUCT",
      ordered_at: timestamp,
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const work = await prisma.order_matching_work_queue.create({
    data: {
      channel: "COUPANG",
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_vendor_item_id: externalVendorItemId,
      vendor_item_name: "Manual order match fixture",
      ordered_quantity: 1,
      matchable_quantity: 1,
      mapping_status: "MAPPED",
      sales_offer_id: catalog.salesOffer.sales_offer_id,
      ...catalog.orderMappingSnapshot,
      work_status: "UNMATCHED",
      ordered_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: "ORDER-MANUAL-CANCELED",
      external_shipment_id: "SHIP-MANUAL-CANCELED",
      external_order_status: "INSTRUCT",
      ordered_at: timestamp,
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const canceledWork = await prisma.order_matching_work_queue.create({
    data: {
      channel: "COUPANG",
      external_order_id: "ORDER-MANUAL-CANCELED",
      external_shipment_id: "SHIP-MANUAL-CANCELED",
      external_vendor_item_id: "VENDOR-MANUAL-CANCELED",
      vendor_item_name: "Canceled manual order match fixture",
      ordered_quantity: 1,
      matchable_quantity: 1,
      mapping_status: "MAPPED",
      sales_offer_id: catalog.salesOffer.sales_offer_id,
      ...catalog.orderMappingSnapshot,
      work_status: "UNMATCHED",
      canceled: 1,
      ordered_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  let postCycleCount = 0;
  let observedActiveIntentCount = 0;
  const dependencies = {
    sensitiveActionVerified: true,
    async afterIntentAcquire({ leaseId }) {
      const lease = await prisma.manual_order_match_intent_leases.findUniqueOrThrow({
        where: { lease_id: leaseId },
      });
      assert.equal(lease.lease_status, "ACTIVE");
      assert.ok(lease.expires_at > lease.acquired_at);
      observedActiveIntentCount += 1;
    },
    async runPostCycle(input) {
      postCycleCount += 1;
      assert.ok(input.externalOrderId.startsWith("ORDER-MANUAL-"));
      assert.ok(input.externalShipmentId.startsWith("SHIP-MANUAL-"));
      return { status: "COMPLETED", result: { verified: true } };
    },
  };

  async function execute(input, idempotencyKey) {
    const selectionReceiptId = input.operation === "RELEASE"
      ? null
      : (await listManualOrderMatchCandidates({
          search: input.pgNo,
          limit: 10,
          workItemId: input.workItemId,
          operation: input.operation,
        }, user)).items
          .find((candidate) => candidate.pgNo === input.pgNo)?.selectionReceiptId ?? null;
    const selectedInput = { ...input, selectionReceiptId };
    const preview = await previewManualOrderMatch(selectedInput, user);
    assert.equal(preview.eligible, true, preview.reasonCodes.join(","));
    return executeManualOrderMatch(
      {
        ...selectedInput,
        manifestToken: preview.manifestToken,
        idempotencyKey,
      },
      user,
      dependencies
    );
  }

  const common = {
    workItemId: work.work_item_id,
    requestChannel: "PHONE",
    reason: "고객 전화 요청",
  };
  const missingPgInput = {
    ...common,
    operation: "ASSIGN",
    pgNo: "ZZ9999999999",
  };
  const missingPgPreview = await previewManualOrderMatch(missingPgInput, user);
  assert.equal(missingPgPreview.eligible, false);
  assert.deepEqual(missingPgPreview.reasonCodes, ["PG_NOT_FOUND"]);
  await assert.rejects(
    executeManualOrderMatch(
      {
        ...missingPgInput,
        manifestToken: missingPgPreview.manifestToken,
        idempotencyKey: "manual-order-match-missing-pg",
      },
      user,
      dependencies
    ),
    (error) => error?.code === "MANUAL_ORDER_MATCH_PREVIEW_STALE"
  );
  assert.equal(await prisma.match_worker_allocation.count(), 0);

  const assignInput = {
    ...common,
    operation: "ASSIGN",
    pgNo: devices[0].pgNo,
    selectionReceiptId: (await listManualOrderMatchCandidates({
      search: devices[0].pgNo,
      limit: 10,
      workItemId: work.work_item_id,
      operation: "ASSIGN",
    }, user)).items
      .find((candidate) => candidate.pgNo === devices[0].pgNo)?.selectionReceiptId,
  };
  const receiptScopedToAssign = assignInput.selectionReceiptId;
  const otherUserPreview = await previewManualOrderMatch(assignInput, otherUser);
  assert.equal(otherUserPreview.eligible, false);
  assert.ok(otherUserPreview.reasonCodes.includes("PG_SELECTION_REQUIRED"));
  const wrongOperationPreview = await previewManualOrderMatch({
    ...assignInput,
    operation: "REPLACE",
    allocationId: 999999,
  }, user);
  assert.equal(wrongOperationPreview.eligible, false);
  assert.ok(wrongOperationPreview.reasonCodes.includes("PG_SELECTION_REQUIRED"));
  const canceledReceipt = (await listManualOrderMatchCandidates({
    search: devices[0].pgNo,
    limit: 10,
    workItemId: canceledWork.work_item_id,
    operation: "ASSIGN",
  }, user)).items.find((candidate) => candidate.pgNo === devices[0].pgNo)?.selectionReceiptId;
  const canceledPreview = await previewManualOrderMatch({
    ...common,
    workItemId: canceledWork.work_item_id,
    operation: "ASSIGN",
    pgNo: devices[0].pgNo,
    selectionReceiptId: canceledReceipt,
  }, user);
  assert.equal(canceledPreview.eligible, false);
  assert.ok(canceledPreview.reasonCodes.includes("ORDER_ITEM_CANCELED"));
  assert.equal(assignInput.selectionReceiptId, receiptScopedToAssign);
  const unsignedPreview = await previewManualOrderMatch({
    ...assignInput,
    selectionReceiptId: null,
  }, user);
  assert.equal(unsignedPreview.eligible, false);
  assert.ok(unsignedPreview.reasonCodes.includes("PG_SELECTION_REQUIRED"));
  await assert.rejects(
    executeManualOrderMatch(
      {
        ...assignInput,
        selectionReceiptId: "00000000-0000-0000-0000-000000000000",
        manifestToken: unsignedPreview.manifestToken,
        idempotencyKey: "manual-order-match-forged-selection",
      },
      user,
      dependencies
    ),
    (error) => error?.code === "MANUAL_ORDER_MATCH_PREVIEW_STALE"
  );
  assert.equal(await prisma.match_worker_allocation.count(), 0);
  const assignPreview = await previewManualOrderMatch(assignInput, user);
  assert.equal(assignPreview.eligible, true);
  const assignRequest = {
    ...assignInput,
    manifestToken: assignPreview.manifestToken,
    idempotencyKey: "manual-order-match-assign",
  };
  const priorityHarness = createDeterministicConcurrencyHarness("BM-01");
  const priorityDependencies = {
    ...dependencies,
    async afterIntentAcquire(input) {
      await dependencies.afterIntentAcquire(input);
      await priorityHarness.arrive("manual", "AFTER_INTENT_ACQUIRE");
    },
  };
  const manualAssignment = executeManualOrderMatch(
    assignRequest,
    user,
    priorityDependencies
  );
  await priorityHarness.waitFor("manual", "AFTER_INTENT_ACQUIRE");
  const automaticAttempt = await matchCoupangOrders(
    { workItemIds: [work.work_item_id] },
    null,
    matchingWorkerLease,
    {
      inventoryVerification: {
        openCredentialContext: async () => ({ test: true }),
        getInventory: async () => ({
          mode: "mock",
          source: "manual-order-match-priority-test",
          requestPath: "/priority-test",
          httpStatusCode: 200,
          responseHash: "priority-test",
          auth: {},
          payload: {
            vendorItemId: externalVendorItemId,
            amountInStock: 0,
            salePrice: null,
            onSale: true,
            checkedAt: timestamp,
          },
        }),
      },
    }
  );
  assert.equal(automaticAttempt.summary.deferredItemCount, 1);
  assert.equal(automaticAttempt.summary.matchedDeviceCount, 0);
  assert.equal(automaticAttempt.items[0]?.failureReason, "MANUAL_ORDER_MATCH_INTENT_ACTIVE");
  priorityHarness.release("manual", "AFTER_INTENT_ACQUIRE");
  const assigned = await manualAssignment;
  assert.deepEqual(
    priorityHarness.artifact({ winner: "manual", loser: "auto" }),
    {
      scenario: "BM-01",
      events: [
        { type: "ARRIVED", actor: "manual", checkpoint: "AFTER_INTENT_ACQUIRE" },
        { type: "RELEASED", actor: "manual", checkpoint: "AFTER_INTENT_ACQUIRE" },
      ],
      winner: "manual",
      loser: "auto",
    }
  );
  assert.equal(assigned.workStatus, "MATCHED");
  assert.equal(assigned.postCycle.status, "COMPLETED");
  assert.equal(postCycleCount, 1);

  const assignedAllocation = await prisma.match_worker_allocation.findUniqueOrThrow({
    where: { allocation_id: assigned.allocationId },
  });
  assert.equal(assignedAllocation.pg_no, devices[0].pgNo);
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({ where: { pg_no: devices[0].pgNo } }))
      .inventory_status,
    "RESERVED"
  );

  const replayed = await executeManualOrderMatch(
    {
      ...assignRequest,
    },
    user,
    dependencies
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.postCycle.status, "PENDING");
  assert.equal(postCycleCount, 1);

  const replaceReceipt = (await listManualOrderMatchCandidates({
    search: devices[1].pgNo,
    limit: 10,
    workItemId: work.work_item_id,
    operation: "REPLACE",
  }, user)).items.find((candidate) => candidate.pgNo === devices[1].pgNo)
    ?.selectionReceiptId;
  const replaceInput = {
    ...common,
    operation: "REPLACE",
    allocationId: assigned.allocationId,
    pgNo: devices[1].pgNo,
    selectionReceiptId: replaceReceipt,
  };
  let replacePreview = await previewManualOrderMatch(replaceInput, user);
  assert.equal(replacePreview.eligible, true, replacePreview.reasonCodes.join(","));
  const instructPriorityHarness = createDeterministicConcurrencyHarness("BM-03");
  const staleAfterInstruct = executeManualOrderMatch({
    ...replaceInput,
    manifestToken: replacePreview.manifestToken,
    idempotencyKey: "manual-order-match-bm03-instruct",
  }, user, {
    ...dependencies,
    async afterIntentAcquire(input) {
      await dependencies.afterIntentAcquire(input);
      await instructPriorityHarness.arrive("manual", "AFTER_INTENT_ACQUIRE");
    },
  });
  await instructPriorityHarness.waitFor("manual", "AFTER_INTENT_ACQUIRE");
  await prisma.match_worker_allocation.update({
    where: { allocation_id: assigned.allocationId },
    data: { allocation_status: "API_ACKED" },
  });
  instructPriorityHarness.release("manual", "AFTER_INTENT_ACQUIRE");
  await assert.rejects(
    staleAfterInstruct,
    (error) => error?.code === "MANUAL_ORDER_MATCH_PREVIEW_STALE"
  );
  replacePreview = await previewManualOrderMatch(replaceInput, user);
  assert.equal(replacePreview.eligible, true, replacePreview.reasonCodes.join(","));
  const rematchPriorityHarness = createDeterministicConcurrencyHarness("BM-02");
  const manualReplacement = executeManualOrderMatch({
    ...replaceInput,
    manifestToken: replacePreview.manifestToken,
    idempotencyKey: "manual-order-match-replace",
  }, user, {
    ...dependencies,
    async afterIntentAcquire(input) {
      await dependencies.afterIntentAcquire(input);
      await rematchPriorityHarness.arrive("manual", "AFTER_INTENT_ACQUIRE");
    },
  });
  await rematchPriorityHarness.waitFor("manual", "AFTER_INTENT_ACQUIRE");
  const rematchTargets = await filterTargetsWithoutManualOrderMatchIntent(prisma, [
    { externalOrderId, externalShipmentId },
    { externalOrderId: "ORDER-NOT-LEASED", externalShipmentId: "SHIP-NOT-LEASED" },
  ]);
  assert.deepEqual(rematchTargets, [
    { externalOrderId: "ORDER-NOT-LEASED", externalShipmentId: "SHIP-NOT-LEASED" },
  ]);
  rematchPriorityHarness.release("manual", "AFTER_INTENT_ACQUIRE");
  const replaced = await manualReplacement;
  assert.equal(replaced.workStatus, "MATCHED");
  assert.equal(postCycleCount, 2);
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({ where: { pg_no: devices[0].pgNo } }))
      .inventory_status,
    "SELLABLE"
  );
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({ where: { pg_no: devices[1].pgNo } }))
      .inventory_status,
    "RESERVED"
  );
  const replacement = await prisma.match_worker_allocation.findUniqueOrThrow({
    where: { allocation_id: replaced.allocationId },
  });
  assert.equal(replacement.pg_no, devices[1].pgNo);

  const releaseInput = {
    ...common,
    operation: "RELEASE",
    allocationId: replaced.allocationId,
  };
  const releasePreviewBeforePrint = await previewManualOrderMatch(releaseInput, user);
  assert.equal(releasePreviewBeforePrint.eligible, true);
  const packingPriorityHarness = createDeterministicConcurrencyHarness("BM-05");
  const staleAfterPacking = executeManualOrderMatch({
    ...releaseInput,
    manifestToken: releasePreviewBeforePrint.manifestToken,
    idempotencyKey: "manual-order-match-bm05-packing",
  }, user, {
    ...dependencies,
    async afterIntentAcquire(input) {
      await dependencies.afterIntentAcquire(input);
      await packingPriorityHarness.arrive("manual", "AFTER_INTENT_ACQUIRE");
    },
  });
  await packingPriorityHarness.waitFor("manual", "AFTER_INTENT_ACQUIRE");
  const packageGroup = await prisma.shipment_package_groups.create({
    data: {
      channel: "COUPANG",
      grouping_key: "BM-05-PACKING",
      receiver_name_snapshot: "Priority test",
      receiver_address_snapshot: "Priority test address",
      group_status: "DRAFT",
    },
  });
  const packageMember = await prisma.shipment_package_group_members.create({
    data: {
      package_group_id: packageGroup.package_group_id,
      allocation_id: replaced.allocationId,
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      member_sequence: 1,
    },
  });
  packingPriorityHarness.release("manual", "AFTER_INTENT_ACQUIRE");
  await assert.rejects(
    staleAfterPacking,
    (error) => error?.code === "MANUAL_ORDER_MATCH_PREVIEW_STALE"
  );
  await prisma.shipment_package_group_members.update({
    where: { package_group_member_id: packageMember.package_group_member_id },
    data: { removed_at: new Date() },
  });

  const releasePreviewBeforeReturn = await previewManualOrderMatch(releaseInput, user);
  assert.equal(releasePreviewBeforeReturn.eligible, true);
  const returnPriorityHarness = createDeterministicConcurrencyHarness("BM-06");
  const staleAfterReturn = executeManualOrderMatch({
    ...releaseInput,
    manifestToken: releasePreviewBeforeReturn.manifestToken,
    idempotencyKey: "manual-order-match-bm06-return",
  }, user, {
    ...dependencies,
    async afterIntentAcquire(input) {
      await dependencies.afterIntentAcquire(input);
      await returnPriorityHarness.arrive("manual", "AFTER_INTENT_ACQUIRE");
    },
  });
  await returnPriorityHarness.waitFor("manual", "AFTER_INTENT_ACQUIRE");
  const returnRaw = await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: "BM-06-RETURN",
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      cancel_count: 1,
    },
  });
  await prisma.coupang_return_allocation.create({
    data: {
      coupang_return_raw_id: returnRaw.coupang_return_raw_id,
      allocation_id: replaced.allocationId,
      external_receipt_id: returnRaw.external_receipt_id,
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_vendor_item_id: externalVendorItemId,
      pg_no: devices[1].pgNo,
      action_type: "RETURN",
      linked_by_user_id: user.userId,
    },
  });
  returnPriorityHarness.release("manual", "AFTER_INTENT_ACQUIRE");
  await assert.rejects(
    staleAfterReturn,
    (error) => error?.code === "MANUAL_ORDER_MATCH_PREVIEW_STALE"
  );
  await prisma.coupang_return_raw.delete({
    where: { coupang_return_raw_id: returnRaw.coupang_return_raw_id },
  });

  const printPriorityHarness = createDeterministicConcurrencyHarness("BM-04");
  const staleAfterPrint = executeManualOrderMatch({
    ...releaseInput,
    manifestToken: releasePreviewBeforePrint.manifestToken,
    idempotencyKey: "manual-order-match-bm04-print",
  }, user, {
    ...dependencies,
    async afterIntentAcquire(input) {
      await dependencies.afterIntentAcquire(input);
      await printPriorityHarness.arrive("manual", "AFTER_INTENT_ACQUIRE");
    },
  });
  await printPriorityHarness.waitFor("manual", "AFTER_INTENT_ACQUIRE");
  await prisma.match_worker_allocation.update({
    where: { allocation_id: replaced.allocationId },
    data: { shipment_list_printed_at: new Date() },
  });
  printPriorityHarness.release("manual", "AFTER_INTENT_ACQUIRE");
  await assert.rejects(
    staleAfterPrint,
    (error) => error?.code === "MANUAL_ORDER_MATCH_PREVIEW_STALE"
  );
  await prisma.match_worker_allocation.update({
    where: { allocation_id: replaced.allocationId },
    data: { shipment_list_printed_at: null },
  });

  await prisma.match_worker_allocation.update({
    where: { allocation_id: replaced.allocationId },
    data: { allocation_status: "API_ACKED" },
  });

  const released = await execute(
    releaseInput,
    "manual-order-match-release"
  );
  assert.equal(released.workStatus, "UNMATCHED");
  assert.equal(released.postCycle.status, "NOT_REQUIRED");
  assert.equal(postCycleCount, 2);
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({ where: { pg_no: devices[1].pgNo } }))
      .inventory_status,
    "SELLABLE"
  );
  assert.equal(
    await prisma.match_worker_allocation.count({
      where: { allocation_status: "CANCELED" },
    }),
    2
  );
  const recoveryWork = await prisma.order_matching_work_queue.findUniqueOrThrow({
    where: { work_item_id: work.work_item_id },
  });
  assert.equal(recoveryWork.manual_recovery_status, "REASSIGNMENT_REQUIRED");
  assert.equal(recoveryWork.work_failure_reason, "MANUAL_REASSIGNMENT_REQUIRED");
  assert.equal(recoveryWork.manual_recovery_started_by_user_id, user.userId);
  const manualActivity = await prisma.employee_activity_logs.findMany({
    where: {
      target_type: "SALES_CHANNEL_ORDER_ITEM",
      target_id: String(work.work_item_id),
      action_type: { in: [
        "CHANNEL_ORDER_MANUAL_ASSIGN",
        "CHANNEL_ORDER_MANUAL_REPLACE",
        "CHANNEL_ORDER_MANUAL_RELEASE",
      ] },
    },
    include: { changes: { orderBy: { employee_activity_log_change_id: "asc" } } },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(
    manualActivity.map((entry) => entry.action_type),
    [
      "CHANNEL_ORDER_MANUAL_ASSIGN",
      "CHANNEL_ORDER_MANUAL_REPLACE",
      "CHANNEL_ORDER_MANUAL_RELEASE",
    ]
  );
  const activityFields = manualActivity.map((entry) =>
    Object.fromEntries(entry.changes.map((change) => [change.field_name, change.after_value]))
  );
  assert.equal(activityFields[0].pgNo, devices[0].pgNo);
  assert.equal(activityFields[1].pgNo, devices[1].pgNo);
  assert.equal(activityFields[2].pgNo, null);
  assert.equal(activityFields[0].requestChannel, "PHONE");
  assert.equal(activityFields[1].operation, "REPLACE");
  assert.equal(activityFields[2].idempotencyKey, "manual-order-match-release");

  const correctionReceipt = (await listManualOrderMatchCandidates({
    search: devices[1].pgNo,
    limit: 10,
    workItemId: work.work_item_id,
    operation: "ASSIGN",
  }, user)).items.find((candidate) => candidate.pgNo === devices[1].pgNo)
    ?.selectionReceiptId;
  const correctionRaceInput = {
    ...common,
    operation: "ASSIGN",
    pgNo: devices[1].pgNo,
    selectionReceiptId: correctionReceipt,
  };
  const correctionRacePreview = await previewManualOrderMatch(correctionRaceInput, user);
  assert.equal(correctionRacePreview.eligible, true);
  const correctionPriorityHarness = createDeterministicConcurrencyHarness("BM-07");
  const staleAfterCorrection = executeManualOrderMatch({
    ...correctionRaceInput,
    manifestToken: correctionRacePreview.manifestToken,
    idempotencyKey: "manual-order-match-bm07-correction",
  }, user, {
    ...dependencies,
    async afterIntentAcquire(input) {
      await dependencies.afterIntentAcquire(input);
      await correctionPriorityHarness.arrive("manual", "AFTER_INTENT_ACQUIRE");
    },
  });
  await correctionPriorityHarness.waitFor("manual", "AFTER_INTENT_ACQUIRE");
  await prisma.$transaction(async (tx) => {
    await lockDeviceAggregates(tx, {
      pgNos: [devices[1].pgNo],
      requireDevice: true,
      requireInventory: true,
    });
    await ledgerApi.transitionInventoryStatusWithLedger(tx, {
      pgNo: devices[1].pgNo,
      expectedFromStatus: "SELLABLE",
      toStatus: "HOLD",
      transitionPolicy: "MANUAL_INVENTORY_CORRECTION",
      operationKey: "manual-priority-bm07-hold",
      movementType: ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "MANUAL_PRIORITY_TEST",
      sourceId: "BM-07",
    });
  });
  correctionPriorityHarness.release("manual", "AFTER_INTENT_ACQUIRE");
  await assert.rejects(
    staleAfterCorrection,
    (error) => error?.code === "MANUAL_ORDER_MATCH_PREVIEW_STALE"
  );
  await prisma.$transaction(async (tx) => {
    await lockDeviceAggregates(tx, {
      pgNos: [devices[1].pgNo],
      requireDevice: true,
      requireInventory: true,
    });
    await ledgerApi.transitionInventoryStatusWithLedger(tx, {
      pgNo: devices[1].pgNo,
      expectedFromStatus: "HOLD",
      toStatus: "SELLABLE",
      transitionPolicy: "MANUAL_INVENTORY_CORRECTION",
      operationKey: "manual-priority-bm07-restore",
      movementType: ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "MANUAL_PRIORITY_TEST",
      sourceId: "BM-07",
    });
  });

  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: "ORDER-MANUAL-RACE",
      external_shipment_id: "SHIP-MANUAL-RACE",
      external_order_status: "INSTRUCT",
      ordered_at: timestamp,
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const competingWork = await prisma.order_matching_work_queue.create({
    data: {
      channel: "COUPANG",
      external_order_id: "ORDER-MANUAL-RACE",
      external_shipment_id: "SHIP-MANUAL-RACE",
      external_vendor_item_id: "VENDOR-MANUAL-RACE",
      vendor_item_name: "Concurrent manual order match fixture",
      ordered_quantity: 1,
      matchable_quantity: 1,
      mapping_status: "MAPPED",
      sales_offer_id: catalog.salesOffer.sales_offer_id,
      ...catalog.orderMappingSnapshot,
      work_status: "UNMATCHED",
      ordered_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  async function preparedAssign(workItemId, operationKey) {
    const receipt = (await listManualOrderMatchCandidates({
      search: devices[0].pgNo,
      limit: 10,
      workItemId,
      operation: "ASSIGN",
    }, user)).items.find((candidate) => candidate.pgNo === devices[0].pgNo)
      ?.selectionReceiptId;
    const input = {
      workItemId,
      operation: "ASSIGN",
      pgNo: devices[0].pgNo,
      selectionReceiptId: receipt,
      requestChannel: "PHONE",
      reason: "동시 배정 검증",
    };
    const preview = await previewManualOrderMatch(input, user);
    assert.equal(preview.eligible, true, preview.reasonCodes.join(","));
    return {
      ...input,
      manifestToken: preview.manifestToken,
      idempotencyKey: operationKey,
    };
  }
  const raceRequests = await Promise.all([
    preparedAssign(work.work_item_id, "manual-order-match-race-a"),
    preparedAssign(competingWork.work_item_id, "manual-order-match-race-b"),
  ]);
  const orderedRaceRequests = seededChoice(0x8)
    ? raceRequests
    : [...raceRequests].reverse();
  const raceResults = await Promise.allSettled(
    orderedRaceRequests.map((request) =>
      executeManualOrderMatch(request, user, dependencies)
    )
  );
  assert.equal(
    raceResults.filter((result) => result.status === "fulfilled").length,
    1,
    raceResults.map((result) =>
      result.status === "fulfilled"
        ? "fulfilled"
        : `${result.reason?.code ?? "ERROR"}:${result.reason?.message ?? result.reason}`
    ).join(" | ")
  );
  assert.equal(
    raceResults.filter((result) => result.status === "rejected").length,
    1
  );
  assert.equal(
    await prisma.match_worker_allocation.count({
      where: {
        pg_no: devices[0].pgNo,
        allocation_status: { in: ["ALLOCATED", "API_ACKED", "SHIPMENT_LIST_PRINTED"] },
      },
    }),
    1
  );
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({
      where: { pg_no: devices[0].pgNo },
    })).inventory_status,
    "RESERVED"
  );
  assert.ok(observedActiveIntentCount >= 5);
  assert.equal(
    await prisma.manual_order_match_intent_leases.count({
      where: { lease_status: "ACTIVE" },
    }),
    0
  );
  assert.equal(
    await prisma.manual_order_match_intent_leases.count({
      where: { lease_status: "RELEASED" },
    }),
    observedActiveIntentCount
  );
  const expiredAcquiredAt = new Date(Date.now() - 60_000);
  const expiredAt = new Date(Date.now() - 30_000);
  await prisma.manual_order_match_intent_leases.create({
    data: {
      external_order_id: "ORDER-MANUAL-EXPIRED",
      external_shipment_id: "SHIP-MANUAL-EXPIRED",
      pg_nos: [devices[1].pgNo],
      command_key: "expired-owner-process",
      owner_user_id: user.userId,
      acquired_at: expiredAcquiredAt,
      expires_at: expiredAt,
    },
  });
  assert.equal(await hasActiveManualOrderMatchIntent(prisma, {
    externalOrderId: "ORDER-MANUAL-EXPIRED",
    externalShipmentId: "SHIP-MANUAL-EXPIRED",
    pgNo: devices[1].pgNo,
  }), false);

  const activeRaceAllocation = await prisma.match_worker_allocation.findFirstOrThrow({
    where: {
      pg_no: devices[0].pgNo,
      allocation_status: { in: ["ALLOCATED", "API_ACKED", "SHIPMENT_LIST_PRINTED"] },
    },
  });
  await prisma.match_worker_allocation.update({
    where: { allocation_id: activeRaceAllocation.allocation_id },
    data: { allocation_status: "CANCELED", released_at: new Date() },
  });
  const balanceBefore = await prisma.inventory_quantity_balances.findMany({
    where: { inventory_sku_id: catalog.sku.inventory_sku_id },
    orderBy: { inventory_status: "asc" },
  });
  const balanceHarness = createDeterministicConcurrencyHarness("BM-09");
  const transitionDependencies = (actor) => ({
    async beforeBalanceLock() {
      await balanceHarness.arrive(actor, "BEFORE_BALANCE_LOCK");
    },
  });
  const reserveTransition = prisma.$transaction(async (tx) => {
    await ledgerApi.transitionInventoryStatusWithLedger(tx, {
      pgNo: devices[1].pgNo,
      expectedFromStatus: "SELLABLE",
      toStatus: "RESERVED",
      transitionPolicy: "ORDER_MATCHING_RESERVATION",
      operationKey: "manual-priority-bm09-reserve",
      movementType: ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "MANUAL_PRIORITY_TEST",
      sourceId: "BM-09",
      ...transitionDependencies("reserve"),
    });
  });
  const releaseTransition = prisma.$transaction(async (tx) => {
    await ledgerApi.transitionInventoryStatusWithLedger(tx, {
      pgNo: devices[0].pgNo,
      expectedFromStatus: "RESERVED",
      toStatus: "SELLABLE",
      transitionPolicy: "ORDER_REMATCH_RELEASE",
      operationKey: "manual-priority-bm09-release",
      movementType: ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "MANUAL_PRIORITY_TEST",
      sourceId: "BM-09",
      ...transitionDependencies("release"),
    });
  });
  await Promise.all([
    balanceHarness.waitFor("reserve", "BEFORE_BALANCE_LOCK"),
    balanceHarness.waitFor("release", "BEFORE_BALANCE_LOCK"),
  ]);
  const balanceReleaseOrder = seededChoice(0x9)
    ? ["reserve", "release"]
    : ["release", "reserve"];
  for (const actor of balanceReleaseOrder) {
    balanceHarness.release(actor, "BEFORE_BALANCE_LOCK");
  }
  await Promise.all([reserveTransition, releaseTransition]);
  const balanceAfter = await prisma.inventory_quantity_balances.findMany({
    where: { inventory_sku_id: catalog.sku.inventory_sku_id },
    orderBy: { inventory_status: "asc" },
  });
  assert.deepEqual(
    balanceAfter.map((balance) => [balance.inventory_status, balance.quantity]),
    balanceBefore.map((balance) => [balance.inventory_status, balance.quantity])
  );

  console.log("Manual order match PostgreSQL execution flow passed.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
