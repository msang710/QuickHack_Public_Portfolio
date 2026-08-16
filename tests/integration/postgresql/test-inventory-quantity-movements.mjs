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
  "quickhack-inventory-quantity-movements-"
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

  assert.deepEqual(
    queryService.normalizeInventoryQuantityMovementPageInput({
      balanceId: "9",
    }),
    { balanceId: 9, cursor: undefined, limit: 50 }
  );
  assert.equal(
    queryService.normalizeInventoryQuantityMovementPageInput({
      balanceId: 9,
      limit: 500,
    }).limit,
    100
  );
  assert.throws(
    () =>
      queryService.normalizeInventoryQuantityMovementPageInput({
        balanceId: 0,
      }),
    queryService.InventoryQuantityQueryInputError
  );
  assert.throws(
    () =>
      queryService.normalizeInventoryQuantityMovementPageInput({
        balanceId: 1,
        cursor: "1.5",
      }),
    queryService.InventoryQuantityQueryInputError
  );
  assert.throws(
    () =>
      queryService.normalizeInventoryQuantityMovementPageInput({
        balanceId: 1,
        limit: "-2",
      }),
    queryService.InventoryQuantityQueryInputError
  );

  const timestamp = "2026-07-26 10:00:00";
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "MOVEMENT",
    timestamp,
  });
  await createSellableDeviceFixtures(
    prisma,
    ledgerService,
    catalog,
    { count: 3, timestamp }
  );
  const balance =
    await prisma.inventory_quantity_balances.findUniqueOrThrow({
      where: {
        inventory_sku_id_inventory_status: {
          inventory_sku_id: catalog.sku.inventory_sku_id,
          inventory_status: "SELLABLE",
        },
      },
    });

  const firstPage =
    await queryService.getInventoryQuantityMovements(prisma, {
      balanceId: balance.inventory_quantity_balance_id,
      limit: 2,
    });
  assert.ok(firstPage);
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.nextCursor, firstPage.items[1].movementId);
  assert.equal(
    firstPage.items[0].movementId > firstPage.items[1].movementId,
    true
  );

  const secondPage =
    await queryService.getInventoryQuantityMovements(prisma, {
      balanceId: balance.inventory_quantity_balance_id,
      cursor: firstPage.nextCursor,
      limit: 2,
    });
  assert.ok(secondPage);
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(
    secondPage.items[0].movementId < firstPage.nextCursor,
    true
  );
  assert.equal(
    new Set(
      [...firstPage.items, ...secondPage.items].map(
        (item) => item.movementId
      )
    ).size,
    3,
    "Cursor pages must not overlap."
  );

  const missing =
    await queryService.getInventoryQuantityMovements(prisma, {
      balanceId: 999999,
    });
  assert.equal(missing, null);

  console.log("Inventory quantity movement pagination verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
