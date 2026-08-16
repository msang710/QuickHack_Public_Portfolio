import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-coupang-inventory-verification-projection-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    calculateCoupangInventoryVerificationProjection,
  } = await import(
    "@/quickhack_server/sales-channel/coupang/inventory-verification-projection-service"
  );

  async function createOption(category, optionKey) {
    const existing = await prisma.product_criteria_options.findFirst({
      where: { category, option_key: optionKey, parent_key: "" },
    });

    if (existing) return existing;
    return prisma.product_criteria_options.create({
      data: { category, option_key: optionKey, label: optionKey },
    });
  }

  const [model, storage, color, grade, warranty] = await Promise.all([
    createOption("PRODUCT_MODEL", "PENDING-PROJECTION-MODEL"),
    createOption("STORAGE", "256GB"),
    createOption("DEVICE_COLOR", "BLACK"),
    createOption("SALE_GRADE", "A"),
    createOption("WARRANTY_GROUP", "2Y"),
  ]);
  const offer = await prisma.sales_offers.create({
    data: {
      offer_code: "PENDING-PROJECTION-OFFER",
      model_option_id: model.option_id,
      storage_match_mode: "EXACT",
      storage_option_id: storage.option_id,
      color_match_mode: "EXACT",
      color_option_id: color.option_id,
      warranty_group_option_id: warranty.option_id,
    },
  });
  const mapping = await prisma.sales_channel_product_mappings.create({
    data: {
      channel: "COUPANG",
      external_vendor_item_id: "VENDOR-PENDING-PROJECTION",
      external_option_name: "Pending projection",
      sales_offer_id: offer.sales_offer_id,
      mapping_status: "MAPPED",
    },
  });
  const otherMapping = await prisma.sales_channel_product_mappings.create({
    data: {
      channel: "COUPANG",
      external_vendor_item_id: "VENDOR-PENDING-OTHER",
      external_option_name: "Other pending projection",
      sales_offer_id: offer.sales_offer_id,
      mapping_status: "MAPPED",
    },
  });
  const skippedMapping = await prisma.sales_channel_product_mappings.create({
    data: {
      channel: "COUPANG",
      external_vendor_item_id: "VENDOR-PENDING-SKIPPED",
      external_option_name: "Skipped pending projection",
      mapping_status: "UNMAPPED",
    },
  });
  const sku = await prisma.inventory_skus.create({
    data: {
      sku_code: "PENDING-PROJECTION-SKU",
      model_option_id: model.option_id,
      storage_option_id: storage.option_id,
      color_option_id: color.option_id,
      sale_grade_option_id: grade.option_id,
    },
  });
  const balance = await prisma.inventory_quantity_balances.create({
    data: {
      inventory_sku_id: sku.inventory_sku_id,
      inventory_status: "SELLABLE",
      quantity: 5,
    },
  });

  const emptyProjection =
    await calculateCoupangInventoryVerificationProjection(mapping.mapping_id);
  assert.equal(emptyProjection.status, "PROJECTED");
  assert.equal(emptyProjection.ledgerQuantity, 5);
  assert.equal(emptyProjection.pendingOrderQuantity, 0);
  assert.equal(emptyProjection.expectedChannelQuantity, 5);

  let orderSequence = 0;
  let deviceSequence = 0;
  async function createWorkItem(input) {
    orderSequence += 1;
    const externalOrderId = `ORDER-PENDING-${orderSequence}`;
    const externalShipmentId = `SHIP-PENDING-${orderSequence}`;
    const externalVendorItemId =
      input.externalVendorItemId ?? mapping.external_vendor_item_id;

    await prisma.coupang_order_raw.create({
      data: {
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_order_status: "INSTRUCT",
      },
    });
    return prisma.order_matching_work_queue.create({
      data: {
        channel: input.channel ?? "COUPANG",
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        external_vendor_item_id: externalVendorItemId,
        ordered_quantity: input.quantity,
        matchable_quantity: input.quantity,
        canceled: input.canceled ?? 0,
        mapping_status: input.mappingStatus ?? "MAPPED",
        sales_offer_id:
          input.salesOfferId === undefined
            ? offer.sales_offer_id
            : input.salesOfferId,
        work_status: input.workStatus,
      },
    });
  }

  async function createAllocation(workItem, allocationStatus) {
    deviceSequence += 1;
    const pgNo = `PENDING-PROJECTION-PG-${deviceSequence}`;

    await prisma.devices.create({
      data: {
        pg_no: pgNo,
        model: "Pending projection model",
      },
    });
    return prisma.match_worker_allocation.create({
      data: {
        external_order_id: workItem.external_order_id,
        external_shipment_id: workItem.external_shipment_id,
        external_vendor_item_id: workItem.external_vendor_item_id,
        pg_no: pgNo,
        sales_offer_id: offer.sales_offer_id,
        inventory_sku_id: sku.inventory_sku_id,
        allocation_status: allocationStatus,
      },
    });
  }

  const unmatched = await createWorkItem({
    quantity: 2,
    workStatus: "UNMATCHED",
  });
  const partial = await createWorkItem({
    quantity: 4,
    workStatus: "PARTIAL",
  });
  await createAllocation(partial, "ALLOCATED");
  await createAllocation(partial, "API_ACKED");
  await createAllocation(partial, "SHIPMENT_LIST_PRINTED");

  const failed = await createWorkItem({
    quantity: 2,
    workStatus: "FAILED",
    mappingStatus: "UNMAPPED",
    salesOfferId: null,
  });
  await createAllocation(failed, "CANCELED");
  await createAllocation(failed, "FAILED");

  const overAllocated = await createWorkItem({
    quantity: 1,
    workStatus: "UNMATCHED",
  });
  await createAllocation(overAllocated, "ALLOCATED");
  await createAllocation(overAllocated, "API_ACKED");

  await createWorkItem({ quantity: 9, workStatus: "MATCHED" });
  await createWorkItem({ quantity: 9, workStatus: "SKIPPED" });
  await createWorkItem({ quantity: 9, workStatus: "EXPIRED" });
  await createWorkItem({
    quantity: 9,
    workStatus: "UNMATCHED",
    canceled: 1,
  });
  await createWorkItem({ quantity: 0, workStatus: "FAILED" });
  await createWorkItem({
    quantity: 7,
    workStatus: "UNMATCHED",
    externalVendorItemId: otherMapping.external_vendor_item_id,
  });

  const projected =
    await calculateCoupangInventoryVerificationProjection(mapping.mapping_id);
  assert.equal(projected.status, "PROJECTED");
  assert.equal(projected.ledgerQuantity, 5);
  assert.equal(projected.pendingOrderQuantity, 5);
  assert.equal(projected.expectedChannelQuantity, 0);

  const otherProjected =
    await calculateCoupangInventoryVerificationProjection(
      otherMapping.mapping_id
    );
  assert.equal(otherProjected.status, "PROJECTED");
  assert.equal(otherProjected.pendingOrderQuantity, 7);
  assert.equal(otherProjected.expectedChannelQuantity, 0);

  await prisma.order_matching_work_queue.delete({
    where: { work_item_id: unmatched.work_item_id },
  });
  await createWorkItem({ quantity: 2, workStatus: "FAILED" });
  const replaced =
    await calculateCoupangInventoryVerificationProjection(mapping.mapping_id);
  assert.equal(replaced.status, "PROJECTED");
  assert.equal(replaced.pendingOrderQuantity, 5);
  assert.equal(replaced.projectionBasisHash, projected.projectionBasisHash);

  await prisma.inventory_quantity_balances.update({
    where: {
      inventory_sku_id_inventory_status: {
        inventory_sku_id: balance.inventory_sku_id,
        inventory_status: "SELLABLE",
      },
    },
    data: { quantity: 4, version: { increment: 1 } },
  });
  const clamped =
    await calculateCoupangInventoryVerificationProjection(mapping.mapping_id);
  assert.equal(clamped.status, "PROJECTED");
  assert.equal(clamped.ledgerQuantity, 4);
  assert.equal(clamped.pendingOrderQuantity, 5);
  assert.equal(clamped.expectedChannelQuantity, 0);

  const largeBacklogSize = 1_200;
  await prisma.order_matching_work_queue.createMany({
    data: Array.from({ length: largeBacklogSize }, (_, index) => ({
      channel: "COUPANG",
      external_order_id: `ORDER-PENDING-BACKLOG-${index + 1}`,
      external_shipment_id: `SHIP-PENDING-BACKLOG-${index + 1}`,
      external_vendor_item_id: mapping.external_vendor_item_id,
      ordered_quantity: 1,
      matchable_quantity: 1,
      mapping_status: "MAPPED",
      sales_offer_id: offer.sales_offer_id,
      work_status: "UNMATCHED",
    })),
  });
  const allocatedBacklogIndexes = Array.from(
    { length: 12 },
    (_, batchIndex) => batchIndex * 100
  );
  await prisma.coupang_order_raw.createMany({
    data: allocatedBacklogIndexes.map((index) => ({
      external_order_id: `ORDER-PENDING-BACKLOG-${index + 1}`,
      external_shipment_id: `SHIP-PENDING-BACKLOG-${index + 1}`,
      external_order_status: "INSTRUCT",
    })),
  });
  await prisma.devices.createMany({
    data: allocatedBacklogIndexes.map((index) => ({
      pg_no: `PENDING-PROJECTION-BACKLOG-PG-${index + 1}`,
      model: "Pending projection backlog model",
    })),
  });
  await prisma.match_worker_allocation.createMany({
    data: allocatedBacklogIndexes.map((index) => ({
      external_order_id: `ORDER-PENDING-BACKLOG-${index + 1}`,
      external_shipment_id: `SHIP-PENDING-BACKLOG-${index + 1}`,
      external_vendor_item_id: mapping.external_vendor_item_id,
      pg_no: `PENDING-PROJECTION-BACKLOG-PG-${index + 1}`,
      sales_offer_id: offer.sales_offer_id,
      inventory_sku_id: sku.inventory_sku_id,
      allocation_status: "ALLOCATED",
    })),
  });
  const largeBacklog =
    await calculateCoupangInventoryVerificationProjection(mapping.mapping_id);
  assert.equal(largeBacklog.status, "PROJECTED");
  assert.equal(
    largeBacklog.pendingOrderQuantity,
    5 + largeBacklogSize - allocatedBacklogIndexes.length,
    "A large pending-order backlog was not aggregated across bounded allocation-query batches."
  );
  assert.equal(largeBacklog.expectedChannelQuantity, 0);

  const skipped = await calculateCoupangInventoryVerificationProjection(
    skippedMapping.mapping_id
  );
  assert.equal(skipped.status, "SKIPPED");
  assert.equal(skipped.pendingOrderQuantity, null);
  assert.equal(skipped.expectedChannelQuantity, null);

  console.log("Coupang inventory verification projection passed.");
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
