import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { SUPPLY_REORDER_STATUS } from "../../../quickhack_shared/supplies/supplies.ts";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-supplies-reorder-receipt-integrity-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { updateSupplyReorderRequest } = await import(
    "@/quickhack_server/supplies/supplies-service"
  );

  const userRow = await prisma.users.create({
    data: {
      username: "supply-reorder-receipt-test",
      password_hash: "test",
      role: "STAFF",
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "Supply reorder receipt test",
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  async function createSupply(code, currentQuantity) {
    return prisma.supplies.create({
      data: {
        supply_code: code,
        supply_name: code,
        updated_by_user_id: user.userId,
        inventory: {
          create: {
            current_quantity: currentQuantity,
            reserved_quantity: 0,
          },
        },
      },
    });
  }

  async function createOrderedReorder(supplyId, quantity) {
    return prisma.supply_reorder_requests.create({
      data: {
        supply_id: supplyId,
        request_status: SUPPLY_REORDER_STATUS.ordered,
        recommended_quantity: quantity,
        requested_quantity: quantity,
        ordered_quantity: quantity,
        created_by_user_id: user.userId,
      },
    });
  }

  function reorderUpdateInput(
    reorderRequestId,
    requestStatus,
    receivedQuantity,
    expectedRequestStatus = SUPPLY_REORDER_STATUS.ordered,
    expectedRevision = 0
  ) {
    return {
      reorderRequestId,
      requestStatus,
      expectedRequestStatus,
      expectedRevision,
      requestedQuantity: 5,
      orderedQuantity: 5,
      receivedQuantity,
      expectedUnitCost: "",
      supplierName: "",
      reason: "",
    };
  }

  const supply = await createSupply("REORDER_RECEIPT", 10);
  const reorder = await createOrderedReorder(supply.supply_id, 5);
  const receiptKey = `supply:reorder:${reorder.reorder_request_id}:receipt`;

  const received = await updateSupplyReorderRequest(
    prisma,
    reorderUpdateInput(
      reorder.reorder_request_id,
      SUPPLY_REORDER_STATUS.received,
      5
    ),
    user
  );
  assert.equal(received.request_status, SUPPLY_REORDER_STATUS.received);
  assert.equal(received.received_quantity, 5);
  assert.ok(received.received_at);

  const inventoryAfterReceipt = await prisma.supply_inventory.findUniqueOrThrow({
    where: { supply_id: supply.supply_id },
  });
  assert.equal(inventoryAfterReceipt.current_quantity, 15);

  const receiptMovement = await prisma.supply_stock_movements.findUniqueOrThrow({
    where: { idempotency_key: receiptKey },
  });
  assert.equal(receiptMovement.source_type, "SUPPLY_REORDER");
  assert.equal(receiptMovement.source_id, String(reorder.reorder_request_id));
  assert.equal(receiptMovement.quantity, 5);

  await updateSupplyReorderRequest(
    prisma,
    reorderUpdateInput(
      reorder.reorder_request_id,
      SUPPLY_REORDER_STATUS.received,
      5
    ),
    user
  );
  assert.equal(
    await prisma.supply_stock_movements.count({
      where: { idempotency_key: receiptKey },
    }),
    1
  );
  assert.equal(
    (
      await prisma.supply_inventory.findUniqueOrThrow({
        where: { supply_id: supply.supply_id },
      })
    ).current_quantity,
    15
  );

  await assert.rejects(
    updateSupplyReorderRequest(
      prisma,
      reorderUpdateInput(
        reorder.reorder_request_id,
        SUPPLY_REORDER_STATUS.received,
        6
      ),
      user
    ),
    (error) => error?.code === "SUPPLY_REORDER_RECEIPT_FINALIZED"
  );
  await assert.rejects(
    updateSupplyReorderRequest(
      prisma,
      reorderUpdateInput(
        reorder.reorder_request_id,
        SUPPLY_REORDER_STATUS.cancelled,
        5
      ),
      user
    ),
    (error) => error?.code === "SUPPLY_REORDER_RECEIPT_FINALIZED"
  );
  await assert.rejects(
    updateSupplyReorderRequest(
      prisma,
      reorderUpdateInput(
        reorder.reorder_request_id,
        SUPPLY_REORDER_STATUS.approved,
        5
      ),
      user
    ),
    (error) => error?.code === "SUPPLY_REORDER_RECEIPT_FINALIZED"
  );
  const receiptAfterStaleUpdate =
    await prisma.supply_reorder_requests.findUniqueOrThrow({
      where: { reorder_request_id: reorder.reorder_request_id },
    });
  assert.equal(
    receiptAfterStaleUpdate.request_status,
    SUPPLY_REORDER_STATUS.received
  );
  assert.equal(receiptAfterStaleUpdate.received_quantity, 5);

  const cancelledSupply = await createSupply("REORDER_STALE_RECEIPT", 4);
  const cancelledReorder = await createOrderedReorder(
    cancelledSupply.supply_id,
    5
  );
  await updateSupplyReorderRequest(
    prisma,
    reorderUpdateInput(
      cancelledReorder.reorder_request_id,
      SUPPLY_REORDER_STATUS.cancelled,
      ""
    ),
    user
  );
  await assert.rejects(
    updateSupplyReorderRequest(
      prisma,
      reorderUpdateInput(
        cancelledReorder.reorder_request_id,
        SUPPLY_REORDER_STATUS.received,
        5
      ),
      user
    ),
    (error) => error?.code === "SUPPLY_REORDER_STALE_STATE"
  );
  assert.equal(
    (
      await prisma.supply_reorder_requests.findUniqueOrThrow({
        where: {
          reorder_request_id: cancelledReorder.reorder_request_id,
        },
      })
    ).request_status,
    SUPPLY_REORDER_STATUS.cancelled
  );
  assert.equal(
    (
      await prisma.supply_inventory.findUniqueOrThrow({
        where: { supply_id: cancelledSupply.supply_id },
      })
    ).current_quantity,
    4
  );
  assert.equal(
    await prisma.supply_stock_movements.count({
      where: {
        source_type: "SUPPLY_REORDER",
        source_id: String(cancelledReorder.reorder_request_id),
      },
    }),
    0
  );

  const competingSupply = await createSupply("REORDER_COMPETING_STATE", 20);
  const competingReorder = await createOrderedReorder(
    competingSupply.supply_id,
    5
  );
  const competingResults = await Promise.allSettled([
    updateSupplyReorderRequest(
      prisma,
      reorderUpdateInput(
        competingReorder.reorder_request_id,
        SUPPLY_REORDER_STATUS.received,
        5
      ),
      user
    ),
    updateSupplyReorderRequest(
      prisma,
      reorderUpdateInput(
        competingReorder.reorder_request_id,
        SUPPLY_REORDER_STATUS.approved,
        ""
      ),
      user
    ),
  ]);
  assert.equal(
    competingResults.filter((result) => result.status === "fulfilled").length,
    1,
    "Competing reorder transitions both committed."
  );
  const competingRejected = competingResults.find(
    (result) => result.status === "rejected"
  );
  assert.ok(
    competingRejected?.status === "rejected" &&
      [
        "SUPPLY_REORDER_STATE_CHANGED",
        "SUPPLY_REORDER_RECEIPT_FINALIZED",
        "SUPPLY_REORDER_STALE_STATE",
      ].includes(competingRejected.reason?.code)
  );
  const competingStored =
    await prisma.supply_reorder_requests.findUniqueOrThrow({
      where: { reorder_request_id: competingReorder.reorder_request_id },
    });
  const competingInventory = await prisma.supply_inventory.findUniqueOrThrow({
    where: { supply_id: competingSupply.supply_id },
  });
  const competingMovementCount = await prisma.supply_stock_movements.count({
    where: {
      source_type: "SUPPLY_REORDER",
      source_id: String(competingReorder.reorder_request_id),
    },
  });
  if (competingStored.request_status === SUPPLY_REORDER_STATUS.received) {
    assert.equal(competingInventory.current_quantity, 25);
    assert.equal(competingMovementCount, 1);
  } else {
    assert.equal(competingStored.request_status, SUPPLY_REORDER_STATUS.approved);
    assert.equal(competingInventory.current_quantity, 20);
    assert.equal(competingMovementCount, 0);
  }
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: {
        action_type: "SUPPLY_REORDER_UPDATE",
        target_id: String(competingReorder.reorder_request_id),
      },
    }),
    1
  );

  await prisma.supply_reorder_requests.update({
    where: { reorder_request_id: reorder.reorder_request_id },
    data: { request_status: SUPPLY_REORDER_STATUS.ordered },
  });
  await updateSupplyReorderRequest(
    prisma,
    reorderUpdateInput(
      reorder.reorder_request_id,
      SUPPLY_REORDER_STATUS.received,
      5,
      SUPPLY_REORDER_STATUS.ordered,
      received.revision
    ),
    user
  );
  assert.equal(
    await prisma.supply_stock_movements.count({
      where: { idempotency_key: receiptKey },
    }),
    1,
    "Re-entering RECEIVED created another movement."
  );
  assert.equal(
    (
      await prisma.supply_inventory.findUniqueOrThrow({
        where: { supply_id: supply.supply_id },
      })
    ).current_quantity,
    15
  );

  const reorderedAfterReplay = await prisma.supply_reorder_requests.update({
    where: { reorder_request_id: reorder.reorder_request_id },
    data: { request_status: SUPPLY_REORDER_STATUS.ordered },
  });
  await assert.rejects(
    updateSupplyReorderRequest(
      prisma,
      reorderUpdateInput(
        reorder.reorder_request_id,
        SUPPLY_REORDER_STATUS.received,
        6,
        SUPPLY_REORDER_STATUS.ordered,
        reorderedAfterReplay.revision
      ),
      user
    ),
    (error) => error?.code === "SUPPLY_MOVEMENT_IDEMPOTENCY_CONFLICT"
  );
  const conflictingRetry =
    await prisma.supply_reorder_requests.findUniqueOrThrow({
      where: { reorder_request_id: reorder.reorder_request_id },
    });
  assert.equal(conflictingRetry.request_status, SUPPLY_REORDER_STATUS.ordered);
  assert.equal(conflictingRetry.received_quantity, 5);
  assert.equal(
    (
      await prisma.supply_inventory.findUniqueOrThrow({
        where: { supply_id: supply.supply_id },
      })
    ).current_quantity,
    15
  );

  const missingQuantitySupply = await createSupply("REORDER_RECEIPT_REQUIRED", 3);
  const missingQuantityReorder = await createOrderedReorder(
    missingQuantitySupply.supply_id,
    2
  );
  await assert.rejects(
    updateSupplyReorderRequest(
      prisma,
      reorderUpdateInput(
        missingQuantityReorder.reorder_request_id,
        SUPPLY_REORDER_STATUS.received,
        ""
      ),
      user
    ),
    (error) => error?.code === "SUPPLY_REORDER_RECEIVED_QUANTITY_REQUIRED"
  );

  const unchangedMissingQuantityReorder =
    await prisma.supply_reorder_requests.findUniqueOrThrow({
      where: {
        reorder_request_id: missingQuantityReorder.reorder_request_id,
      },
    });
  assert.equal(
    unchangedMissingQuantityReorder.request_status,
    SUPPLY_REORDER_STATUS.ordered
  );
  assert.equal(
    (
      await prisma.supply_inventory.findUniqueOrThrow({
        where: { supply_id: missingQuantitySupply.supply_id },
      })
    ).current_quantity,
    3
  );

  console.log("Supply reorder receipt integrity verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
