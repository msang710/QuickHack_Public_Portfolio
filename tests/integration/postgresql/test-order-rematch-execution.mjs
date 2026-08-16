import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createInventoryCatalogFixture,
  createSellableDeviceFixtures,
} from "../../support/inventory-business-fixtures.mjs";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
  projectRoot,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-order-rematch-execution-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
let releaseMatchingRun;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const writeRules = await import(
    "@/quickhack_shared/inventory/inventory-write-rules"
  );
  const { listCoupangOrderRematchPreview } = await import(
    "@/quickhack_server/sales-channel/coupang/order-rematch-preview-service"
  );
  const { runManagedCoupangOrderRematch } = await import(
    "@/quickhack_server/sales-channel/coupang/order-rematch-service"
  );
  const { runWorkerJobWithExecutor } = await import(
    "@/quickhack_server/workers/worker-jobs"
  );
  const { ORDER_MATCHING_WORKER_KEY } = await import(
    "@/quickhack_server/workers/worker-keys"
  );
  const { matchCoupangOrders } = await import(
    "@/quickhack_server/sales-channel/coupang/order-matching-service"
  );
  const { WorkerShutdownRequestedError } = await import(
    "@/quickhack_server/workers/shutdown-runtime"
  );
  const timestamp = new Date("2026-08-04T20:00:00.000Z");
  const laterTimestamp = new Date("2026-08-04T20:01:00.000Z");
  const catalogA = await createInventoryCatalogFixture(prisma, {
    prefix: "rematch-execution-a",
    timestamp,
  });
  const catalogB = await createInventoryCatalogFixture(prisma, {
    prefix: "rematch-execution-b",
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalogA,
    { count: 4, timestamp }
  );
  const userRow = await prisma.users.create({
    data: {
      username: "rematch-execution-manager",
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
  let deviceIndex = 0;

  async function createEligibleShipment(key) {
    const externalOrderId = `ORDER-EXEC-${key}`;
    const externalShipmentId = `SHIP-EXEC-${key}`;
    const externalVendorItemId = `VENDOR-EXEC-${key}`;
    const device = devices[deviceIndex++];
    assert(device, "The execution fixture ran out of devices.");

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
        vendor_item_name: `재매칭 실행 ${key}`,
        ordered_quantity: 1,
        matchable_quantity: 1,
        mapping_status: "MAPPED",
        sales_offer_id: catalogA.salesOffer.sales_offer_id,
        ...catalogA.orderMappingSnapshot,
        work_status: "MATCHED",
        matched_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: externalVendorItemId,
        sales_offer_id: catalogA.salesOffer.sales_offer_id,
        mapping_status: "MAPPED",
        mapped_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await prisma.$transaction((tx) =>
      ledgerApi.transitionInventoryStatusWithLedger(tx, {
        pgNo: device.pgNo,
        expectedFromStatus: "SELLABLE",
        toStatus: "RESERVED",
        transitionPolicy:
          writeRules.INVENTORY_TRANSITION_POLICY.orderMatchingReservation,
        operationKey: `rematch-execution-reserve:${key}`,
        movementType:
          ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "INTEGRATION_TEST",
        sourceId: key,
        occurredAt: timestamp,
      })
    );
    const allocation = await prisma.match_worker_allocation.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_vendor_item_id: externalVendorItemId,
        pg_no: device.pgNo,
        sales_offer_id: catalogA.salesOffer.sales_offer_id,
        inventory_sku_id: catalogA.sku.inventory_sku_id,
        required_model: catalogA.options.model.label,
        required_storage: catalogA.options.storage.label,
        required_color: catalogA.options.color.label,
        required_warranty_group: "2Y",
        inventory_status_before_allocation: "SELLABLE",
        allocation_status: "API_ACKED",
        allocated_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });

    return {
      externalOrderId,
      externalShipmentId,
      externalVendorItemId,
      work,
      allocation,
      device,
    };
  }

  async function assertOriginalState(shipment) {
    const [work, allocation, inventory] = await Promise.all([
      prisma.order_matching_work_queue.findUnique({
        where: { work_item_id: shipment.work.work_item_id },
      }),
      prisma.match_worker_allocation.findUnique({
        where: { allocation_id: shipment.allocation.allocation_id },
      }),
      prisma.inventory.findUnique({ where: { pg_no: shipment.device.pgNo } }),
    ]);

    assert.equal(work.work_status, "MATCHED");
    assert.equal(allocation.allocation_status, "API_ACKED");
    assert.equal(allocation.released_at, null);
    assert.equal(inventory.inventory_status, "RESERVED");
  }

  const first = await createEligibleShipment("FIRST");
  const stalePreview = await listCoupangOrderRematchPreview({
    unpaginated: true,
  });
  await prisma.sales_channel_product_mappings.update({
    where: {
      channel_external_vendor_item_id: {
        channel: "COUPANG",
        external_vendor_item_id: first.externalVendorItemId,
      },
    },
    data: {
      sales_offer_id: catalogB.salesOffer.sales_offer_id,
      updated_at: laterTimestamp,
    },
  });

  await assert.rejects(
    () =>
      runManagedCoupangOrderRematch(
        { manifestToken: stalePreview.manifestToken },
        user,
        { runMatcher: async () => assert.fail("Stale preview ran matcher.") }
      ),
    (error) => error?.code === "COUPANG_ORDER_REMATCH_PREVIEW_STALE"
  );
  await assertOriginalState(first);
  const staleRunJob = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: ORDER_MATCHING_WORKER_KEY },
  });
  assert.equal(staleRunJob.status, "FAILED");
  assert.equal(
    staleRunJob.attempt_count,
    0,
    "A rejected manual rematch consumed the scheduled worker retry budget."
  );

  const currentPreview = await listCoupangOrderRematchPreview({
    unpaginated: true,
  });
  const movementCountBeforeRollback =
    await prisma.inventory_quantity_movements.count();
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION force_rematch_rollback_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced rematch rollback';
    END;
    $$;
    CREATE TRIGGER force_rematch_rollback
    BEFORE UPDATE OF allocation_status ON match_worker_allocation
    FOR EACH ROW
    WHEN (NEW.allocation_id = ${first.allocation.allocation_id}
      AND NEW.allocation_status = 'CANCELED')
    EXECUTE FUNCTION force_rematch_rollback_fn();
  `);

  await assert.rejects(() =>
    runManagedCoupangOrderRematch(
      { manifestToken: currentPreview.manifestToken },
      user,
      { runMatcher: async () => assert.fail("Rolled back reset ran matcher.") }
    )
  );
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER force_rematch_rollback ON match_worker_allocation;
    DROP FUNCTION force_rematch_rollback_fn();
  `);
  await assertOriginalState(first);
  assert.equal(
    await prisma.inventory_quantity_movements.count(),
    movementCountBeforeRollback,
    "A failed reset committed part of the inventory ledger transition."
  );

  let matchingRunStarted;
  const matchingRunStartedPromise = new Promise((resolve) => {
    matchingRunStarted = resolve;
  });
  const releaseMatchingRunPromise = new Promise((resolve) => {
    releaseMatchingRun = resolve;
  });
  const activeMatchingRun = runWorkerJobWithExecutor(
    ORDER_MATCHING_WORKER_KEY,
    null,
    async () => {
      matchingRunStarted();
      await releaseMatchingRunPromise;
      return { summary: { heldForRematchConflict: true } };
    }
  );
  await matchingRunStartedPromise;
  await assert.rejects(
    () =>
      runManagedCoupangOrderRematch(
        { manifestToken: currentPreview.manifestToken },
        user,
        { runMatcher: async () => assert.fail("Busy rematch ran matcher.") }
      ),
    (error) => error?.code === "COUPANG_ORDER_REMATCH_MATCHING_BUSY"
  );
  await assertOriginalState(first);
  releaseMatchingRun();
  await activeMatchingRun;

  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: "ORDER-EXEC-HISTORICAL",
      external_shipment_id: "SHIP-EXEC-HISTORICAL",
      external_order_status: "DEPARTURE",
      ordered_at: timestamp,
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const historicalWork = await prisma.order_matching_work_queue.create({
    data: {
      channel: "COUPANG",
      external_order_id: "ORDER-EXEC-HISTORICAL",
      external_shipment_id: "SHIP-EXEC-HISTORICAL",
      external_vendor_item_id: "VENDOR-EXEC-HISTORICAL",
      vendor_item_name: "historical completed order",
      ordered_quantity: 1,
      matchable_quantity: 1,
      mapping_status: "MAPPED",
      sales_offer_id: catalogA.salesOffer.sales_offer_id,
      ...catalogA.orderMappingSnapshot,
      work_status: "MATCHED",
      matched_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_historical_rematch_lock_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'historical rematch row was locked';
    END;
    $$;
    CREATE TRIGGER reject_historical_rematch_lock
    BEFORE UPDATE ON order_matching_work_queue
    FOR EACH ROW
    WHEN (OLD.work_item_id = ${historicalWork.work_item_id})
    EXECUTE FUNCTION reject_historical_rematch_lock_fn();
  `);

  let targetedWorkItemIds = [];
  let rematchWorkerLease = null;
  const completed = await runManagedCoupangOrderRematch(
    { manifestToken: currentPreview.manifestToken },
    user,
    {
      runMatcher: async (input, _user, workerLease) => {
        targetedWorkItemIds = input.workItemIds;
        rematchWorkerLease = workerLease;
        return {
          summary: {
            processedItemCount: 1,
            matchedDeviceCount: 1,
            fullyMatchedItemCount: 1,
            partialItemCount: 0,
            failedItemCount: 0,
            skippedItemCount: 0,
            deferredItemCount: 0,
            conflictCount: 0,
          },
          items: [],
        };
      },
    }
  );
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER reject_historical_rematch_lock ON order_matching_work_queue;
    DROP FUNCTION reject_historical_rematch_lock_fn();
  `);
  assert.equal(completed.resetCommitted, true);
  assert.equal(completed.rematch.status, "COMPLETED");
  assert.deepEqual(targetedWorkItemIds, [first.work.work_item_id]);
  assert.equal(rematchWorkerLease?.workerJobId, staleRunJob.worker_job_id);
  assert.equal(rematchWorkerLease?.signal.aborted, false);

  const [resetWork, canceledAllocation, releasedInventory] = await Promise.all([
    prisma.order_matching_work_queue.findUnique({
      where: { work_item_id: first.work.work_item_id },
    }),
    prisma.match_worker_allocation.findUnique({
      where: { allocation_id: first.allocation.allocation_id },
    }),
    prisma.inventory.findUnique({ where: { pg_no: first.device.pgNo } }),
  ]);
  assert.equal(resetWork.work_status, "UNMATCHED");
  assert.equal(resetWork.matched_at, null);
  assert.equal(resetWork.sales_offer_id, catalogB.salesOffer.sales_offer_id);
  assert.equal(canceledAllocation.allocation_status, "CANCELED");
  assert.equal(
    canceledAllocation.released_at?.getTime(),
    completed.reset.resetAt.getTime()
  );
  assert.equal(releasedInventory.inventory_status, "SELLABLE");
  assert.equal(
    await prisma.inventory_quantity_movements.count({
      where: {
        operation_key: `ORDER_REMATCH_RELEASE:${first.allocation.allocation_id}`,
      },
    }),
    2
  );
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: {
        action_type: "COUPANG_ORDER_REMATCH_RESET",
        result: "SUCCESS",
      },
    }),
    1
  );

  const second = await createEligibleShipment("SECOND");
  const secondPreview = await listCoupangOrderRematchPreview({
    unpaginated: true,
  });
  const failed = await runManagedCoupangOrderRematch(
    { manifestToken: secondPreview.manifestToken },
    user,
    {
      runMatcher: async () => {
        throw new Error("forced matcher failure");
      },
    }
  );
  assert.equal(failed.resetCommitted, true);
  assert.equal(failed.rematch.status, "FAILED");
  const failedWork = await prisma.order_matching_work_queue.findUnique({
    where: { work_item_id: second.work.work_item_id },
  });
  const failedAllocation = await prisma.match_worker_allocation.findUnique({
    where: { allocation_id: second.allocation.allocation_id },
  });
  assert.equal(failedWork.work_status, "UNMATCHED");
  assert.equal(failedAllocation.allocation_status, "CANCELED");
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: {
        action_type: "COUPANG_ORDER_REMATCH_EXECUTE",
        result: "FAILED",
      },
    }),
    1
  );

  await assert.rejects(
    () =>
      runManagedCoupangOrderRematch(
        { manifestToken: secondPreview.manifestToken },
        user,
        { runMatcher: async () => assert.fail("Duplicate reset ran matcher.") }
      ),
    (error) => error?.code === "COUPANG_ORDER_REMATCH_PREVIEW_STALE"
  );

  const shutdownShipment = await createEligibleShipment("SHUTDOWN");
  const shutdownPreview = await listCoupangOrderRematchPreview({
    unpaginated: true,
  });
  await assert.rejects(
    () =>
      runManagedCoupangOrderRematch(
        { manifestToken: shutdownPreview.manifestToken },
        user,
        {
          runMatcher: (input, matcherUser, workerLease) =>
            matchCoupangOrders(input, matcherUser, workerLease, {
              afterInventoryVerificationPrepared: async () => {
                throw new WorkerShutdownRequestedError("rematch-test");
              },
            }),
        }
      ),
    (error) => error?.code === "WORKER_SHUTDOWN_REQUESTED"
  );
  const shutdownMapping =
    await prisma.sales_channel_product_mappings.findUniqueOrThrow({
      where: {
        channel_external_vendor_item_id: {
          channel: "COUPANG",
          external_vendor_item_id: shutdownShipment.externalVendorItemId,
        },
      },
    });
  const shutdownVerification =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: shutdownMapping.mapping_id },
    });
  assert.equal(shutdownVerification.verification_status, "CHECK_FAILED");
  assert.equal(
    shutdownVerification.last_error_code,
    "WORKER_SHUTDOWN_REQUESTED"
  );
  assert.equal(
    shutdownVerification.last_worker_job_id,
    staleRunJob.worker_job_id
  );

  const matchingSource = await readFile(
    path.join(
      projectRoot,
      "quickhack_server/sales-channel/coupang/order-matching-service.ts"
    ),
    "utf8"
  );
  const apiSource = await readFile(
    path.join(
      projectRoot,
      "quickhack_server/api/sales-channel/coupang/order-rematch.ts"
    ),
    "utf8"
  );
  const viewSource = await readFile(
    path.join(
      projectRoot,
      "quickhack_client/components/sales-channel/channel-order-matching-manager-view.tsx"
    ),
    "utf8"
  );
  assert(matchingSource.includes("strictTargetedRun"));
  assert(matchingSource.includes("!strictTargetedRun"));
  assert(matchingSource.includes("workItemIds"));
  assert(apiSource.includes('canAccessRole(user.role, "MANAGER")'));
  assert(apiSource.includes("SENSITIVE_ACTIONS.channelOrderMatching"));
  assert(apiSource.includes("runManagedCoupangOrderRematch"));
  assert(viewSource.includes("manifestToken"));
  assert(viewSource.includes("rematchPreview.hasMore"));
  assert(viewSource.includes("DangerousConfirmDialog"));

  console.log(
    "Order rematch worker ownership, busy rejection, atomic reset, targeted execution, and terminal verification failure handling verified."
  );
} finally {
  releaseMatchingRun?.();
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
