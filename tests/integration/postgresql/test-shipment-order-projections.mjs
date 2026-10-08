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
  "quickhack-shipment-order-projections-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

const shipmentDefinitions = [
  {
    externalShipmentId: "SHIPMENT-INSTRUCT",
    status: "INSTRUCT",
    receiverName: "Instruct Receiver",
    postCode: "11111",
    address1: "Instruct Street 1",
    address2: "Unit 101",
  },
  {
    externalShipmentId: "SHIPMENT-ACCEPT",
    status: "ACCEPT",
    receiverName: "Accept Receiver",
    postCode: "22222",
    address1: "Accept Street 2",
    address2: "Unit 202",
  },
  {
    externalShipmentId: "SHIPMENT-DEPARTURE",
    status: "DEPARTURE",
    receiverName: "Departure Receiver",
    postCode: "33333",
    address1: "Departure Street 3",
    address2: "Unit 303",
  },
  {
    externalShipmentId: "SHIPMENT-DELIVERING",
    status: "DELIVERING",
    receiverName: "Delivering Receiver",
    postCode: "44444",
    address1: "Delivering Street 4",
    address2: "Unit 404",
  },
];

function expectedAddress(shipment) {
  return [shipment.postCode, shipment.address1, shipment.address2].join(" / ");
}

async function createProjectionFixtures(ledgerApi, writeRules) {
  const timestamp = new Date("2026-08-05T10:00:00+09:00");
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "shipment-order-projections",
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalog,
    { count: shipmentDefinitions.length * 2 + 2, timestamp }
  );
  const orders = [
    {
      externalOrderId: "PROJECTION-ORDER-FORWARD",
      shipments: shipmentDefinitions,
    },
    {
      externalOrderId: "PROJECTION-ORDER-REVERSE",
      shipments: [...shipmentDefinitions].reverse(),
    },
  ];
  const expectedRows = [];
  let deviceIndex = 0;

  for (const order of orders) {
    for (const shipment of order.shipments) {
      const device = devices[deviceIndex];
      const externalVendorItemId = [
        order.externalOrderId,
        shipment.externalShipmentId,
        "ITEM",
      ].join("-");

      deviceIndex += 1;
      await prisma.coupang_order_raw.create({
        data: {
          external_order_id: order.externalOrderId,
          external_shipment_id: shipment.externalShipmentId,
          external_order_status: shipment.status,
          ordered_at: timestamp,
          paid_at: timestamp,
          receiver_name: shipment.receiverName,
          receiver_safe_number: "01000000000",
          receiver_post_code: shipment.postCode,
          receiver_address_1: shipment.address1,
          receiver_address_2: shipment.address2,
          synced_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        },
      });
      await prisma.order_matching_work_queue.create({
        data: {
          channel: "COUPANG",
          external_order_id: order.externalOrderId,
          external_shipment_id: shipment.externalShipmentId,
          external_vendor_item_id: externalVendorItemId,
          vendor_item_name: externalVendorItemId,
          ordered_quantity: 1,
          matchable_quantity: 1,
          mapping_status: "MAPPED",
          sales_offer_id: catalog.salesOffer.sales_offer_id,
          ...catalog.orderMappingSnapshot,
          work_status: "MATCHED",
          matched_at: timestamp,
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
          operationKey: `shipment-projection-reserve:${device.pgNo}`,
          movementType:
            ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
          sourceType: "INTEGRATION_TEST",
          sourceId: shipment.externalShipmentId,
          occurredAt: timestamp,
        })
      );
      await prisma.match_worker_allocation.create({
        data: {
          external_order_id: order.externalOrderId,
          external_shipment_id: shipment.externalShipmentId,
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
      });
      expectedRows.push({
        externalOrderId: order.externalOrderId,
        ...shipment,
      });
    }
  }

  return { expectedRows, extraDevices: devices.slice(-2), timestamp };
}

function findProjectedRow(result, expected) {
  return result.items.find(
    (row) =>
      row.externalOrderId === expected.externalOrderId &&
      row.externalShipmentId === expected.externalShipmentId
  );
}

function assertExactShipmentProjection(result, expectedRows) {
  assert(
    result.items.length === expectedRows.length,
    "The all-orders projection lost or duplicated a shipment row."
  );

  for (const expected of expectedRows) {
    const row = findProjectedRow(result, expected);

    assert(
      row,
      `Missing projection for ${expected.externalOrderId}/${expected.externalShipmentId}.`
    );
    assert(
      row.channelStatus === expected.status,
      `A sibling shipment status leaked into ${expected.externalOrderId}/${expected.externalShipmentId}.`
    );
    assert(
      row.receiverName === expected.receiverName &&
        row.receiverAddress === expectedAddress(expected),
      `Sibling receiver data leaked into ${expected.externalOrderId}/${expected.externalShipmentId}.`
    );
  }
}

function assertMatchedProjection(result, expectedRows) {
  const expectedMatchedRows = expectedRows.filter(
    (row) => row.status === "INSTRUCT"
  );

  assert(
    result.items.length === expectedMatchedRows.length,
    "The matched projection did not select exactly the INSTRUCT shipments."
  );
  for (const expected of expectedMatchedRows) {
    const row = findProjectedRow(result, expected);
    const matchedDevice = row?.matchedDevices[0];

    assert(
      row?.channelStatus === "INSTRUCT" && matchedDevice,
      `The print-ready shipment ${expected.externalOrderId}/${expected.externalShipmentId} was omitted.`
    );
    assert(
      matchedDevice.inventoryStatus === "RESERVED" &&
        matchedDevice.allocationStatus === "API_ACKED",
      "The matched projection fixture does not satisfy the print-ready inventory contract."
    );
    assert(
      matchedDevice.packageGroupKey ===
        `${expected.receiverName}\n${expectedAddress(expected)}`,
      "The package candidate key did not use the exact shipment receiver."
    );
  }
}

function assertDeliveringProjection(result, expectedRows) {
  const expectedDeliveringRows = expectedRows.filter(
    (row) => row.status === "DELIVERING"
  );

  assert(
    result.items.length === expectedDeliveringRows.length,
    "A non-DELIVERING sibling shipment leaked into the delivering list."
  );
  for (const expected of expectedDeliveringRows) {
    const row = findProjectedRow(result, expected);

    assert(
      row?.channelStatus === "DELIVERING" &&
        row.receiverName === expected.receiverName &&
        row.receiverAddress === expectedAddress(expected),
      `The delivering projection is incorrect for ${expected.externalOrderId}/${expected.externalShipmentId}.`
    );
  }
}

function assertAllOrderSummary(result, expected) {
  for (const [field, value] of Object.entries(expected)) {
    assert(
      result.summary[field] === value,
      `All-orders summary ${field} was ${result.summary[field]}, expected ${value}.`
    );
  }
}

async function createSummaryOrder({ orderId, shipmentId, vendorId, allocationVendorId, pgNo, allocationStatus, workStatus, timestamp }) {
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: orderId,
      external_shipment_id: shipmentId,
      external_order_status: "ACCEPT",
      ordered_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.order_matching_work_queue.create({
    data: {
      channel: "COUPANG",
      external_order_id: orderId,
      external_shipment_id: shipmentId,
      external_vendor_item_id: vendorId,
      ordered_quantity: 1,
      matchable_quantity: 1,
      work_status: workStatus,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.match_worker_allocation.create({
    data: {
      external_order_id: orderId,
      external_shipment_id: shipmentId,
      external_vendor_item_id: allocationVendorId,
      pg_no: pgNo,
      allocation_status: allocationStatus,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const shipmentApi = await import(
    "@/quickhack_server/shipment/shipment-orders-service"
  );
  const ledgerApi = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const writeRules = await import(
    "@/quickhack_shared/inventory/inventory-write-rules"
  );
  const { expectedRows, extraDevices, timestamp } = await createProjectionFixtures(ledgerApi, writeRules);

  const allOrders = await shipmentApi.listShipmentOrderItems({ mode: "all", limit: 100 });
  assertExactShipmentProjection(allOrders, expectedRows);
  assertAllOrderSummary(allOrders, {
    orderCount: 2,
    orderItemCount: 8,
    matchedOrderItemCount: 8,
    fullyMatchedOrderItemCount: 8,
    matchedDeviceCount: 8,
  });
  assertMatchedProjection(
    await shipmentApi.listShipmentOrderItems({ mode: "matched", limit: 100 }),
    expectedRows
  );
  assertDeliveringProjection(
    await shipmentApi.listDeliveringShipmentItems({ limit: 100 }),
    expectedRows
  );

  const duplicateTarget = expectedRows[0];
  await prisma.match_worker_allocation.create({
    data: {
      external_order_id: duplicateTarget.externalOrderId,
      external_shipment_id: duplicateTarget.externalShipmentId,
      external_vendor_item_id: `${duplicateTarget.externalOrderId}-${duplicateTarget.externalShipmentId}-ITEM`,
      pg_no: extraDevices[0].pgNo,
      allocation_status: "ALLOCATED",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await createSummaryOrder({
    orderId: "PROJECTION-ORDER-EMPTY-VENDOR",
    shipmentId: "SHIPMENT-EMPTY-VENDOR",
    vendorId: "",
    allocationVendorId: null,
    pgNo: extraDevices[1].pgNo,
    allocationStatus: "ALLOCATED",
    workStatus: "MATCHED",
    timestamp,
  });
  const beforeInsert = await shipmentApi.listShipmentOrderItems({ mode: "all", limit: 2 });
  assert(beforeInsert.hasMore && beforeInsert.nextCursor, "A stable next-page cursor was not returned.");
  assertAllOrderSummary(beforeInsert, {
    orderCount: 3,
    orderItemCount: 9,
    matchedOrderItemCount: 9,
    fullyMatchedOrderItemCount: 9,
    matchedDeviceCount: 10,
  });

  await createSummaryOrder({
    orderId: "PROJECTION-ORDER-INACTIVE",
    shipmentId: "SHIPMENT-INACTIVE",
    vendorId: "INACTIVE-VENDOR",
    allocationVendorId: "INACTIVE-VENDOR",
    pgNo: extraDevices[1].pgNo,
    allocationStatus: "CANCELED",
    workStatus: "UNMATCHED",
    timestamp,
  });
  const afterInsert = await shipmentApi.listShipmentOrderItems({ mode: "all", limit: 2 });
  assertAllOrderSummary(afterInsert, {
    orderCount: 4,
    orderItemCount: 10,
    matchedOrderItemCount: 9,
    fullyMatchedOrderItemCount: 9,
    matchedDeviceCount: 10,
  });
  assert(
    afterInsert.items[0]?.externalOrderId === "PROJECTION-ORDER-INACTIVE",
    "The fresh first page did not include the inserted order."
  );
  const nextPage = await shipmentApi.listShipmentOrderItems({
    mode: "all",
    limit: 2,
    cursor: beforeInsert.nextCursor,
  });
  assertAllOrderSummary(nextPage, beforeInsert.summary);
  assert(
    nextPage.items.every((row) => row.externalOrderId !== "PROJECTION-ORDER-INACTIVE"),
    "The inserted order leaked into an existing cursor snapshot."
  );
  console.log(
    "Shipment projections and all-orders summary preserve exact counts and cursor snapshots."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
