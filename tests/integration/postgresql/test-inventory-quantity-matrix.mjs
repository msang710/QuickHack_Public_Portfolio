import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import {
  createInventoryCatalogFixture,
  createSellableDeviceFixtures,
} from "../../support/inventory-business-fixtures.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-inventory-quantity-matrix-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const queryService = await import(
    "@/quickhack_server/inventory/inventory-quantity-query-service"
  );
  const ledgerService = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const { todayKstDate } = await import(
    "@/quickhack_shared/core/time"
  );

  const availabilityDefaults = {
    inventoryCount: 0,
    unclassifiedInventoryCount: 0,
    unknownInventoryStatusCount: 0,
    balanceCount: 0,
    unknownBalanceStatusCount: 0,
    movementCount: 0,
    balanceQuantity: 0,
  };

  assert.equal(
    queryService.resolveInventoryLedgerAvailability(
      availabilityDefaults
    ),
    "EMPTY"
  );
  assert.equal(
    queryService.resolveInventoryLedgerAvailability({
      ...availabilityDefaults,
      inventoryCount: 2,
    }),
    "PARTIAL"
  );
  assert.equal(
    queryService.resolveInventoryLedgerAvailability({
      ...availabilityDefaults,
      inventoryCount: 2,
      balanceCount: 1,
      movementCount: 1,
      balanceQuantity: 1,
    }),
    "PARTIAL"
  );
  assert.equal(
    queryService.resolveInventoryLedgerAvailability({
      ...availabilityDefaults,
      inventoryCount: 2,
      balanceCount: 1,
      movementCount: 1,
      balanceQuantity: 2,
    }),
    "READY"
  );
  assert.equal(
    queryService.resolveInventoryLedgerAvailability({
      ...availabilityDefaults,
      inventoryCount: 1,
      unclassifiedInventoryCount: 1,
    }),
    "PARTIAL"
  );

  const businessDate = todayKstDate();
  const timestamp = new Date(`${businessDate}T00:00:00.000Z`);
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "MATRIX",
    timestamp,
  });

  await createSellableDeviceFixtures(
    prisma,
    ledgerService,
    catalog,
    { count: 1, timestamp }
  );

  const batch = await prisma.inbound_batches.create({
    data: {
      batch_date: new Date(`${businessDate}T00:00:00.000Z`),
      batch_no: 1,
      expected_quantity: 2,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.devices.create({
    data: {
      pg_no: "MATRIX-INBOUND-CLASSIFIED",
      model: catalog.options.model.label,
      storage: catalog.options.storage.label,
      color: catalog.options.color.label,
      sale_grade: catalog.options.grade.option_key,
      inventory_sku_id: catalog.sku.inventory_sku_id,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.inbounds.create({
    data: {
      pg_no: "MATRIX-INBOUND-CLASSIFIED",
      inbound_batch_id: batch.inbound_batch_id,
      inbound_status: "INSPECTING",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.devices.create({
    data: {
      pg_no: "MATRIX-INBOUND-UNCLASSIFIED",
      model: "Unclassified Model",
      storage: null,
      color: "Blue",
      sale_grade: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.inbounds.create({
    data: {
      pg_no: "MATRIX-INBOUND-UNCLASSIFIED",
      inbound_batch_id: batch.inbound_batch_id,
      inbound_status: "INSPECTED",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  const matrix =
    await queryService.getInventoryQuantityMatrix(prisma);

  assert.equal(matrix.availability, "READY");
  assert.equal(matrix.summary.skuCount, 1);
  assert.equal(matrix.summary.unclassifiedRowCount, 1);
  assert.equal(matrix.summary.sellableQuantity, 1);
  assert.equal(matrix.summary.todayOrderQuantity, 0);
  assert.equal(matrix.summary.prePurchaseQuantity, 2);
  assert.equal(matrix.summary.ledgerTotalQuantity, 1);
  assert.equal(matrix.summary.primaryTotalQuantity, 3);
  assert.equal(matrix.rows.length, 2);

  const skuRow = matrix.rows.find(
    (row) => row.rowKind === "SKU"
  );
  assert.ok(skuRow);
  assert.equal(skuRow.prePurchase.inspectingQuantity, 1);
  assert.equal(skuRow.prePurchase.inspectedQuantity, 0);
  assert.equal(
    skuRow.cells.find(
      (cell) => cell.inventoryStatus === "SELLABLE"
    )?.quantity,
    1
  );
  assert.equal(
    skuRow.cells.find(
      (cell) => cell.inventoryStatus === "PACKING"
    )?.quantity,
    0,
    "A missing ready-ledger balance must be exposed as zero."
  );

  const unclassifiedRow = matrix.rows.find(
    (row) => row.rowKind === "UNCLASSIFIED_INBOUND"
  );
  assert.ok(unclassifiedRow);
  assert.equal(unclassifiedRow.storage, "미정");
  assert.equal(unclassifiedRow.saleGrade, "미정");
  assert.equal(unclassifiedRow.prePurchase.inspectedQuantity, 1);

  assert.equal(matrix.reconciliation.businessDate, businessDate);
  assert.equal(matrix.reconciliation.mismatchedBatchQuantity, 0);
  assert.equal(matrix.reconciliation.shortageQuantity, 0);
  assert.equal(matrix.reconciliation.excessQuantity, 0);
  assert.equal(matrix.reconciliation.unassignedPgQuantity, 0);

  await prisma.inventory_quantity_balances.create({
    data: {
      inventory_sku_id: catalog.sku.inventory_sku_id,
      inventory_status: "PACKING",
      quantity: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const partial =
    await queryService.getInventoryQuantityMatrix(prisma);
  assert.equal(partial.availability, "PARTIAL");
  assert.equal(partial.summary.sellableQuantity, null);
  assert.equal(partial.summary.todayOrderQuantity, null);
  assert.equal(partial.summary.ledgerTotalQuantity, null);
  assert.equal(partial.summary.primaryTotalQuantity, null);
  assert.equal(partial.summary.prePurchaseQuantity, 2);
  assert.equal(
    partial.rows
      .flatMap((row) => row.cells)
      .every((cell) => cell.quantity === null),
    true
  );

  console.log("Inventory quantity matrix verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
