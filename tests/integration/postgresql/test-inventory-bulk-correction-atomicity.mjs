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
  "quickhack-inventory-bulk-correction-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function inventoryCorrectionItem(inventory, inventoryStatus, location) {
  return {
    pgNo: inventory.pg_no,
    patches: [
      {
        recordKind: "inventory",
        recordId: inventory.inventory_id,
        expectedRevision: inventory.revision,
        fieldKey: "inventory_status",
        expectedValue: inventory.inventory_status,
        nextValue: inventoryStatus,
      },
      {
        recordKind: "inventory",
        recordId: inventory.inventory_id,
        expectedRevision: inventory.revision,
        fieldKey: "location",
        expectedValue: inventory.location,
        nextValue: location,
      },
    ],
  };
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const ledgerService = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const { updateExistingInventoryRecordsAtomically } = await import(
    "@/quickhack_server/inventory/inventory-correction-command-service"
  );

  const timestamp = new Date("2026-08-01T09:00:00+09:00");
  const databaseUser = await prisma.users.create({
    data: {
      username: "inventory-bulk-correction-test",
      password_hash: "integration-test-only",
      role: "MANAGER",
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const user = {
    userId: databaseUser.user_id,
    username: databaseUser.username,
    displayName: "Inventory correction tester",
    role: "MANAGER",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "ATOMIC",
    timestamp,
  });
  const devices = await createSellableDeviceFixtures(
    prisma,
    ledgerService,
    catalog,
    { count: 2, timestamp }
  );
  const inventories = await prisma.inventory.findMany({
    where: { pg_no: { in: devices.map((device) => device.pgNo) } },
    orderBy: { pg_no: "asc" },
  });
  const initialMovementCount =
    await prisma.inventory_quantity_movements.count();

  await assert.rejects(
    updateExistingInventoryRecordsAtomically(
      prisma,
      [
        inventoryCorrectionItem(inventories[0], "HOLD", "ATOMIC-HOLD-1"),
        {
          pgNo: "ZZZ-MISSING-PG",
          patches: [
            {
              recordKind: "inventory",
              recordId: inventories[0].inventory_id,
              expectedRevision: inventories[0].revision,
              fieldKey: "location",
              expectedValue: inventories[0].location,
              nextValue: "MISSING",
            },
          ],
        },
      ],
      "Atomic rollback verification",
      user
    ),
    (error) => error?.code === "INVENTORY_NOT_FOUND"
  );

  const rolledBackInventories = await prisma.inventory.findMany({
    where: { pg_no: { in: devices.map((device) => device.pgNo) } },
    orderBy: { pg_no: "asc" },
  });
  assert.deepEqual(
    rolledBackInventories.map((inventory) => ({
      status: inventory.inventory_status,
      location: inventory.location,
    })),
    [
      { status: "SELLABLE", location: "INTEGRATION_TEST" },
      { status: "SELLABLE", location: "INTEGRATION_TEST" },
    ],
    "A later failure must roll back earlier inventory updates."
  );
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: { action_type: "INVENTORY_CORRECTION" },
    }),
    0,
    "Rolled-back corrections must not leave activity logs."
  );
  assert.equal(
    await prisma.inventory_quantity_movements.count(),
    initialMovementCount,
    "Rolled-back corrections must not leave quantity ledger movements."
  );

  const successResult = await updateExistingInventoryRecordsAtomically(
    prisma,
    inventories.map((inventory, index) =>
      inventoryCorrectionItem(
        inventory,
        "HOLD",
        `ATOMIC-HOLD-${index + 1}`
      )
    ),
    "Atomic commit verification",
    user
  );

  assert.equal(successResult.updatedCount, 2);
  assert.deepEqual(successResult.pgNos, devices.map((device) => device.pgNo));
  assert.deepEqual(
    (
      await prisma.inventory.findMany({
        where: { pg_no: { in: devices.map((device) => device.pgNo) } },
        orderBy: { pg_no: "asc" },
      })
    ).map((inventory) => ({
      status: inventory.inventory_status,
      location: inventory.location,
    })),
    [
      { status: "HOLD", location: "ATOMIC-HOLD-1" },
      { status: "HOLD", location: "ATOMIC-HOLD-2" },
    ]
  );
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: { action_type: "INVENTORY_CORRECTION" },
    }),
    2
  );
  assert.ok(
    (await prisma.inventory_quantity_movements.count()) > initialMovementCount
  );
  const committedInventories = await prisma.inventory.findMany({
    where: { pg_no: { in: devices.map((device) => device.pgNo) } },
    orderBy: { pg_no: "asc" },
  });
  const committedActivityCount = await prisma.employee_activity_logs.count({
    where: { action_type: "INVENTORY_CORRECTION" },
  });
  const committedMovementCount = await prisma.inventory_quantity_movements.count();

  await assert.rejects(
    updateExistingInventoryRecordsAtomically(
      prisma,
      [inventoryCorrectionItem(inventories[0], "DEFECTIVE", "STALE-WRITE")],
      "Stale revision verification",
      user
    ),
    (error) => error?.code === "INVENTORY_CORRECTION_STALE_RECORD"
  );
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: { action_type: "INVENTORY_CORRECTION" },
    }),
    committedActivityCount
  );
  assert.equal(
    await prisma.inventory_quantity_movements.count(),
    committedMovementCount
  );

  const firstDevice = await prisma.devices.findUniqueOrThrow({
    where: { pg_no: devices[0].pgNo },
  });
  await assert.rejects(
    updateExistingInventoryRecordsAtomically(
      prisma,
      [
        {
          pgNo: firstDevice.pg_no,
          patches: [
            {
              recordKind: "device",
              recordId: firstDevice.device_id,
              expectedRevision: firstDevice.revision,
              fieldKey: "imei",
              expectedValue: firstDevice.imei,
              nextValue: "123-456-789",
            },
          ],
        },
      ],
      "Strict IMEI verification",
      user
    ),
    (error) => error?.code === "INVENTORY_CORRECTION_INPUT_INVALID"
  );
  assert.equal(
    (
      await prisma.devices.findUniqueOrThrow({
        where: { pg_no: firstDevice.pg_no },
      })
    ).imei,
    firstDevice.imei
  );

  const overlongLocation = "X".repeat(2_001);
  await assert.rejects(
    updateExistingInventoryRecordsAtomically(
      prisma,
      [
        {
          pgNo: committedInventories[0].pg_no,
          patches: [
            {
              recordKind: "inventory",
              recordId: committedInventories[0].inventory_id,
              expectedRevision: committedInventories[0].revision,
              fieldKey: "location",
              expectedValue: committedInventories[0].location,
              nextValue: overlongLocation,
            },
          ],
        },
      ],
      "Audit rollback verification",
      user
    ),
    (error) => error?.code === "DOMAIN_AUDIT_CONTRACT_INVALID"
  );
  const afterAuditFailure = await prisma.inventory.findUniqueOrThrow({
    where: { inventory_id: committedInventories[0].inventory_id },
  });
  assert.equal(afterAuditFailure.location, committedInventories[0].location);
  assert.equal(afterAuditFailure.revision, committedInventories[0].revision);
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: { action_type: "INVENTORY_CORRECTION" },
    }),
    committedActivityCount,
    "An audit failure committed an employee activity parent."
  );

  const domainEvents = await prisma.domain_audit_events.findMany({
    where: { event_type: "INVENTORY_CORRECTION" },
    include: { changes: { orderBy: { field_path: "asc" } } },
    orderBy: { aggregate_id: "asc" },
  });
  assert.equal(domainEvents.length, 2);
  assert.deepEqual(
    domainEvents.map((event) => event.changes.map((change) => change.field_path)),
    [
      ["inventory.location", "inventory.status"],
      ["inventory.location", "inventory.status"],
    ],
    "Canonical correction audit paths did not match the committed fields."
  );

  const lifecycleInbound = await prisma.inbounds.create({
    data: {
      pg_no: firstDevice.pg_no,
      inbound_status: "INSPECTED",
      received_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const lifecycleAppearance = await prisma.inspections.create({
    data: {
      pg_no: firstDevice.pg_no,
      inbound_id: lifecycleInbound.inbound_id,
      inspection_type: "APPEARANCE",
      appearance_grade: "A",
      appearance_checked_at: timestamp,
      checked_at: timestamp,
      return_yn: "N",
      created_at: timestamp,
    },
  });
  await prisma.inspections.create({
    data: {
      pg_no: firstDevice.pg_no,
      inbound_id: lifecycleInbound.inbound_id,
      inspection_type: "FUNCTION",
      function_defect: "없음",
      function_checked_at: timestamp,
      checked_at: timestamp,
      return_yn: "N",
      created_at: timestamp,
    },
  });
  await updateExistingInventoryRecordsAtomically(
    prisma,
    [
      {
        pgNo: firstDevice.pg_no,
        patches: [
          {
            recordKind: "inspection",
            recordId: lifecycleAppearance.inspection_id,
            expectedRevision: lifecycleAppearance.revision,
            fieldKey: "return_yn",
            expectedValue: "N",
            nextValue: "Y",
          },
        ],
      },
    ],
    "Lifecycle projection verification",
    user
  );
  const supplierReturnInbound = await prisma.inbounds.findUniqueOrThrow({
    where: { inbound_id: lifecycleInbound.inbound_id },
  });
  assert.equal(supplierReturnInbound.inbound_status, "SUPPLIER_RETURN");
  assert.ok(supplierReturnInbound.supplier_returned_at);

  await prisma.inbounds.update({
    where: { inbound_id: lifecycleInbound.inbound_id },
    data: { inbound_status: "PURCHASED", revision: { increment: 1 } },
  });
  const correctedAppearance = await prisma.inspections.findUniqueOrThrow({
    where: { inspection_id: lifecycleAppearance.inspection_id },
  });
  await updateExistingInventoryRecordsAtomically(
    prisma,
    [
      {
        pgNo: firstDevice.pg_no,
        patches: [
          {
            recordKind: "inspection",
            recordId: correctedAppearance.inspection_id,
            expectedRevision: correctedAppearance.revision,
            fieldKey: "return_yn",
            expectedValue: "Y",
            nextValue: "N",
          },
        ],
      },
    ],
    "Purchased lifecycle terminal verification",
    user
  );
  assert.equal(
    (
      await prisma.inbounds.findUniqueOrThrow({
        where: { inbound_id: lifecycleInbound.inbound_id },
      })
    ).inbound_status,
    "PURCHASED",
    "Inspection correction regressed the purchased terminal state."
  );

  console.log("Inventory bulk correction atomicity verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
