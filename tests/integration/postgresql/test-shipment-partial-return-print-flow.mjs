import {
  createInventoryCatalogFixture,
  createSellableDeviceFixtures,
} from "../../support/inventory-business-fixtures.mjs";
import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-shipment-partial-return-print-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

async function createPrintFixture(ledgerApi, writeRules) {
  const timestamp = new Date("2026-07-19T14:00:00.000Z");
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "partial-return-print",
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalog,
    { count: 3, timestamp }
  );
  const externalOrderId = "ORDER-PARTIAL-RETURN-1";
  const externalShipmentId = "SHIP-PARTIAL-RETURN-1";
  const externalVendorItemId = "VENDOR-PARTIAL-RETURN-1";

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
  await prisma.order_matching_work_queue.create({
    data: {
      channel: "COUPANG",
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_vendor_item_id: externalVendorItemId,
      vendor_item_name: externalVendorItemId,
      ordered_quantity: devices.length,
      matchable_quantity: devices.length,
      mapping_status: "MAPPED",
      sales_offer_id: catalog.salesOffer.sales_offer_id,
      required_model_label: catalog.options.model.label,
      required_storage_label: catalog.options.storage.label,
      required_color_label: catalog.options.color.label,
      required_warranty_group: "2Y",
      work_status: "MATCHED",
      matched_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  const allocations = [];

  for (const device of devices) {
    await prisma.$transaction((tx) =>
      ledgerApi.transitionInventoryStatusWithLedger(tx, {
        pgNo: device.pgNo,
        expectedFromStatus: "SELLABLE",
        toStatus: "RESERVED",
        transitionPolicy: writeRules.INVENTORY_TRANSITION_POLICY.orderMatchingReservation,
        operationKey: `integration-reserve:${device.pgNo}`,
        movementType: ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "INTEGRATION_TEST",
        sourceId: externalShipmentId,
        occurredAt: timestamp,
      })
    );
    allocations.push(
      await prisma.match_worker_allocation.create({
        data: {
          external_order_id: externalOrderId,
          external_shipment_id: externalShipmentId,
          external_vendor_item_id: externalVendorItemId,
          pg_no: device.pgNo,
          sales_offer_id: catalog.salesOffer.sales_offer_id,
          inventory_sku_id: catalog.sku.inventory_sku_id,
          required_model: catalog.options.model.label,
          required_storage: catalog.options.storage.label,
          required_color: catalog.options.color.label,
          required_warranty_group: "2Y",
          inventory_status_before_allocation: "SELLABLE",
          allocation_status: "API_ACKED",
          allocated_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        },
      })
    );
  }

  return {
    timestamp,
    catalog,
    devices,
    allocations,
    externalOrderId,
    externalShipmentId,
    externalVendorItemId,
  };
}

async function createActiveReturn(fixture) {
  const returnRaw = await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: "RETURN-PARTIAL-1",
      external_order_id: fixture.externalOrderId,
      external_shipment_id: fixture.externalShipmentId,
      cancel_type: "RETURN",
      return_receipt_status: "RU",
      return_release_status: "N",
      cancel_count: 1,
      projection_revision: 1,
      synced_at: fixture.timestamp,
      created_at: fixture.timestamp,
      updated_at: fixture.timestamp,
    },
  });
  await prisma.coupang_return_raw_item.create({
    data: {
      coupang_return_raw_id: returnRaw.coupang_return_raw_id,
      external_receipt_id: returnRaw.external_receipt_id,
      external_order_id: fixture.externalOrderId,
      external_shipment_id: fixture.externalShipmentId,
      external_vendor_item_id: fixture.externalVendorItemId,
      vendor_item_name: fixture.externalVendorItemId,
      cancel_count: 1,
      created_at: fixture.timestamp,
      updated_at: fixture.timestamp,
    },
  });

  return returnRaw;
}

async function completeOneReturn(fixture, returnRaw, ledgerApi, writeRules) {
  const selected = fixture.allocations[0];
  const completedAt = new Date("2026-07-19T14:10:00.000Z");

  await prisma.$transaction(async (tx) => {
    await ledgerApi.transitionInventoryStatusWithLedger(tx, {
      pgNo: selected.pg_no,
      expectedFromStatus: "RESERVED",
      toStatus: "SELLABLE",
      transitionPolicy: writeRules.INVENTORY_TRANSITION_POLICY.preShipmentReturn,
      operationKey: `integration-return:${selected.allocation_id}`,
      movementType: ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "INTEGRATION_TEST_RETURN",
      sourceId: returnRaw.external_receipt_id,
      occurredAt: completedAt,
    });
    await tx.match_worker_allocation.update({
      where: { allocation_id: selected.allocation_id },
      data: {
        allocation_status: "CANCELED",
        released_at: completedAt,
        updated_at: completedAt,
      },
    });
    await tx.coupang_return_allocation.create({
      data: {
        coupang_return_raw_id: returnRaw.coupang_return_raw_id,
        allocation_id: selected.allocation_id,
        external_receipt_id: returnRaw.external_receipt_id,
        external_order_id: fixture.externalOrderId,
        external_shipment_id: fixture.externalShipmentId,
        external_vendor_item_id: fixture.externalVendorItemId,
        pg_no: selected.pg_no,
        action_type: "stopShipment",
        linked_at: completedAt,
        created_at: completedAt,
        updated_at: completedAt,
      },
    });
    await tx.coupang_return_raw.update({
      where: { coupang_return_raw_id: returnRaw.coupang_return_raw_id },
      data: {
        return_receipt_status: "RETURNS_COMPLETED",
        return_release_status: "Y",
        synced_at: completedAt,
        updated_at: completedAt,
      },
    });
  });

  return selected;
}

async function assertPartialReturnPrintFlow(
  shipmentApi,
  returnApi,
  conflictApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createPrintFixture(ledgerApi, writeRules);
  const allocationIds = fixture.allocations.map(
    (allocation) => allocation.allocation_id
  );
  const printResult = await shipmentApi.recordShipmentListPrint({
    allocationIds,
    tabKey: "coupang-2y",
  });

  assert(printResult.printedCount === 3, "The print snapshot did not include all PGs.");
  const returnRaw = await createActiveReturn(fixture);

  let selectionError;
  try {
    await returnApi.processCoupangPreShipmentReturnAction({
      returnRawId: returnRaw.coupang_return_raw_id,
      action: "stopShipment",
      allocationIds: allocationIds.slice(0, 2),
      expectedProjectionRevision: returnRaw.projection_revision,
    });
  } catch (error) {
    selectionError = error;
  }

  assert(selectionError instanceof Error, "Excess PG selection was not rejected.");
  assert(
    selectionError.message.includes("1"),
    `The partial-return selection error did not identify the required count: ${selectionError.message}`
  );
  assert(
    (await prisma.sales_channel_write_requests.count()) === 0,
    "Invalid partial-return selection reached the write gateway."
  );

  let conflictError;
  try {
    await shipmentApi.confirmShipmentListPrintBatch({
      batchId: printResult.batchId,
    });
  } catch (error) {
    conflictError = error;
  }

  assert(
    conflictApi.isShipmentReturnConflictError(conflictError),
    "An active partial return did not block print confirmation."
  );
  assert(
    conflictError.conflicts.length === 1 &&
      conflictError.conflicts[0].allocationIds.length === 3,
    "The active return did not block the exact item candidate PGs."
  );

  const blockedBatch =
    await prisma.sales_channel_shipment_list_print_batches.findUniqueOrThrow({
      where: { shipment_list_print_batch_id: printResult.batchId },
    });
  assert(blockedBatch.batch_status === "PENDING", "A blocked batch changed status.");
  assert(
    (await prisma.inventory.count({
      where: {
        pg_no: { in: fixture.devices.map((device) => device.pgNo) },
        inventory_status: "RESERVED",
      },
    })) === 3,
    "A blocked print confirmation changed inventory."
  );

  const returnedAllocation = await completeOneReturn(
    fixture,
    returnRaw,
    ledgerApi,
    writeRules
  );
  const confirmed = await shipmentApi.confirmShipmentListPrintBatch({
    batchId: printResult.batchId,
  });

  assert(confirmed.batchStatus === "CONFIRMED", "The resolved batch was not confirmed.");
  assert(confirmed.itemCount === 3, "The immutable print snapshot item count changed.");
  assert(confirmed.returnExcludedCount === 1, "The returned PG was not excluded.");
  assert(confirmed.effectiveItemCount === 2, "The effective print count is incorrect.");

  const [allocations, inventories, balances, batchItems] = await Promise.all([
    prisma.match_worker_allocation.findMany({
      where: { allocation_id: { in: allocationIds } },
      orderBy: { allocation_id: "asc" },
    }),
    prisma.inventory.findMany({
      where: { pg_no: { in: fixture.devices.map((device) => device.pgNo) } },
      orderBy: { pg_no: "asc" },
    }),
    prisma.inventory_quantity_balances.findMany({
      where: { inventory_sku_id: fixture.catalog.sku.inventory_sku_id },
    }),
    prisma.sales_channel_shipment_list_print_batch_items.findMany({
      where: { shipment_list_print_batch_id: printResult.batchId },
    }),
  ]);
  const returned = allocations.find(
    (allocation) => allocation.allocation_id === returnedAllocation.allocation_id
  );
  const shippable = allocations.filter(
    (allocation) => allocation.allocation_id !== returnedAllocation.allocation_id
  );
  const inventoryByPg = new Map(
    inventories.map((inventory) => [inventory.pg_no, inventory.inventory_status])
  );
  const quantityByStatus = new Map(
    balances.map((balance) => [balance.inventory_status, balance.quantity])
  );

  assert(returned?.allocation_status === "CANCELED", "Returned allocation changed again.");
  assert(
    returned?.shipment_list_print_batch_id === null,
    "Returned allocation was attached to the confirmed shipment batch."
  );
  assert(
    inventoryByPg.get(returnedAllocation.pg_no) === "SELLABLE",
    "Returned inventory did not remain SELLABLE."
  );
  assert(
    shippable.every(
      (allocation) =>
        allocation.allocation_status === "SHIPMENT_LIST_PRINTED" &&
        allocation.shipment_list_print_batch_id === printResult.batchId &&
        inventoryByPg.get(allocation.pg_no) === "PACKING"
    ),
    "Non-returned allocations did not move to the confirmed packing state."
  );
  assert(batchItems.length === 3, "The print snapshot removed the returned PG history.");
  assert(quantityByStatus.get("SELLABLE") === 1, "SELLABLE balance is incorrect.");
  assert(quantityByStatus.get("RESERVED") === 0, "RESERVED balance is incorrect.");
  assert(quantityByStatus.get("PACKING") === 2, "PACKING balance is incorrect.");

  const movementCountBeforeRepeat = await prisma.inventory_quantity_movements.count();
  const repeated = await shipmentApi.confirmShipmentListPrintBatch({
    batchId: printResult.batchId,
  });
  assert(repeated.batchStatus === "CONFIRMED", "Repeated confirmation changed outcome.");
  assert(
    (await prisma.inventory_quantity_movements.count()) === movementCountBeforeRepeat,
    "Repeated confirmation duplicated quantity-ledger movements."
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const shipmentApi = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );
  const returnApi = await import(
    "@/quickhack_server/returns/return-action-service"
  );
  const conflictApi = await import(
    "@/quickhack_server/returns/shipment-return-conflict-service"
  );
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const writeRules = await import(
    "@/quickhack_shared/inventory/inventory-write-rules"
  );

  await assertPartialReturnPrintFlow(
    shipmentApi,
    returnApi,
    conflictApi,
    ledgerApi,
    writeRules
  );
  console.log("Partial return selection and shipment print conflict flow verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
