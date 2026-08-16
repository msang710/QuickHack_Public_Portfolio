import assert from "node:assert/strict";
import { loadInventoryStatisticsInput } from "@/quickhack_server/statistics/inventory-statistics-service";
import { createPostgresqlPrismaClient } from "@/quickhack_server/core/database/postgresql-client";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-statistics-loader-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
let prisma;

try {
  ({ client: prisma } = createPostgresqlPrismaClient({
    connectionString: temporaryDatabase.databaseUrl,
    applicationName: "quickhack-statistics-loader-test",
  }));
  const devices = Array.from({ length: 1_030 }, (_, index) => ({
    pg_no: `STAT-PG-${String(index + 1).padStart(5, "0")}`,
    model: "STATISTICS-LOAD-TEST",
  }));
  await prisma.devices.createMany({ data: devices });
  await prisma.inventory.createMany({
    data: devices.map((device) => ({
      pg_no: device.pg_no,
      inventory_status: "SELLABLE",
    })),
  });

  const input = await loadInventoryStatisticsInput(prisma);
  assert.equal(input.inventory.length, 1_030);
  assert.equal(input.balances.length, 0);
  assert.equal(input.movementCount, 0);
  assert.deepEqual(input.movements, []);
  assert.deepEqual(input.sales, []);
  assert.equal(input.inventory[0]?.pgNo, "STAT-PG-00001");
  assert.equal(input.inventory.at(-1)?.pgNo, "STAT-PG-01030");
  console.log(
    "Statistics PostgreSQL loader verified with 1,030 related inventory rows."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
