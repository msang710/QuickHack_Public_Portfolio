import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { SUPPLY_MOVEMENT_TYPE } from "../../../quickhack_shared/supplies/supplies.ts";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-supplies-movement-command-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { recordSupplyMovement } = await import(
    "@/quickhack_server/supplies/supplies-service"
  );

  const userRow = await prisma.users.create({
    data: {
      username: "supply-movement-command-test",
      password_hash: "test",
      role: "STAFF",
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "Supply movement command test",
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  async function createSupply(code, currentQuantity = 10) {
    const supply = await prisma.supplies.create({
      data: { supply_code: code, supply_name: code },
    });
    await prisma.supply_inventory.create({
      data: { supply_id: supply.supply_id, current_quantity: currentQuantity },
    });
    return supply;
  }

  const supply = await createSupply("MOVEMENT_TARGET_REPLAY");
  const operationId = "supply:movement:test-target-8";
  const targetEight = {
    supplyId: supply.supply_id,
    movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
    quantity: 8,
    reason: " monthly count ",
    sourceType: "MANUAL_COUNT",
    sourceId: "count-1",
    idempotencyKey: operationId,
  };

  const first = await recordSupplyMovement(prisma, targetEight, user);
  assert.equal(first.observed, false);
  assert.equal(first.operationId, operationId);
  assert.equal(first.movement.before_quantity, 10);
  assert.equal(first.movement.after_quantity, 8);
  assert.equal(first.movement.quantity, 2);

  const replay = await recordSupplyMovement(
    prisma,
    { ...targetEight, quantity: "08", reason: "monthly count" },
    user
  );
  assert.equal(replay.observed, true);
  assert.equal(replay.movement.movement_id, first.movement.movement_id);
  assert.equal(
    await prisma.supply_stock_movements.count({
      where: { idempotency_key: operationId },
    }),
    1
  );
  assert.equal(
    (
      await prisma.supply_inventory.findUniqueOrThrow({
        where: { supply_id: supply.supply_id },
      })
    ).current_quantity,
    8
  );
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: {
        action_type: "SUPPLY_STOCK_MOVEMENT",
        target_id: String(supply.supply_id),
      },
    }),
    1
  );

  await assert.rejects(
    recordSupplyMovement(
      prisma,
      { ...targetEight, quantity: 7 },
      user
    ),
    (error) => error?.code === "SUPPLY_MOVEMENT_IDEMPOTENCY_CONFLICT"
  );
  await assert.rejects(
    recordSupplyMovement(
      prisma,
      { ...targetEight, reason: "different count reason" },
      user
    ),
    (error) => error?.code === "SUPPLY_MOVEMENT_IDEMPOTENCY_CONFLICT"
  );

  const zero = await recordSupplyMovement(
    prisma,
    {
      supplyId: supply.supply_id,
      movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
      quantity: 0,
      reason: "empty shelf count",
      idempotencyKey: "supply:movement:test-target-0",
    },
    user
  );
  assert.equal(zero.observed, false);
  assert.equal(zero.movement.before_quantity, 8);
  assert.equal(zero.movement.after_quantity, 0);
  assert.equal(zero.movement.quantity, 8);

  for (const [input, expectedCode] of [
    [
      {
        supplyId: supply.supply_id,
        movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
        quantity: -1,
        idempotencyKey: "supply:movement:test-negative",
      },
      "INVALID_SUPPLY_NON_NEGATIVE_INTEGER",
    ],
    [
      {
        supplyId: supply.supply_id,
        movementType: SUPPLY_MOVEMENT_TYPE.inbound,
        quantity: 1,
      },
      "SUPPLY_MOVEMENT_OPERATION_ID_REQUIRED",
    ],
    [
      {
        supplyId: supply.supply_id,
        movementType: SUPPLY_MOVEMENT_TYPE.inbound,
        quantity: 0,
        idempotencyKey: "supply:movement:test-positive-zero",
      },
      "INVALID_SUPPLY_POSITIVE_INTEGER",
    ],
    [
      {
        supplyId: supply.supply_id,
        movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
        quantity: " ",
        idempotencyKey: "supply:movement:test-blank-target",
      },
      "INVALID_SUPPLY_NON_NEGATIVE_INTEGER",
    ],
    [
      {
        supplyId: supply.supply_id,
        movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
        quantity: 0,
        idempotencyKey: "customer@example.com",
      },
      "INVALID_SUPPLY_MOVEMENT_OPERATION_ID",
    ],
    [
      {
        supplyId: supply.supply_id,
        movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
        quantity: 0,
        allocationId: -1,
        idempotencyKey: "supply:movement:test-invalid-reference",
      },
      "INVALID_SUPPLY_MOVEMENT_REFERENCE_ID",
    ],
  ]) {
    await assert.rejects(
      recordSupplyMovement(prisma, input, user),
      (error) => error?.code === expectedCode
    );
  }
  assert.equal(
    (
      await prisma.supply_inventory.findUniqueOrThrow({
        where: { supply_id: supply.supply_id },
      })
    ).current_quantity,
    0
  );

  const concurrentSupply = await createSupply("MOVEMENT_CONCURRENT_REPLAY");
  const concurrentCommand = {
    supplyId: concurrentSupply.supply_id,
    movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
    quantity: 8,
    reason: "concurrent count",
    idempotencyKey: "supply:movement:test-concurrent",
  };
  const concurrentResults = await Promise.all([
    recordSupplyMovement(prisma, concurrentCommand, user),
    recordSupplyMovement(prisma, concurrentCommand, user),
  ]);
  assert.deepEqual(
    concurrentResults.map((result) => result.observed).sort(),
    [false, true]
  );
  assert.equal(
    new Set(concurrentResults.map((result) => result.movement.movement_id)).size,
    1
  );
  assert.equal(
    await prisma.supply_stock_movements.count({
      where: { supply_id: concurrentSupply.supply_id },
    }),
    1
  );
  assert.equal(
    (
      await prisma.supply_inventory.findUniqueOrThrow({
        where: { supply_id: concurrentSupply.supply_id },
      })
    ).current_quantity,
    8
  );
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: {
        action_type: "SUPPLY_STOCK_MOVEMENT",
        target_id: String(concurrentSupply.supply_id),
      },
    }),
    1
  );

  console.log(
    "Supply movement exact-target, canonical replay, zero, and concurrency contracts verified."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
