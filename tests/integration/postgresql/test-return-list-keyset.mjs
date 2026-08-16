import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-return-list-keyset-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function at(second) {
  return new Date(`2026-08-14T01:00:${String(second).padStart(2, "0")}.000Z`);
}

async function createActiveReturn(index, timestamp) {
  const externalOrderId = `RETURN-LIST-ORDER-${index}`;
  const externalShipmentId = `RETURN-LIST-SHIPMENT-${index}`;
  const externalReceiptId = `RETURN-LIST-RECEIPT-${index}`;
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_order_status: "INSTRUCT",
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const row = await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: externalReceiptId,
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      cancel_type: "RETURN",
      return_receipt_status: "RU",
      return_release_status: "N",
      cancel_count: 1,
      projection_revision: index,
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.coupang_return_raw_item.create({
    data: {
      coupang_return_raw_id: row.coupang_return_raw_id,
      external_receipt_id: externalReceiptId,
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      external_vendor_item_id: `RETURN-LIST-ITEM-${index}`,
      cancel_count: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  return row;
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { listBeforeShipmentReturns } = await import(
    "@/quickhack_server/returns/return-list-service"
  );

  await prisma.coupang_return_raw.createMany({
    data: Array.from({ length: 3_001 }, (_, index) => ({
      external_receipt_id: `RETURN-LIST-COMPLETED-${index}`,
      external_order_id: `RETURN-LIST-COMPLETED-ORDER-${index}`,
      cancel_type: "RETURN",
      return_receipt_status: "RETURNS_COMPLETED",
      cancel_count: 1,
      projection_revision: index + 1,
      synced_at: at(0),
      created_at: at(0),
      updated_at: at(0),
    })),
  });
  await createActiveReturn(1, at(1));
  await createActiveReturn(2, at(2));
  await createActiveReturn(3, at(2));

  const firstPage = await listBeforeShipmentReturns({ limit: 2 });
  assert(firstPage.totalCount === 3, "Completed return history polluted the active total.");
  assert(
    firstPage.items.length === 2 && firstPage.hasMore && firstPage.nextCursor,
    "The first active-return keyset page is incomplete."
  );
  assert(
    firstPage.items[0].id > firstPage.items[1].id,
    "Equal timestamps did not use the return row ID as a stable tie-breaker."
  );

  await createActiveReturn(4, new Date(Date.now() + 60_000));
  const secondPage = await listBeforeShipmentReturns({
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  const seenIds = new Set([
    ...firstPage.items.map((item) => item.id),
    ...secondPage.items.map((item) => item.id),
  ]);
  assert(secondPage.totalCount === 3, "A later insert changed the cursor snapshot total.");
  assert(
    secondPage.items.length === 1 && !secondPage.hasMore && seenIds.size === 3,
    "The second keyset page duplicated, skipped, or admitted a post-snapshot return."
  );
  assert(
    firstPage.summaryCoverage === "PAGE" &&
      secondPage.summaryCoverage === "COMPLETE",
    "Page-local summary coverage was not disclosed."
  );

  console.log("Return list eligible-first count and stable snapshot keyset verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
