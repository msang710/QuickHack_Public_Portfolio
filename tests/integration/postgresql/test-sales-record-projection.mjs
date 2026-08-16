import {
  createInventoryCatalogFixture,
  createSellableDeviceFixtures,
} from "../../support/inventory-business-fixtures.mjs";
import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { digestDomainOperation } from "@/quickhack_server/core/database/aggregate-command";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-sales-record-projection-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
let fixtureSequence = 0;

function at(value) {
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

function sameInstant(left, right) {
  return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
}

function fixtureTimestamp(minutes = 0) {
  return at(`2026-07-25 09:${String(minutes).padStart(2, "0")}:00`);
}

async function transitionToReserved(ledgerApi, writeRules, input) {
  await prisma.$transaction((tx) =>
    ledgerApi.transitionInventoryStatusWithLedger(tx, {
      pgNo: input.pgNo,
      expectedFromStatus: "SELLABLE",
      toStatus: "RESERVED",
      transitionPolicy:
        writeRules.INVENTORY_TRANSITION_POLICY.orderMatchingReservation,
      operationKey: `${input.prefix}:reserve:${input.pgNo}`,
      movementType:
        ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "SALES_RECORD_TEST",
      sourceId: input.externalShipmentId,
      occurredAt: input.timestamp,
    })
  );
}

async function createAllocationSet(ledgerApi, writeRules, input) {
  fixtureSequence += 1;
  const prefix = `sales-record-${fixtureSequence}-${input.name}`;
  const timestamp = fixtureTimestamp(fixtureSequence);
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix,
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalog,
    { count: input.count, timestamp }
  );
  const allocations = [];
  const latestInboundIds = [];

  for (const [index, device] of devices.entries()) {
    const externalOrderId = `${prefix}-ORDER-${index + 1}`;
    const externalShipmentId = `${prefix}-SHIPMENT-${index + 1}`;
    const externalVendorItemId = `${prefix}-ITEM-${index + 1}`;
    const salesPrice =
      input.salesPrices && index in input.salesPrices
        ? input.salesPrices[index]
        : 500000 + index * 10000;
    const purchasePrice =
      input.purchasePrices && index in input.purchasePrices
        ? input.purchasePrices[index]
        : 300000 + index * 10000;

    await prisma.inbounds.create({
      data: {
        pg_no: device.pgNo,
        purchase_price: 100000 + index,
        inbound_status: "PURCHASED",
        received_at: timestamp,
        price_agreed_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    const latestInbound = await prisma.inbounds.create({
      data: {
        pg_no: device.pgNo,
        supplier_name: `${prefix}-supplier-${index + 1}`,
        purchase_price: purchasePrice,
        inbound_status: "PURCHASED",
        received_at: timestamp,
        price_agreed_at: purchasePrice === null ? null : timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    latestInboundIds.push(latestInbound.inbound_id);

    await prisma.coupang_order_raw.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_order_status: "INSTRUCT",
        ordered_at: timestamp,
        receiver_name: `${prefix}-receiver`,
        receiver_safe_number: "05070001234",
        receiver_post_code: "12345",
        receiver_address_1: `${prefix}-shared-address`,
        receiver_address_2: "101",
        synced_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await transitionToReserved(ledgerApi, writeRules, {
      pgNo: device.pgNo,
      prefix,
      externalShipmentId,
      timestamp,
    });
    const allocation = await prisma.match_worker_allocation.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_vendor_item_id: externalVendorItemId,
        vendor_item_name: `${prefix}-phone-${index + 1}`,
        pg_no: device.pgNo,
        sales_offer_id: catalog.salesOffer.sales_offer_id,
        inventory_sku_id: catalog.sku.inventory_sku_id,
        required_model: catalog.options.model.label,
        required_storage: catalog.options.storage.label,
        required_color: catalog.options.color.label,
        required_warranty_group:
          input.warrantyGroups?.[index] ?? "2Y",
        inventory_status_before_allocation: "SELLABLE",
        allocation_status: "API_ACKED",
        allocated_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    allocations.push(allocation);
    await prisma.order_matching_work_queue.create({
      data: {
        channel: "COUPANG",
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_vendor_item_id: externalVendorItemId,
        vendor_item_name: `${prefix}-phone-${index + 1}`,
        sales_price: salesPrice,
        ordered_quantity: 1,
        matchable_quantity: 1,
        mapping_status: "MAPPED",
        sales_offer_id: catalog.salesOffer.sales_offer_id,
        work_status: "MATCHED",
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  }

  return {
    prefix,
    timestamp,
    catalog,
    devices,
    allocations,
    latestInboundIds,
  };
}

async function createDeliveryGroup(
  shipmentApi,
  ledgerApi,
  writeRules,
  input
) {
  const fixture = await createAllocationSet(ledgerApi, writeRules, input);
  const printed = await shipmentApi.recordShipmentListPrint({
    allocationIds: fixture.allocations.map(
      (allocation) => allocation.allocation_id
    ),
    tabKey: "coupang-2y",
  });
  await shipmentApi.confirmShipmentListPrintBatch({
    batchId: printed.batchId,
  });

  for (const allocation of fixture.allocations) {
    await prisma.$transaction((tx) =>
      ledgerApi.transitionInventoryStatusWithLedger(tx, {
        pgNo: allocation.pg_no,
        expectedFromStatus: "PACKING",
        toStatus: "PACKED",
        transitionPolicy:
          writeRules.INVENTORY_TRANSITION_POLICY.packingValidation,
        operationKey: `${fixture.prefix}:packed:${allocation.pg_no}`,
        movementType:
          ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "SALES_RECORD_TEST_PACKING",
        sourceId: String(printed.batchId),
        occurredAt: fixture.timestamp,
      })
    );
  }

  const printItems =
    await prisma.sales_channel_shipment_list_print_batch_items.findMany({
      where: { shipment_list_print_batch_id: printed.batchId },
      orderBy: { print_line_no: "asc" },
    });
  const packageGroupIds = Array.from(
    new Set(printItems.map((item) => item.package_group_id).filter(Boolean))
  );
  assert(
    packageGroupIds.length === 1,
    `${fixture.prefix} fixture was not grouped into one physical parcel.`
  );
  const packageGroupId = packageGroupIds[0];

  for (const allocationIndex of input.removedAllocationIndexes ?? []) {
    await prisma.shipment_package_group_members.update({
      where: {
        package_group_id_allocation_id: {
          package_group_id: packageGroupId,
          allocation_id:
            fixture.allocations[allocationIndex].allocation_id,
        },
      },
      data: { removed_at: fixture.timestamp },
    });
  }

  const carrierShipment = await prisma.carrier_shipments.create({
    data: {
      carrier_code: "LOGEN",
      source_type: "SELF_PRINT",
      channel: "COUPANG",
      package_group_id: packageGroupId,
      tracking_number: `${95000000000 + fixtureSequence}`,
      invoice_status: "REGISTERED",
      shipment_status: "REGISTERED",
      allocated_at: fixture.timestamp,
      carrier_registered_at: fixture.timestamp,
      created_at: fixture.timestamp,
      updated_at: fixture.timestamp,
    },
  });
  await prisma.shipment_package_groups.update({
    where: { package_group_id: packageGroupId },
    data: {
      group_status: "READY",
      current_carrier_shipment_id: carrierShipment.carrier_shipment_id,
      updated_at: fixture.timestamp,
    },
  });

  return {
    ...fixture,
    packageGroupId,
    carrierShipmentId: carrierShipment.carrier_shipment_id,
  };
}

async function projectDelivery(deliveryApi, fixture, input = {}) {
  return prisma.$transaction((tx) =>
    deliveryApi.projectPackageGroupDeliveryStatus(tx, {
      packageGroupId: fixture.packageGroupId,
      carrierShipmentId: fixture.carrierShipmentId,
      carrierStatus: input.carrierStatus ?? "DELIVERED",
      evidenceSource: input.evidenceSource ?? "LOGEN",
      evidenceKey:
        input.evidenceKey ??
        `${fixture.prefix}:${input.carrierStatus ?? "DELIVERED"}:${
          input.occurredAt ?? "default"
        }`,
      rawStatusName: input.rawStatusName ?? null,
      occurredAt: input.occurredAt ?? at("2026-07-25 12:00:00"),
    })
  );
}

async function createApprovedReturnLink(allocation, receiptId, timestamp) {
  const returnRow = await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: receiptId,
      external_order_id: allocation.external_order_id,
      external_shipment_id: allocation.external_shipment_id,
      cancel_type: "RETURN",
      return_receipt_status: "VENDOR_WAREHOUSE_CONFIRM",
      cancel_count: 1,
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.coupang_return_allocation.create({
    data: {
      coupang_return_raw_id: returnRow.coupang_return_raw_id,
      allocation_id: allocation.allocation_id,
      external_receipt_id: receiptId,
      external_order_id: allocation.external_order_id,
      external_shipment_id: allocation.external_shipment_id,
      external_vendor_item_id: allocation.external_vendor_item_id,
      pg_no: allocation.pg_no,
      action_type: "approve",
      linked_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
}

async function finalizeReturnAction(returnFinalizerApi, allocation, input) {
  const expectedBeforeStatus =
    input.expectedBeforeStatus ??
    (input.requestType === "RETURN_STOPPED_SHIPMENT"
      ? "N"
      : input.requestType === "RETURN_RECEIVE_CONFIRMATION"
        ? "RETURNS_UNCHECKED"
        : "VENDOR_WAREHOUSE_CONFIRM");
  const returnRow = await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: input.receiptId,
      external_order_id: allocation.external_order_id,
      external_shipment_id: allocation.external_shipment_id,
      cancel_type: "RETURN",
      return_receipt_status:
        input.requestType === "RETURN_STOPPED_SHIPMENT"
          ? "RELEASE_STOP_UNCHECKED"
          : expectedBeforeStatus,
      return_release_status:
        input.requestType === "RETURN_STOPPED_SHIPMENT"
          ? expectedBeforeStatus
          : null,
      cancel_count: 1,
      synced_at: input.finalizedAt,
      created_at: input.finalizedAt,
      updated_at: input.finalizedAt,
    },
  });
  await prisma.coupang_return_raw_item.create({
    data: {
      coupang_return_raw_id: returnRow.coupang_return_raw_id,
      external_receipt_id: returnRow.external_receipt_id,
      external_order_id: returnRow.external_order_id,
      external_shipment_id: allocation.external_shipment_id,
      external_vendor_item_id: allocation.external_vendor_item_id,
      vendor_item_name: allocation.external_vendor_item_id,
      cancel_count: 1,
      created_at: input.finalizedAt,
      updated_at: input.finalizedAt,
    },
  });
  const sourceSnapshotDigest = digestDomainOperation({
    receiptId: returnRow.external_receipt_id,
    projectionRevision: returnRow.projection_revision,
    receiptStatus: returnRow.return_receipt_status,
    releaseStatus: returnRow.return_release_status,
    itemRequirements: [
      {
        shipmentId: allocation.external_shipment_id,
        vendorItemId: allocation.external_vendor_item_id,
        requiredQuantity: 1,
        selectedAllocationIds: [allocation.allocation_id],
      },
    ],
  });
  const request = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: input.requestType,
      request_status: "COMPLETED",
      target_type: "COUPANG_RETURN_RECEIPT",
      target_external_id: input.receiptId,
      idempotency_key: `${input.requestType}:${input.receiptId}`,
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: `/returns/${input.receiptId}`,
      cancel_count: 1,
      expected_before_status: expectedBeforeStatus,
      requested_after_status: input.requestedAfterStatus,
      source_projection_revision: returnRow.projection_revision,
      source_snapshot_digest: sourceSnapshotDigest,
      requested_at: input.finalizedAt,
      completed_at: input.finalizedAt,
      local_finalized_at: input.finalizedAt,
      created_at: input.finalizedAt,
      updated_at: input.finalizedAt,
    },
  });
  await prisma.sales_channel_write_request_targets.createMany({
    data: [
      {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
        target_position: 0,
        target_type: "MATCH_WORKER_ALLOCATION",
        target_external_id: String(allocation.allocation_id),
        allocation_id: allocation.allocation_id,
        pg_no: allocation.pg_no,
        external_order_id: allocation.external_order_id,
        external_shipment_id: allocation.external_shipment_id,
        external_vendor_item_id: allocation.external_vendor_item_id,
        expected_before_status: expectedBeforeStatus,
        requested_after_status: input.requestedAfterStatus,
        external_result_status: "SUCCEEDED",
        local_finalization_status: "PENDING",
        inspection_result: input.inspectionResult ?? null,
        inspection_note: input.inspectionResult
          ? "sales record projection test"
          : null,
        created_at: input.finalizedAt,
      },
      ...(input.additionalTargetExternalIds ?? []).map(
        (targetExternalId, index) => ({
          sales_channel_write_request_id:
            request.sales_channel_write_request_id,
          target_position: index + 1,
          target_type: "SUPPLY_CONSUMPTION_EVENT",
          target_external_id: targetExternalId,
          external_order_id: allocation.external_order_id,
          external_shipment_id: allocation.external_shipment_id,
          expected_before_status: expectedBeforeStatus,
          requested_after_status: input.requestedAfterStatus,
          external_result_status: "SUCCEEDED",
          local_finalization_status: "PENDING",
          created_at: input.finalizedAt,
        })
      ),
    ],
  });
  const targetIds = (
    await prisma.sales_channel_write_request_targets.findMany({
      where: {
        sales_channel_write_request_id: request.sales_channel_write_request_id,
      },
      orderBy: { target_position: "asc" },
      select: { sales_channel_write_request_target_id: true },
    })
  ).map((target) => target.sales_channel_write_request_target_id);

  if (input.assertSubsetRejected) {
    let subsetError = null;
    try {
      await prisma.$transaction((tx) =>
        returnFinalizerApi.finalizePersistedCoupangReturnWrite({
          tx,
          requestId: request.sales_channel_write_request_id,
          targetIds: targetIds.slice(0, 1),
          actorUserId: null,
          finalizedAt: input.finalizedAt,
        })
      );
    } catch (error) {
      subsetError = error;
    }
    const unchangedReturn =
      await prisma.coupang_return_raw.findUniqueOrThrow({
        where: { coupang_return_raw_id: returnRow.coupang_return_raw_id },
      });
    assert(
      subsetError instanceof Error &&
        unchangedReturn.return_receipt_status ===
          returnRow.return_receipt_status &&
        unchangedReturn.projection_revision === returnRow.projection_revision,
      "A partial return target group changed local state before rejection."
    );
  }

  if (input.advanceProjectionBeforeFinalize) {
    await prisma.coupang_return_raw.update({
      where: { coupang_return_raw_id: returnRow.coupang_return_raw_id },
      data: {
        projection_revision: { increment: 1 },
        reason_label: "benign concurrent read projection",
        updated_at: new Date(input.finalizedAt.getTime() - 1_000),
      },
    });
  }

  await prisma.$transaction((tx) =>
    returnFinalizerApi.finalizePersistedCoupangReturnWrite({
      tx,
      requestId: request.sales_channel_write_request_id,
      targetIds,
      actorUserId: null,
      finalizedAt: input.finalizedAt,
    })
  );

  return { request, returnRow, targetIds };
}

function salesProjectionSource(fixture, allocationIndex) {
  const allocation = fixture.allocations[allocationIndex];

  return {
    allocationId: allocation.allocation_id,
    pgNo: allocation.pg_no,
    salesOfferId: allocation.sales_offer_id,
    inventorySkuId: allocation.inventory_sku_id,
    externalOrderId: allocation.external_order_id,
    externalShipmentId: allocation.external_shipment_id,
    externalVendorItemId: allocation.external_vendor_item_id,
    latestPurchasePrice: null,
    purchaseInboundId: fixture.latestInboundIds[allocationIndex],
    supplierName: `${fixture.prefix}-supplier-${allocationIndex + 1}`,
    purchaseAgreedAt: fixture.timestamp,
    model: fixture.catalog.options.model.label,
    storage: fixture.catalog.options.storage.label,
    color: fixture.catalog.options.color.label,
    saleGrade: fixture.catalog.options.grade.option_key,
    warrantyGroup: allocation.required_warranty_group,
    hasApprovedReturn: false,
  };
}

async function assertDeliveredProjection(
  shipmentApi,
  deliveryApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createDeliveryGroup(
    shipmentApi,
    ledgerApi,
    writeRules,
    {
      name: "delivered",
      count: 3,
      salesPrices: [510000, null, 530000],
      purchasePrices: [310000, null, 330000],
      warrantyGroups: ["1Y", "2Y", "2Y"],
      removedAllocationIndexes: [2],
    }
  );
  const firstProjection = await projectDelivery(deliveryApi, fixture, {
    evidenceSource: "LOGEN",
    evidenceKey: "logen-first-delivery",
    occurredAt: at("2026-07-25 12:00:00"),
  });

  assert(
    firstProjection.completed && firstProjection.transitionedCount === 2,
    "Delivered evidence did not complete each active package member."
  );
  const initialRows = await prisma.sales_records.findMany({
    where: {
      allocation_id: {
        in: fixture.allocations.map(
          (allocation) => allocation.allocation_id
        ),
      },
    },
    orderBy: { allocation_id: "asc" },
  });
  assert(
    initialRows.length === 2,
    "Delivered evidence did not create one sale record per active member."
  );
  assert(
    !initialRows.some(
      (row) =>
        row.allocation_id === fixture.allocations[2].allocation_id
    ),
    "A removed package member was projected into the sales ledger."
  );
  const firstRow = initialRows.find(
    (row) => row.allocation_id === fixture.allocations[0].allocation_id
  );
  const nullPriceRow = initialRows.find(
    (row) => row.allocation_id === fixture.allocations[1].allocation_id
  );
  assert(
    firstRow?.sales_price === 510000 &&
      firstRow.purchase_price === 310000 &&
      firstRow.purchase_inbound_id === fixture.latestInboundIds[0] &&
      firstRow.supplier_name === `${fixture.prefix}-supplier-1` &&
      sameInstant(firstRow.purchase_agreed_at, fixture.timestamp) &&
      firstRow.model === fixture.catalog.options.model.label &&
      firstRow.storage === fixture.catalog.options.storage.label &&
      firstRow.color === fixture.catalog.options.color.label &&
      firstRow.sale_grade === fixture.catalog.options.grade.option_key &&
      firstRow.warranty_group === "1Y",
    "The delivered sale snapshot did not preserve its exact source values."
  );
  assert(
    nullPriceRow?.sales_price === null &&
      nullPriceRow.purchase_price === null &&
      nullPriceRow.purchase_inbound_id === fixture.latestInboundIds[1] &&
      nullPriceRow.supplier_name === `${fixture.prefix}-supplier-2` &&
      nullPriceRow.purchase_agreed_at === null,
    "Missing prices were not preserved as null."
  );

  await prisma.order_matching_work_queue.update({
    where: {
      channel_external_order_id_external_shipment_id_external_vendor_item_id: {
        channel: "COUPANG",
        external_order_id: fixture.allocations[0].external_order_id,
        external_shipment_id:
          fixture.allocations[0].external_shipment_id,
        external_vendor_item_id:
          fixture.allocations[0].external_vendor_item_id,
      },
    },
    data: { sales_price: 999999 },
  });
  await prisma.inbounds.update({
    where: { inbound_id: fixture.latestInboundIds[0] },
    data: {
      purchase_price: 888888,
      supplier_name: `${fixture.prefix}-changed-supplier`,
      price_agreed_at: at("2026-07-25 12:05:00"),
    },
  });
  await prisma.order_matching_work_queue.update({
    where: {
      channel_external_order_id_external_shipment_id_external_vendor_item_id: {
        channel: "COUPANG",
        external_order_id: fixture.allocations[1].external_order_id,
        external_shipment_id:
          fixture.allocations[1].external_shipment_id,
        external_vendor_item_id:
          fixture.allocations[1].external_vendor_item_id,
      },
    },
    data: { sales_price: 520000 },
  });
  await prisma.inbounds.update({
    where: { inbound_id: fixture.latestInboundIds[1] },
    data: {
      purchase_price: 320000,
      price_agreed_at: at("2026-07-25 12:10:00"),
    },
  });

  await projectDelivery(deliveryApi, fixture, {
    evidenceSource: "COUPANG",
    evidenceKey: "coupang-duplicate-delivery",
    occurredAt: at("2026-07-25 13:00:00"),
  });
  let retriedRows = await prisma.sales_records.findMany({
    where: {
      allocation_id: {
        in: fixture.allocations.map(
          (allocation) => allocation.allocation_id
        ),
      },
    },
    orderBy: { allocation_id: "asc" },
  });
  const preservedRow = retriedRows.find(
    (row) => row.allocation_id === fixture.allocations[0].allocation_id
  );
  const filledRow = retriedRows.find(
    (row) => row.allocation_id === fixture.allocations[1].allocation_id
  );
  assert(
    retriedRows.length === 2 &&
      preservedRow?.sales_price === 510000 &&
      preservedRow.purchase_price === 310000 &&
      preservedRow.purchase_inbound_id === fixture.latestInboundIds[0] &&
      preservedRow.supplier_name === `${fixture.prefix}-supplier-1` &&
      sameInstant(preservedRow.purchase_agreed_at, fixture.timestamp) &&
      preservedRow.color === fixture.catalog.options.color.label,
    "A duplicate source observation overwrote a non-null sale snapshot."
  );
  assert(
    filledRow?.sales_price === 520000 &&
      filledRow.purchase_price === 320000 &&
      filledRow.purchase_inbound_id === fixture.latestInboundIds[1] &&
      filledRow.supplier_name === `${fixture.prefix}-supplier-2` &&
      sameInstant(filledRow.purchase_agreed_at, at("2026-07-25 12:10:00")),
    "A later observation did not fill previously null prices."
  );

  await projectDelivery(deliveryApi, fixture, {
    evidenceSource: "LOGEN",
    evidenceKey: "logen-earlier-delivery",
    occurredAt: at("2026-07-25 11:30:00"),
  });
  await prisma.sales_records.update({
    where: {
      allocation_id: fixture.allocations[1].allocation_id,
    },
    data: {
      sale_status: "RETURNED",
      updated_at: at("2026-07-25 14:00:00"),
    },
  });
  await projectDelivery(deliveryApi, fixture, {
    evidenceSource: "COUPANG",
    evidenceKey: "coupang-after-return",
    occurredAt: at("2026-07-25 14:30:00"),
  });
  retriedRows = await prisma.sales_records.findMany({
    where: {
      allocation_id: {
        in: fixture.allocations.map(
          (allocation) => allocation.allocation_id
        ),
      },
    },
    orderBy: { allocation_id: "asc" },
  });
  assert(
    retriedRows.length === 2 &&
      retriedRows.every(
        (row) => sameInstant(row.sold_at, at("2026-07-25 11:30:00"))
      ) &&
      retriedRows.find(
        (row) =>
          row.allocation_id === fixture.allocations[1].allocation_id
      )?.sale_status === "RETURNED",
    "Retry did not preserve the earliest soldAt or RETURNED state."
  );

  return fixture;
}

async function assertNonDeliveredDoesNotCreateSales(
  shipmentApi,
  deliveryApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createDeliveryGroup(
    shipmentApi,
    ledgerApi,
    writeRules,
    {
      name: "not-delivered",
      count: 1,
    }
  );

  await projectDelivery(deliveryApi, fixture, {
    carrierStatus: "IN_TRANSIT",
    evidenceKey: "in-transit",
    occurredAt: at("2026-07-25 12:00:00"),
  });
  await projectDelivery(deliveryApi, fixture, {
    carrierStatus: "EXCEPTION",
    evidenceKey: "exception",
    occurredAt: at("2026-07-25 12:10:00"),
  });
  assert(
    (await prisma.sales_records.count({
      where: {
        allocation_id: fixture.allocations[0].allocation_id,
      },
    })) === 0,
    "A non-delivered carrier status created a sale record."
  );
}

async function assertProjectionRollback(
  shipmentApi,
  deliveryApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createDeliveryGroup(
    shipmentApi,
    ledgerApi,
    writeRules,
    {
      name: "rollback",
      count: 1,
    }
  );
  let failed = false;

  try {
    await projectDelivery(deliveryApi, fixture, {
      evidenceKey: "invalid-sold-at",
      occurredAt: "not-a-time",
    });
  } catch {
    failed = true;
  }

  const [inventory, group, saleCount] = await Promise.all([
    prisma.inventory.findUniqueOrThrow({
      where: { pg_no: fixture.allocations[0].pg_no },
    }),
    prisma.shipment_package_groups.findUniqueOrThrow({
      where: { package_group_id: fixture.packageGroupId },
    }),
    prisma.sales_records.count({
      where: {
        allocation_id: fixture.allocations[0].allocation_id,
      },
    }),
  ]);
  assert(failed, "Invalid sale evidence did not fail the projection.");
  assert(
    inventory.inventory_status === "PACKED" &&
      group.group_status === "READY" &&
      saleCount === 0,
    "A failed sale projection partially committed delivery state."
  );
}

async function assertApprovedReturnBeforeDelivery(
  shipmentApi,
  deliveryApi,
  ledgerApi,
  writeRules
) {
  const fixture = await createDeliveryGroup(
    shipmentApi,
    ledgerApi,
    writeRules,
    {
      name: "approved-before-delivery",
      count: 1,
    }
  );
  await createApprovedReturnLink(
    fixture.allocations[0],
    `${fixture.prefix}-RECEIPT`,
    at("2026-07-25 11:00:00")
  );
  await projectDelivery(deliveryApi, fixture, {
    evidenceKey: "delivered-after-approval-link",
    occurredAt: at("2026-07-25 12:00:00"),
  });
  const sale = await prisma.sales_records.findUniqueOrThrow({
    where: {
      allocation_id: fixture.allocations[0].allocation_id,
    },
  });
  assert(
    sale.sale_status === "RETURNED",
    "A sale created after an approved return link was not RETURNED."
  );
}

async function assertReturnFinalizerRules(
  salesRecordApi,
  returnFinalizerApi,
  shipmentApi,
  deliveryApi,
  ledgerApi,
  writeRules,
  deliveredFixture
) {
  const approvalAllocation = deliveredFixture.allocations[0];
  const firstFinalizedAt = at("2026-07-25 15:00:00");
  const approval = await finalizeReturnAction(
    returnFinalizerApi,
    approvalAllocation,
    {
      receiptId: `${deliveredFixture.prefix}-APPROVAL`,
      requestType: "RETURN_APPROVAL",
      requestedAfterStatus: "RETURNS_COMPLETED",
      inspectionResult: "PASSED",
      additionalTargetExternalIds: ["9001"],
      assertSubsetRejected: true,
      finalizedAt: firstFinalizedAt,
    }
  );
  const approvedSale = await prisma.sales_records.findUniqueOrThrow({
    where: { allocation_id: approvalAllocation.allocation_id },
  });
  assert(
    approvedSale.sale_status === "RETURNED" &&
      sameInstant(approvedSale.updated_at, firstFinalizedAt),
    "Return approval did not transition the existing sale to RETURNED."
  );
  assert(
    (
      await prisma.coupang_return_raw.findUniqueOrThrow({
        where: {
          coupang_return_raw_id: approval.returnRow.coupang_return_raw_id,
        },
      })
    ).return_receipt_status === "RETURNS_COMPLETED",
    "Return approval success was not projected into the local return snapshot."
  );
  const approvalActivity = await prisma.employee_activity_logs.findFirstOrThrow({
    where: {
      action_type: "COUPANG_RETURN_APPROVED",
      target_id: approval.returnRow.external_receipt_id,
    },
    include: { changes: true },
  });
  const approvalActivityText = JSON.stringify(approvalActivity);
  const receiptStatusChange = approvalActivity.changes.find(
    (change) => change.field_name === "receiptStatus"
  );
  assert(
    receiptStatusChange?.before_value === "VENDOR_WAREHOUSE_CONFIRM" &&
      receiptStatusChange.after_value === "RETURNS_COMPLETED",
    "Return approval audit did not preserve the real receipt-status transition."
  );
  assert(
    !approvalActivityText.includes(`${deliveredFixture.prefix}-receiver`) &&
      !approvalActivityText.includes("05070001234") &&
      approvalActivity.changes.every(
        (change) => !/receiver|phone|address/i.test(change.field_name)
      ),
    "Return audit persisted receiver PII outside the scalar allowlist."
  );

  const receiveFixture = await createAllocationSet(ledgerApi, writeRules, {
    name: "receive-confirm",
    count: 1,
  });
  const receiveSource = salesProjectionSource(receiveFixture, 0);
  await prisma.$transaction((tx) =>
    salesRecordApi.projectDeliveredSalesRecords(tx, {
      channel: "COUPANG",
      soldAt: at("2026-07-25 10:00:00"),
      allocations: [receiveSource],
    })
  );
  const receiveBefore = await prisma.sales_records.findUniqueOrThrow({
    where: {
      allocation_id: receiveFixture.allocations[0].allocation_id,
    },
  });
  const receive = await finalizeReturnAction(
    returnFinalizerApi,
    receiveFixture.allocations[0],
    {
      receiptId: `${receiveFixture.prefix}-RECEIVE`,
      requestType: "RETURN_RECEIVE_CONFIRMATION",
      requestedAfterStatus: "VENDOR_WAREHOUSE_CONFIRM",
      advanceProjectionBeforeFinalize: true,
      finalizedAt: at("2026-07-25 15:10:00"),
    }
  );
  const receiveAfter = await prisma.sales_records.findUniqueOrThrow({
    where: {
      allocation_id: receiveFixture.allocations[0].allocation_id,
    },
  });
  assert(
    receiveAfter.sale_status === "SOLD" &&
      sameInstant(receiveAfter.updated_at, receiveBefore.updated_at),
    "Return receive confirmation changed the sales ledger."
  );
  assert(
    (
      await prisma.coupang_return_raw.findUniqueOrThrow({
        where: {
          coupang_return_raw_id: receive.returnRow.coupang_return_raw_id,
        },
      })
    ).return_receipt_status === "VENDOR_WAREHOUSE_CONFIRM",
    "Return receive-confirm success was not projected into the local return snapshot."
  );

  const stopFixture = await createAllocationSet(ledgerApi, writeRules, {
    name: "stop-shipment",
    count: 1,
  });
  const stopSource = salesProjectionSource(stopFixture, 0);
  await prisma.$transaction((tx) =>
    salesRecordApi.projectDeliveredSalesRecords(tx, {
      channel: "COUPANG",
      soldAt: at("2026-07-25 10:10:00"),
      allocations: [stopSource],
    })
  );
  const stopBefore = await prisma.sales_records.findUniqueOrThrow({
    where: { allocation_id: stopFixture.allocations[0].allocation_id },
  });
  const stopped = await finalizeReturnAction(
    returnFinalizerApi,
    stopFixture.allocations[0],
    {
      receiptId: `${stopFixture.prefix}-STOP`,
      requestType: "RETURN_STOPPED_SHIPMENT",
      requestedAfterStatus: "S",
      finalizedAt: at("2026-07-25 15:20:00"),
    }
  );
  const stopAfter = await prisma.sales_records.findUniqueOrThrow({
    where: { allocation_id: stopFixture.allocations[0].allocation_id },
  });
  assert(
    stopAfter.sale_status === "SOLD" &&
      sameInstant(stopAfter.updated_at, stopBefore.updated_at),
    "Stopped shipment finalization changed the sales ledger."
  );
  assert(
    (
      await prisma.coupang_return_raw.findUniqueOrThrow({
        where: {
          coupang_return_raw_id: stopped.returnRow.coupang_return_raw_id,
        },
      })
    ).return_release_status === "S",
    "Stopped-shipment success was not projected into the local return snapshot."
  );

  const missingSaleFixture = await createDeliveryGroup(
    shipmentApi,
    ledgerApi,
    writeRules,
    {
      name: "approval-without-sale",
      count: 1,
    }
  );
  await projectDelivery(deliveryApi, missingSaleFixture, {
    evidenceKey: "delivery-before-sale-delete",
    occurredAt: at("2026-07-25 12:30:00"),
  });
  await prisma.sales_records.delete({
    where: {
      allocation_id: missingSaleFixture.allocations[0].allocation_id,
    },
  });
  await finalizeReturnAction(
    returnFinalizerApi,
    missingSaleFixture.allocations[0],
    {
      receiptId: `${missingSaleFixture.prefix}-APPROVAL`,
      requestType: "RETURN_APPROVAL",
      requestedAfterStatus: "RETURNS_COMPLETED",
      inspectionResult: "PASSED",
      finalizedAt: at("2026-07-25 15:30:00"),
    }
  );
  assert(
    (await prisma.sales_records.count({
      where: {
        allocation_id:
          missingSaleFixture.allocations[0].allocation_id,
      },
    })) === 0,
    "Return approval backfilled a missing historical sale record."
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const shipmentApi = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );
  const deliveryApi = await import(
    "@/quickhack_server/shipment/delivery-status-projection-service"
  );
  const salesRecordApi = await import(
    "@/quickhack_server/sales/sales-record-service"
  );
  const returnFinalizerApi = await import(
    "@/quickhack_server/returns/return-write-finalizer"
  );
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const writeRules = await import(
    "@/quickhack_shared/inventory/inventory-write-rules"
  );

  const deliveredFixture = await assertDeliveredProjection(
    shipmentApi,
    deliveryApi,
    ledgerApi,
    writeRules
  );
  await assertNonDeliveredDoesNotCreateSales(
    shipmentApi,
    deliveryApi,
    ledgerApi,
    writeRules
  );
  await assertProjectionRollback(
    shipmentApi,
    deliveryApi,
    ledgerApi,
    writeRules
  );
  await assertApprovedReturnBeforeDelivery(
    shipmentApi,
    deliveryApi,
    ledgerApi,
    writeRules
  );
  await assertReturnFinalizerRules(
    salesRecordApi,
    returnFinalizerApi,
    shipmentApi,
    deliveryApi,
    ledgerApi,
    writeRules,
    deliveredFixture
  );
  console.log(
    "Sales record delivery projection, retry, rollback, and return rules verified."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
