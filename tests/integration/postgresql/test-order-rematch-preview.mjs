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
  "quickhack-order-rematch-preview-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

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
  const timestamp = new Date("2026-08-04T18:00:00.000Z");
  const catalogA = await createInventoryCatalogFixture(prisma, {
    prefix: "rematch-preview-a",
    timestamp,
  });
  const catalogB = await createInventoryCatalogFixture(prisma, {
    prefix: "rematch-preview-b",
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerApi,
    catalogA,
    { count: 16, timestamp }
  );
  let deviceIndex = 0;

  async function reserveDevice(pgNo, operationKey) {
    await prisma.$transaction((tx) =>
      ledgerApi.transitionInventoryStatusWithLedger(tx, {
        pgNo,
        expectedFromStatus: "SELLABLE",
        toStatus: "RESERVED",
        transitionPolicy:
          writeRules.INVENTORY_TRANSITION_POLICY.orderMatchingReservation,
        operationKey,
        movementType:
          ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "INTEGRATION_TEST",
        sourceId: operationKey,
        occurredAt: timestamp,
      })
    );
  }

  async function createShipment(input) {
    const externalOrderId = `ORDER-${input.key}`;
    const externalShipmentId = `SHIP-${input.key}`;

    await prisma.coupang_order_raw.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_order_status: input.orderStatus ?? "INSTRUCT",
        ordered_at: timestamp,
        synced_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });

    const createdItems = [];

    for (const [itemIndex, item] of input.items.entries()) {
      const externalVendorItemId = `VENDOR-${input.key}-${itemIndex + 1}`;
      const matchableQuantity = item.matchableQuantity ?? 1;
      const work = await prisma.order_matching_work_queue.create({
        data: {
          channel: "COUPANG",
          external_order_id: externalOrderId,
          external_shipment_id: externalShipmentId,
          external_vendor_item_id: externalVendorItemId,
          vendor_item_name: `상품 ${input.key}-${itemIndex + 1}`,
          ordered_quantity: matchableQuantity,
          matchable_quantity: matchableQuantity,
          mapping_status: "MAPPED",
          sales_offer_id: catalogA.salesOffer.sales_offer_id,
          ...catalogA.orderMappingSnapshot,
          work_status: item.workStatus ?? "MATCHED",
          matched_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        },
      });

      if (item.createMapping !== false) {
        await prisma.sales_channel_product_mappings.create({
          data: {
            channel: "COUPANG",
            external_vendor_item_id: externalVendorItemId,
            sales_offer_id:
              item.currentOffer === "A"
                ? catalogA.salesOffer.sales_offer_id
                : catalogB.salesOffer.sales_offer_id,
            mapping_status: "MAPPED",
            mapped_at: timestamp,
            created_at: timestamp,
            updated_at: timestamp,
          },
        });
      }

      const allocations = [];
      const allocationCount = item.allocationCount ?? matchableQuantity;

      for (let allocationIndex = 0; allocationIndex < allocationCount; allocationIndex += 1) {
        const device = devices[deviceIndex++];
        assert(device, "The rematch preview fixture ran out of devices.");

        if (item.inventoryStatus !== "SELLABLE") {
          await reserveDevice(
            device.pgNo,
            `rematch-preview:${input.key}:${itemIndex}:${allocationIndex}`
          );
        }

        allocations.push(
          await prisma.match_worker_allocation.create({
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
              allocation_status: item.allocationStatus ?? "API_ACKED",
              allocated_at: timestamp,
              created_at: timestamp,
              updated_at: timestamp,
            },
          })
        );
      }

      createdItems.push({ work, allocations, externalVendorItemId });
    }

    return { externalOrderId, externalShipmentId, items: createdItems };
  }

  const eligible = await createShipment({
    key: "ELIGIBLE",
    items: [
      { currentOffer: "A", inventoryStatus: "RESERVED" },
      { currentOffer: "B", inventoryStatus: "RESERVED" },
    ],
  });
  const partial = await createShipment({
    key: "PARTIAL",
    items: [
      { currentOffer: "A", inventoryStatus: "RESERVED" },
      {
        currentOffer: "A",
        workStatus: "PARTIAL",
        matchableQuantity: 2,
        allocationCount: 1,
        inventoryStatus: "RESERVED",
      },
    ],
  });
  const printed = await createShipment({
    key: "PRINTED",
    items: [{ currentOffer: "A", inventoryStatus: "RESERVED" }],
  });
  const pendingWrite = await createShipment({
    key: "WRITE",
    items: [{ currentOffer: "A", inventoryStatus: "RESERVED" }],
  });
  const activeReturn = await createShipment({
    key: "RETURN",
    items: [{ currentOffer: "A", inventoryStatus: "RESERVED" }],
  });
  const sold = await createShipment({
    key: "SOLD",
    items: [{ currentOffer: "A", inventoryStatus: "RESERVED" }],
  });
  const departed = await createShipment({
    key: "DEPARTED",
    orderStatus: "DEPARTURE",
    items: [{ currentOffer: "A", inventoryStatus: "RESERVED" }],
  });
  const missingMapping = await createShipment({
    key: "NO-MAPPING",
    items: [{ createMapping: false, inventoryStatus: "RESERVED" }],
  });
  const sellableInventory = await createShipment({
    key: "SELLABLE",
    items: [{ currentOffer: "A", inventoryStatus: "SELLABLE" }],
  });

  const printBatch = await prisma.sales_channel_shipment_list_print_batches.create({
    data: {
      channel: "COUPANG",
      tab_key: "coupang-2y",
      tab_label: "2년 보증",
      print_date: new Date("2026-08-04T00:00:00.000Z"),
      batch_no: 1,
      batch_label: "2년 보증 1차",
      item_count: 1,
      package_group_count: 1,
      batch_status: "PENDING",
      printed_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.sales_channel_shipment_list_print_batch_items.create({
    data: {
      shipment_list_print_batch_id: printBatch.shipment_list_print_batch_id,
      channel: "COUPANG",
      tab_key: "coupang-2y",
      print_date: new Date("2026-08-04T00:00:00.000Z"),
      print_line_no: 1,
      allocation_id: printed.items[0].allocations[0].allocation_id,
      pg_no: printed.items[0].allocations[0].pg_no,
      created_at: timestamp,
    },
  });

  const writeRequest = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "ORDER_STATUS_INSTRUCT",
      request_status: "VERIFYING",
      target_type: "SHIPMENT_BOX",
      target_external_id: pendingWrite.externalShipmentId,
      idempotency_key: "REMATCH-PREVIEW-PENDING-WRITE",
      request_digest: "test-fixture",
      method: "PUT",
      endpoint_path: "/mock/order-status",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.sales_channel_write_request_targets.create({
    data: {
      sales_channel_write_request_id:
        writeRequest.sales_channel_write_request_id,
      target_type: "SHIPMENT_BOX",
      target_external_id: pendingWrite.externalShipmentId,
      external_order_id: pendingWrite.externalOrderId,
      external_shipment_id: pendingWrite.externalShipmentId,
      created_at: timestamp,
    },
  });

  const returnRaw = await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: "REMATCH-PREVIEW-RETURN",
      external_order_id: activeReturn.externalOrderId,
      external_shipment_id: activeReturn.externalShipmentId,
      cancel_type: "RETURN",
      return_receipt_status: "RU",
      cancel_count: 1,
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.coupang_return_raw_item.create({
    data: {
      coupang_return_raw_id: returnRaw.coupang_return_raw_id,
      external_receipt_id: returnRaw.external_receipt_id,
      external_order_id: activeReturn.externalOrderId,
      external_shipment_id: activeReturn.externalShipmentId,
      external_vendor_item_id: activeReturn.items[0].externalVendorItemId,
      cancel_count: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  const soldAllocation = sold.items[0].allocations[0];
  await prisma.sales_records.create({
    data: {
      allocation_id: soldAllocation.allocation_id,
      pg_no: soldAllocation.pg_no,
      sales_offer_id: catalogA.salesOffer.sales_offer_id,
      inventory_sku_id: catalogA.sku.inventory_sku_id,
      channel: "COUPANG",
      external_order_id: sold.externalOrderId,
      external_shipment_id: sold.externalShipmentId,
      external_vendor_item_id: sold.items[0].externalVendorItemId,
      sold_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  const pages = [];
  let cursor = null;

  do {
    const page = await listCoupangOrderRematchPreview({ cursor, limit: 3 });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);

  const firstPage = pages[0];
  const items = pages.flatMap((page) => page.items);
  const byShipmentId = new Map(
    items.map((item) => [item.externalShipmentId, item])
  );
  const reasonCodes = (shipmentId) =>
    new Set(
      byShipmentId
        .get(shipmentId)
        .exclusionReasons.map((reason) => reason.code)
    );

  assert.equal(firstPage.summary.candidateShipmentCount, 5);
  assert.equal(firstPage.summary.eligibleShipmentCount, 1);
  assert.equal(firstPage.summary.excludedShipmentCount, 4);
  assert.equal(items.length, 5);
  assert(pages.every((page) => page.items.length <= 3));
  assert.match(firstPage.manifestToken, /^[a-f0-9]{64}$/);
  assert(
    pages.every((page) => page.manifestToken === firstPage.manifestToken),
    "Paginated preview pages did not share one global manifest."
  );
  assert.equal(byShipmentId.get(eligible.externalShipmentId).eligible, true);
  assert.equal(
    byShipmentId.get(eligible.externalShipmentId).items[0].matchedOffer.salesOfferId,
    byShipmentId.get(eligible.externalShipmentId).items[0].currentDefaultOffer.salesOfferId,
    "A correctly mapped completed order was unexpectedly excluded from the global rematch scope."
  );
  assert(
    reasonCodes(partial.externalShipmentId).has("SHIPMENT_NOT_FULLY_MATCHED")
  );
  assert(
    reasonCodes(partial.externalShipmentId).has("ALLOCATION_QUANTITY_MISMATCH")
  );
  assert(
    reasonCodes(pendingWrite.externalShipmentId).has("WRITE_REQUEST_PENDING")
  );
  for (const historicalShipment of [printed, activeReturn, sold, departed]) {
    assert(
      !byShipmentId.has(historicalShipment.externalShipmentId),
      `Completed or handed-off shipment leaked into the active rematch window: ${historicalShipment.externalShipmentId}`
    );
  }
  assert(
    reasonCodes(missingMapping.externalShipmentId).has(
      "CURRENT_MAPPING_UNAVAILABLE"
    )
  );
  assert(
    reasonCodes(sellableInventory.externalShipmentId).has(
      "INVENTORY_NOT_RESERVED"
    )
  );

  await prisma.order_matching_work_queue.update({
    where: {
      work_item_id: departed.items[0].work.work_item_id,
    },
    data: {
      vendor_item_name: "historical order changed outside rematch window",
      updated_at: new Date("2026-08-04T18:01:00.000Z"),
    },
  });
  const afterHistoricalChange = await listCoupangOrderRematchPreview({
    unpaginated: true,
  });
  assert.equal(
    afterHistoricalChange.manifestToken,
    firstPage.manifestToken,
    "A completed historical order invalidated the active rematch manifest."
  );

  const boundaryCandidates = Array.from({ length: 85 }, (_, index) => ({
    orderId: `ORDER-BOUNDARY-${index + 1}`,
    shipmentId: `SHIP-BOUNDARY-${index + 1}`,
    vendorItemId: `VENDOR-BOUNDARY-${index + 1}`,
  }));
  await prisma.coupang_order_raw.createMany({
    data: boundaryCandidates.map((candidate) => ({
      external_order_id: candidate.orderId,
      external_shipment_id: candidate.shipmentId,
      external_order_status: "INSTRUCT",
      ordered_at: timestamp,
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    })),
  });
  await prisma.order_matching_work_queue.createMany({
    data: boundaryCandidates.map((candidate) => ({
      channel: "COUPANG",
      external_order_id: candidate.orderId,
      external_shipment_id: candidate.shipmentId,
      external_vendor_item_id: candidate.vendorItemId,
      vendor_item_name: "pagination boundary candidate",
      ordered_quantity: 1,
      matchable_quantity: 1,
      mapping_status: "UNMAPPED",
      work_status: "MATCHED",
      matched_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    })),
  });

  const boundaryPages = [];
  let boundaryCursor = null;

  do {
    const page = await listCoupangOrderRematchPreview({
      cursor: boundaryCursor,
      limit: 25,
    });
    boundaryPages.push(page);
    boundaryCursor = page.nextCursor;
  } while (boundaryCursor);

  const boundaryItems = boundaryPages.flatMap((page) => page.items);
  assert.equal(boundaryItems.length, 90);
  assert.equal(
    new Set(boundaryItems.map((item) => item.externalShipmentId)).size,
    90,
    "Cursor pagination duplicated or skipped an active rematch candidate."
  );
  assert(boundaryPages.every((page) => page.items.length <= 25));
  assert(
    boundaryPages.every(
      (page) => page.manifestToken === firstPage.manifestToken
    ),
    "Cross-batch preview pages did not share the eligible target manifest."
  );

  const serialized = JSON.stringify(firstPage);
  for (const forbidden of [
    "receiverName",
    "receiverAddress",
    "receiverPhone",
    "receiver_safe_number",
    "receiver_address_1",
  ]) {
    assert(!serialized.includes(forbidden), `Preview leaked PII field: ${forbidden}`);
  }

  const apiSource = await readFile(
    path.join(
      projectRoot,
      "quickhack_server/api/sales-channel/coupang/order-rematch-preview.ts"
    ),
    "utf8"
  );
  const clientSource = await readFile(
    path.join(
      projectRoot,
      "quickhack_client/api/sales-channel/coupang-order-rematch-preview.ts"
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
  assert(apiSource.includes('canAccessRole(user.role, "MANAGER")'));
  assert(apiSource.includes("export async function GET"));
  assert(!apiSource.includes("export async function POST"));
  assert(clientSource.includes("executeCoupangOrderRematch"));
  assert(viewSource.includes("재매칭 대상 확인"));
  assert(viewSource.includes("배정 해제 후 재매칭"));
  assert(viewSource.includes("rematchPreview.hasMore"));

  console.log("Order rematch preview eligibility, privacy, and UI contract verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
