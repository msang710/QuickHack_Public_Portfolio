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
  "quickhack-order-mapping-snapshot-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

async function createWorkItem(input) {
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: input.externalOrderId,
      external_shipment_id: input.externalShipmentId,
      external_order_status: "INSTRUCT",
      ordered_at: input.timestamp,
      synced_at: input.timestamp,
      created_at: input.timestamp,
      updated_at: input.timestamp,
    },
  });

  const offer = input.salesOfferId
    ? await prisma.sales_offers.findUnique({
        where: { sales_offer_id: input.salesOfferId },
        include: {
          model_option: true,
          storage_option: true,
          color_option: true,
          warranty_group_option: true,
        },
      })
    : null;

  return prisma.order_matching_work_queue.create({
    data: {
      channel: "COUPANG",
      external_order_id: input.externalOrderId,
      external_shipment_id: input.externalShipmentId,
      external_vendor_item_id: input.externalVendorItemId,
      vendor_item_name: input.externalVendorItemId,
      ordered_quantity: input.matchableQuantity ?? 1,
      matchable_quantity: input.matchableQuantity ?? 1,
      mapping_status: input.mappingStatus ?? "MAPPED",
      mapping_failure_reason: input.mappingFailureReason ?? null,
      sales_offer_id: input.salesOfferId,
      required_model_label: offer?.model_option.label ?? null,
      required_storage_label:
        offer?.storage_match_mode === "RANDOM"
          ? "RANDOM"
          : offer?.storage_option?.label ?? null,
      required_color_label:
        offer?.color_match_mode === "RANDOM"
          ? "RANDOM"
          : offer?.color_option?.label ?? null,
      required_warranty_group:
        offer?.warranty_group_option.option_key ?? null,
      work_status: input.workStatus,
      work_failure_reason: input.workFailureReason ?? null,
      matched_at: input.matchedAt ?? null,
      created_at: input.timestamp,
      updated_at: input.timestamp,
    },
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const {
    setCoupangProductMapping,
  } = await import(
    "@/quickhack_server/sales-channel/coupang/product-mapping-service"
  );
  const {
    expireOrderMatchingWorkItemIfEligible,
    synchronizeWorkItemMappingSnapshot,
  } = await import(
    "@/quickhack_server/sales-channel/coupang/order-mapping-snapshot-service"
  );
  const {
    getSalesOfferSnapshotDefinition,
    saveSalesOffer,
  } = await import("@/quickhack_server/catalog/sales-offer-service");
  const { findInventoryCandidatesForSalesOffer } = await import(
    "@/quickhack_server/catalog/sales-offer-candidate-service"
  );
  const { matchCoupangOrders } = await import(
    "@/quickhack_server/sales-channel/coupang/order-matching-service"
  );
  const { prepareCoupangMatchingCycleInventoryVerification } = await import(
    "@/quickhack_server/sales-channel/coupang/inventory-verification-cycle-service"
  );
  const { ensureRegisteredWorkerJobs } = await import(
    "@/quickhack_server/workers/worker-jobs"
  );
  const { ORDER_MATCHING_WORKER_KEY } = await import(
    "@/quickhack_server/workers/worker-keys"
  );
  await ensureRegisteredWorkerJobs();
  const matchingWorkerJob =
    await prisma.server_worker_jobs.findUniqueOrThrow({
      where: { worker_key: ORDER_MATCHING_WORKER_KEY },
    });
  const matchingWorkerLease = {
    workerJobId: matchingWorkerJob.worker_job_id,
    leaseToken: "snapshot-integrity-worker-lease",
    signal: new AbortController().signal,
    assertLeaseActive: async () => undefined,
  };

  const timestamp = new Date("2026-08-04T01:00:00.000Z");
  const changedAt = new Date("2026-08-04T01:05:00.000Z");
  const vendorItemId = "SNAPSHOT-VENDOR-MAIN";
  const userRow = await prisma.users.create({
    data: {
      username: "mapping-snapshot-tester",
      password_hash: "integration-test-only",
      role: "MANAGER",
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "매핑 스냅샷 검사자",
    role: "MANAGER",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };
  const catalogA = await createInventoryCatalogFixture(prisma, {
    prefix: "snapshot-a",
    timestamp,
  });
  const catalogB = await createInventoryCatalogFixture(prisma, {
    prefix: "snapshot-b",
    timestamp,
  });
  const devicesA = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalogA,
    { count: 2, timestamp }
  );

  await prisma.sales_channel_product_mappings.create({
    data: {
      channel: "COUPANG",
      external_vendor_item_id: vendorItemId,
      sales_offer_id: catalogA.salesOffer.sales_offer_id,
      mapping_status: "MAPPED",
      mapped_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  const workSpecs = [
    { key: "unmatched", workStatus: "UNMATCHED" },
    {
      key: "failed",
      workStatus: "FAILED",
      workFailureReason: "INSUFFICIENT_INVENTORY",
    },
    {
      key: "skipped",
      workStatus: "SKIPPED",
      workFailureReason: "NO_CHANNEL_SALES_OFFER",
    },
    { key: "partial", workStatus: "PARTIAL", matchedAt: timestamp },
    { key: "matched", workStatus: "MATCHED", matchedAt: timestamp },
    {
      key: "expired",
      workStatus: "EXPIRED",
      workFailureReason: "SYNC_WINDOW_EXPIRED",
    },
    { key: "allocated", workStatus: "UNMATCHED" },
  ];
  const workItems = new Map();

  for (const [index, spec] of workSpecs.entries()) {
    const item = await createWorkItem({
      ...spec,
      externalOrderId: `SNAPSHOT-ORDER-${index + 1}`,
      externalShipmentId: `SNAPSHOT-SHIP-${index + 1}`,
      externalVendorItemId: vendorItemId,
      salesOfferId: catalogA.salesOffer.sales_offer_id,
      timestamp,
    });
    workItems.set(spec.key, item);
  }

  const allocatedItem = workItems.get("allocated");
  await prisma.match_worker_allocation.create({
    data: {
      external_order_id: allocatedItem.external_order_id,
      external_shipment_id: allocatedItem.external_shipment_id,
      external_vendor_item_id: allocatedItem.external_vendor_item_id,
      pg_no: devicesA[0].pgNo,
      sales_offer_id: catalogA.salesOffer.sales_offer_id,
      inventory_sku_id: catalogA.sku.inventory_sku_id,
      allocation_status: "ALLOCATED",
      allocated_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  const changed = await setCoupangProductMapping(
    {
      externalVendorItemId: vendorItemId,
      salesOfferId: catalogB.salesOffer.sales_offer_id,
    },
    user
  );
  assert.equal(changed.mappingChanged, true);
  assert.equal(changed.updatedOrderItemCount, 3);
  assert.equal(changed.protectedOrderItemCount, 4);
  assert.equal(changed.protectedByWorkStatusCount, 3);
  assert.equal(changed.protectedByActiveAllocationCount, 1);
  const exactVendorVerification =
    await prepareCoupangMatchingCycleInventoryVerification({
      salesOfferIds: [catalogA.salesOffer.sales_offer_id],
      externalVendorItemIds: [vendorItemId],
      workerLease: matchingWorkerLease,
    });
  assert.equal(
    exactVendorVerification.candidateMappingCount,
    1,
    "Verification lost the current vendor option after its default offer changed."
  );

  const changedRows = await prisma.order_matching_work_queue.findMany({
    where: { external_vendor_item_id: vendorItemId },
  });
  const byId = new Map(changedRows.map((row) => [row.work_item_id, row]));

  for (const key of ["unmatched", "failed", "skipped"]) {
    const row = byId.get(workItems.get(key).work_item_id);
    assert.equal(row.sales_offer_id, catalogB.salesOffer.sales_offer_id);
    assert.equal(row.mapping_status, "MAPPED");
    assert.equal(row.work_status, "UNMATCHED");
    assert.equal(row.work_failure_reason, null);
    assert.equal(row.matched_at, null);
  }

  for (const key of ["partial", "matched", "expired", "allocated"]) {
    const row = byId.get(workItems.get(key).work_item_id);
    assert.equal(
      row.sales_offer_id,
      catalogA.salesOffer.sales_offer_id,
      `${key} order snapshot was overwritten.`
    );
  }

  const mappingBeforeNoOp =
    await prisma.sales_channel_product_mappings.findUniqueOrThrow({
      where: {
        channel_external_vendor_item_id: {
          channel: "COUPANG",
          external_vendor_item_id: vendorItemId,
        },
      },
    });
  const rowTimestampsBeforeNoOp = new Map(
    changedRows.map((row) => [row.work_item_id, row.updated_at])
  );
  const auditCountBeforeNoOp = await prisma.employee_activity_logs.count();
  const noOp = await setCoupangProductMapping(
    {
      externalVendorItemId: vendorItemId,
      salesOfferId: catalogB.salesOffer.sales_offer_id,
    },
    user
  );
  assert.equal(noOp.mappingChanged, false);
  assert.equal(
    (
      await prisma.sales_channel_product_mappings.findUniqueOrThrow({
        where: { mapping_id: mappingBeforeNoOp.mapping_id },
      })
    ).updated_at.getTime(),
    mappingBeforeNoOp.updated_at.getTime(),
    "An identical mapping save changed the projection version timestamp."
  );
  for (const row of await prisma.order_matching_work_queue.findMany({
    where: { external_vendor_item_id: vendorItemId },
  })) {
    assert.equal(
      row.updated_at.getTime(),
      rowTimestampsBeforeNoOp.get(row.work_item_id)?.getTime()
    );
  }
  assert.equal(
    await prisma.employee_activity_logs.count(),
    auditCountBeforeNoOp + 1,
    "The operator's no-op save attempt was not audited."
  );

  await prisma.order_matching_work_queue.update({
    where: { work_item_id: allocatedItem.work_item_id },
    data: { canceled: 1, updated_at: changedAt },
  });
  const allocatedBeforeSync =
    await prisma.order_matching_work_queue.findUniqueOrThrow({
      where: { work_item_id: allocatedItem.work_item_id },
    });
  const syncOutcome = await prisma.$transaction((tx) =>
    synchronizeWorkItemMappingSnapshot({
      tx,
      workItemId: allocatedItem.work_item_id,
      snapshot: {
        mappingStatus: "MAPPED",
        salesOfferId: catalogB.salesOffer.sales_offer_id,
        mappingFailureReason: null,
        requiredModelLabel: catalogB.options.model.label,
        requiredStorageLabel: catalogB.options.storage.label,
        requiredColorLabel: catalogB.options.color.label,
        requiredWarrantyGroup:
          catalogB.options.warranty.option_key,
      },
      timestamp: changedAt,
    })
  );
  assert.equal(syncOutcome.outcome, "PROTECTED_BY_ACTIVE_ALLOCATION");
  assert.equal(
    (await prisma.order_matching_work_queue.findUniqueOrThrow({
      where: { work_item_id: allocatedItem.work_item_id },
    })).sales_offer_id,
    allocatedBeforeSync.sales_offer_id
  );
  assert.equal(
    (await prisma.order_matching_work_queue.findUniqueOrThrow({
      where: { work_item_id: allocatedItem.work_item_id },
    })).work_status,
    allocatedBeforeSync.work_status,
    "Sync changed work state even though an active allocation owned physical truth."
  );
  assert.equal(
    await prisma.$transaction((tx) =>
      expireOrderMatchingWorkItemIfEligible({
        tx,
        workItemId: allocatedItem.work_item_id,
        timestamp: changedAt,
      })
    ),
    false,
    "Expiry ignored an active physical allocation."
  );

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION quickhack_test_fail_mapping_set_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action_type = 'CHANNEL_ORDER_MAPPING_SET' THEN
        RAISE EXCEPTION 'forced mapping audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_mapping_set_audit
    BEFORE INSERT ON employee_activity_logs
    FOR EACH ROW EXECUTE FUNCTION quickhack_test_fail_mapping_set_audit()
  `);
  const mappingBeforeRollback =
    await prisma.sales_channel_product_mappings.findUniqueOrThrow({
      where: { mapping_id: mappingBeforeNoOp.mapping_id },
    });
  const rowsBeforeRollback = await prisma.order_matching_work_queue.findMany({
    where: { external_vendor_item_id: vendorItemId },
    orderBy: { work_item_id: "asc" },
  });
  await assert.rejects(() =>
    setCoupangProductMapping(
      { externalVendorItemId: vendorItemId, salesOfferId: null },
      user
    )
  );
  assert.deepEqual(
    await prisma.sales_channel_product_mappings.findUniqueOrThrow({
      where: { mapping_id: mappingBeforeNoOp.mapping_id },
    }),
    mappingBeforeRollback
  );
  assert.deepEqual(
    await prisma.order_matching_work_queue.findMany({
      where: { external_vendor_item_id: vendorItemId },
      orderBy: { work_item_id: "asc" },
    }),
    rowsBeforeRollback,
    "A failed audit left a partially applied order mapping."
  );
  await prisma.$executeRawUnsafe(
    "DROP TRIGGER fail_mapping_set_audit ON employee_activity_logs"
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION quickhack_test_fail_mapping_set_audit()"
  );

  await assert.rejects(
    () =>
      saveSalesOffer(
        {
          salesOfferId: catalogB.salesOffer.sales_offer_id,
          expectedRevision: catalogB.salesOffer.revision,
          isActive: false,
        },
        user
      ),
    (error) => error?.code === "SALES_OFFER_IN_USE"
  );

  const raceVendorItemId = "SNAPSHOT-VENDOR-RACE";
  await prisma.sales_channel_product_mappings.create({
    data: {
      channel: "COUPANG",
      external_vendor_item_id: raceVendorItemId,
      sales_offer_id: catalogA.salesOffer.sales_offer_id,
      mapping_status: "MAPPED",
      mapped_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const raceItem = await createWorkItem({
    externalOrderId: "SNAPSHOT-RACE-ORDER",
    externalShipmentId: "SNAPSHOT-RACE-SHIP",
    externalVendorItemId: raceVendorItemId,
    salesOfferId: catalogA.salesOffer.sales_offer_id,
    workStatus: "UNMATCHED",
    timestamp,
  });
  let hookCallCount = 0;
  const raceResult = await matchCoupangOrders(
    { workItemId: raceItem.work_item_id },
    null,
    matchingWorkerLease,
    {
      beforeCandidateAllocation: async () => {
        hookCallCount += 1;
        await setCoupangProductMapping(
          {
            externalVendorItemId: raceVendorItemId,
            salesOfferId: catalogB.salesOffer.sales_offer_id,
          },
          user
        );
      },
    }
  );
  assert.equal(hookCallCount, 1);
  assert.equal(raceResult.items[0].deferred, true);
  assert.equal(raceResult.items[0].matchedNow, 0);
  assert.equal(
    await prisma.match_worker_allocation.count({
      where: {
        external_order_id: raceItem.external_order_id,
        external_shipment_id: raceItem.external_shipment_id,
      },
    }),
    0,
    "The worker allocated inventory using a stale sales offer snapshot."
  );
  const raceRow = await prisma.order_matching_work_queue.findUniqueOrThrow({
    where: { work_item_id: raceItem.work_item_id },
  });
  assert.equal(raceRow.sales_offer_id, catalogB.salesOffer.sales_offer_id);
  assert.equal(raceRow.work_status, "UNMATCHED");

  const deactivatedHistorical = await saveSalesOffer(
    {
      salesOfferId: catalogA.salesOffer.sales_offer_id,
      expectedRevision: catalogA.salesOffer.revision,
      isActive: false,
    },
    user
  );
  assert.equal(deactivatedHistorical.isActive, false);
  assert(
    await getSalesOfferSnapshotDefinition(
      prisma,
      catalogA.salesOffer.sales_offer_id
    ),
    "A historical order could not resolve its inactive sales offer."
  );
  const historicalCandidates = await findInventoryCandidatesForSalesOffer(
    catalogA.salesOffer.sales_offer_id,
    { allowInactiveOffer: true }
  );
  assert(historicalCandidates.offer);

  const productMappingSource = await readFile(
    path.join(
      projectRoot,
      "quickhack_server/sales-channel/coupang/product-mapping-service.ts"
    ),
    "utf8"
  );
  const mappingClientSource = await readFile(
    path.join(
      projectRoot,
      "quickhack_client/api/sales-channel/coupang-product-mappings.ts"
    ),
    "utf8"
  );
  const mappingViewSource = await readFile(
    path.join(
      projectRoot,
      "quickhack_client/components/sales-channel/channel-order-matching-manager-view.tsx"
    ),
    "utf8"
  );
  const mappingRouteSource = await readFile(
    path.join(
      projectRoot,
      "quickhack_server/api/sales-channel/coupang/product-mappings.ts"
    ),
    "utf8"
  );
  assert(!productMappingSource.includes("reapplyCoupangProductMappings"));
  assert(!mappingClientSource.includes('action: "reapply"'));
  assert(!mappingViewSource.includes("기존 주문 매핑 재적용"));
  assert(mappingClientSource.includes('action: "set"'));
  assert(mappingViewSource.includes('action: "set"'));
  assert(mappingRouteSource.includes('body.action !== "set"'));

  console.log("Order mapping snapshot integrity and race guards verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
