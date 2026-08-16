import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-coupang-channel-product-order-activity-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  const [prismaModule, projectionModule] = await Promise.all([
    import("../../../quickhack_server/core/prisma.ts"),
    import(
      "../../../quickhack_server/sales-channel/coupang/product-mapping-service.ts"
    ),
  ]);

  prisma = prismaModule.prisma;

  await prisma.coupang_order_raw.createMany({
    data: [
      {
        external_order_id: "ORDER-SIBLING",
        external_shipment_id: "SHIPMENT-B",
        ordered_at: new Date("2026-08-03T00:00:00.000Z"),
      },
      {
        external_order_id: "ORDER-SIBLING",
        external_shipment_id: "SHIPMENT-A",
        ordered_at: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        external_order_id: "ORDER-LATEST",
        external_shipment_id: "SHIPMENT-C",
        ordered_at: new Date("2026-08-04T00:00:00.000Z"),
      },
      {
        external_order_id: "ORDER-MISSING",
        external_shipment_id: "SHIPMENT-B",
        ordered_at: new Date("2026-08-05T00:00:00.000Z"),
      },
      {
        external_order_id: "ORDER-NULL",
        external_shipment_id: "SHIPMENT-A",
        ordered_at: null,
      },
    ],
  });

  await prisma.order_matching_work_queue.createMany({
    data: [
      {
        channel: "COUPANG",
        external_order_id: "ORDER-SIBLING",
        external_shipment_id: "SHIPMENT-A",
        external_vendor_item_id: "VENDOR-A",
      },
      {
        channel: "COUPANG",
        external_order_id: "ORDER-SIBLING",
        external_shipment_id: "SHIPMENT-B",
        external_vendor_item_id: "VENDOR-B",
      },
      {
        channel: "COUPANG",
        external_order_id: "ORDER-LATEST",
        external_shipment_id: "SHIPMENT-C",
        external_vendor_item_id: "VENDOR-A",
      },
      {
        channel: "COUPANG",
        external_order_id: "ORDER-MISSING",
        external_shipment_id: "SHIPMENT-A",
        external_vendor_item_id: "VENDOR-MISSING",
      },
      {
        channel: "COUPANG",
        external_order_id: "ORDER-NULL",
        external_shipment_id: "SHIPMENT-A",
        external_vendor_item_id: "VENDOR-NULL",
      },
    ],
  });

  const workItems = await prisma.order_matching_work_queue.findMany({
    where: { channel: "COUPANG" },
    orderBy: { work_item_id: "asc" },
  });
  const siblingItems = workItems.filter(
    (item) => item.external_order_id === "ORDER-SIBLING"
  );
  const siblingActivity =
    await projectionModule.loadCoupangVendorItemLastOrderedAt(siblingItems);

  assert.equal(
    siblingActivity.get("VENDOR-A")?.getTime(),
    new Date("2026-08-01T00:00:00.000Z").getTime(),
    "Shipment A inherited the ordered_at value from sibling shipment B."
  );
  assert.equal(
    siblingActivity.get("VENDOR-B")?.getTime(),
    new Date("2026-08-03T00:00:00.000Z").getTime(),
    "Shipment B did not retain its own ordered_at value."
  );

  const allActivity =
    await projectionModule.loadCoupangVendorItemLastOrderedAt(workItems);

  assert.equal(
    allActivity.get("VENDOR-A")?.getTime(),
    new Date("2026-08-04T00:00:00.000Z").getTime(),
    "The latest ordered_at value was not selected for a repeated vendor item."
  );
  assert.equal(
    allActivity.get("VENDOR-MISSING"),
    null,
    "A missing shipment raw row was filled from a sibling shipment."
  );
  assert.equal(
    allActivity.get("VENDOR-NULL"),
    null,
    "A null ordered_at value was not preserved as null."
  );

  console.log(
    "Coupang channel-product order activity remains isolated by order and shipment."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
