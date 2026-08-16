import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import {
  SUPPLY_CONSUMPTION_TRIGGER,
  SUPPLY_MOVEMENT_TYPE,
  SUPPLY_REORDER_STATUS,
} from "../../../quickhack_shared/supplies/supplies.ts";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-supplies-convergence-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    getSupplyWorkspaceData,
    recordSupplyMovement,
    saveSupply,
    saveSupplyConsumptionRule,
    updateSupplyReorderRequest,
  } = await import("@/quickhack_server/supplies/supplies-service");

  const userRow = await prisma.users.create({
    data: {
      username: "supply-convergence-test",
      password_hash: "test",
      role: "STAFF",
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "Supply convergence test",
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  const created = await saveSupply(
    prisma,
    {
      supplyCode: "SUPPLY_AGGREGATE",
      supplyName: "Aggregate supply",
      baseUnit: "개",
      orderUnitQuantity: 1,
      reservedQuantity: 1,
      inventoryLocation: "A-01",
    },
    user
  );
  assert.equal(created.revision, 0);

  const updated = await saveSupply(
    prisma,
    {
      supplyId: created.supply_id,
      expectedRevision: created.revision,
      supplyCode: created.supply_code,
      supplyName: "Aggregate supply updated",
      baseUnit: "개",
      orderUnitQuantity: 1,
      reservedQuantity: 2,
      inventoryLocation: "A-02",
    },
    user
  );
  assert.equal(updated.revision, 1);
  await assert.rejects(
    saveSupply(
      prisma,
      {
        supplyId: created.supply_id,
        expectedRevision: 0,
        supplyCode: created.supply_code,
        supplyName: "stale overwrite",
        baseUnit: "개",
        orderUnitQuantity: 1,
        reservedQuantity: 0,
      },
      user
    ),
    (error) => error?.code === "SUPPLY_MASTER_STALE_STATE"
  );

  const updateLogCount = await prisma.employee_activity_logs.count({
    where: { action_type: "SUPPLY_UPDATE", target_id: String(created.supply_id) },
  });
  const noOp = await saveSupply(
    prisma,
    {
      supplyId: created.supply_id,
      expectedRevision: updated.revision,
      supplyCode: created.supply_code,
      supplyName: "Aggregate supply updated",
      baseUnit: "개",
      orderUnitQuantity: 1,
      reservedQuantity: 2,
      inventoryLocation: "A-02",
    },
    user
  );
  assert.equal(noOp.revision, updated.revision);
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: { action_type: "SUPPLY_UPDATE", target_id: String(created.supply_id) },
    }),
    updateLogCount,
    "A no-op supply save created another audit event."
  );

  const updateLog = await prisma.employee_activity_logs.findFirstOrThrow({
    where: { action_type: "SUPPLY_UPDATE", target_id: String(created.supply_id) },
    orderBy: { id: "desc" },
    include: { changes: true },
  });
  const updateFields = new Set(updateLog.changes.map((change) => change.field_name));
  assert(updateFields.has("supply.supplyName"));
  assert(updateFields.has("inventorySettings.reservedQuantity"));
  assert(updateFields.has("inventorySettings.inventoryLocation"));

  const overlapSupply = await prisma.supplies.create({
    data: { supply_code: "SUPPLY_OVERLAP", supply_name: "Overlap supply" },
  });
  const overlapping = await Promise.allSettled([
    saveSupplyConsumptionRule(
      prisma,
      {
        supplyId: overlapSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
        quantityPerUnit: 1,
        model: "MODEL-A",
      },
      user
    ),
    saveSupplyConsumptionRule(
      prisma,
      {
        supplyId: overlapSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
        quantityPerUnit: 1,
      },
      user
    ),
  ]);
  assert.equal(overlapping.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    overlapping.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason?.code === "SUPPLY_CONSUMPTION_RULE_OVERLAP"
    ).length,
    1
  );

  const disjointSupply = await prisma.supplies.create({
    data: { supply_code: "SUPPLY_DISJOINT", supply_name: "Disjoint supply" },
  });
  const disjoint = await Promise.all([
    saveSupplyConsumptionRule(
      prisma,
      {
        supplyId: disjointSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
        quantityPerUnit: 1,
        model: "MODEL-A",
      },
      user
    ),
    saveSupplyConsumptionRule(
      prisma,
      {
        supplyId: disjointSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
        quantityPerUnit: 1,
        model: "MODEL-B",
      },
      user
    ),
  ]);
  assert.equal(disjoint.length, 2);

  const ruleSupply = await prisma.supplies.create({
    data: { supply_code: "SUPPLY_RULE_CAS", supply_name: "Rule CAS supply" },
  });
  const rule = await saveSupplyConsumptionRule(
    prisma,
    {
      supplyId: ruleSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 1,
      model: "MODEL-A",
    },
    user
  );
  const changedRule = await saveSupplyConsumptionRule(
    prisma,
    {
      ruleId: rule.rule_id,
      expectedRevision: rule.revision,
      supplyId: ruleSupply.supply_id,
      triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
      quantityPerUnit: 2,
      model: "MODEL-A",
    },
    user
  );
  assert.equal(changedRule.revision, 1);
  await assert.rejects(
    saveSupplyConsumptionRule(
      prisma,
      {
        ruleId: rule.rule_id,
        expectedRevision: rule.revision,
        supplyId: ruleSupply.supply_id,
        triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
        quantityPerUnit: 9,
        model: "MODEL-A",
      },
      user
    ),
    (error) => error?.code === "SUPPLY_CONSUMPTION_RULE_STALE_STATE"
  );

  await recordSupplyMovement(
    prisma,
    {
      supplyId: created.supply_id,
      movementType: SUPPLY_MOVEMENT_TYPE.inbound,
      quantity: 3,
      reason: "audit convergence",
      sourceType: "TEST",
      sourceId: "movement-1",
    },
    user
  );
  const movementLog = await prisma.employee_activity_logs.findFirstOrThrow({
    where: {
      action_type: "SUPPLY_STOCK_MOVEMENT",
      target_id: String(created.supply_id),
    },
    orderBy: { id: "desc" },
    include: { changes: true },
  });
  assert.deepEqual(
    movementLog.changes.map((change) => change.field_name),
    ["currentQuantity"]
  );
  assert.match(movementLog.after_summary_text ?? "", /movementId=/);
  assert.match(movementLog.after_summary_text ?? "", /sourceId=movement-1/);

  const reorderCasSupply = await prisma.supplies.create({
    data: { supply_code: "SUPPLY_REORDER_CAS", supply_name: "Reorder CAS supply" },
  });
  const reorderCas = await prisma.supply_reorder_requests.create({
    data: {
      supply_id: reorderCasSupply.supply_id,
      request_status: SUPPLY_REORDER_STATUS.requested,
      recommended_quantity: 2,
      requested_quantity: 2,
    },
  });
  const reorderCasInput = {
    reorderRequestId: reorderCas.reorder_request_id,
    requestStatus: SUPPLY_REORDER_STATUS.requested,
    expectedRequestStatus: SUPPLY_REORDER_STATUS.requested,
    expectedRevision: reorderCas.revision,
    requestedQuantity: 2,
    orderedQuantity: "",
    receivedQuantity: "",
    expectedUnitCost: 100,
    supplierName: "Supplier A",
    reason: "same-status edit",
  };
  const reorderCasUpdated = await updateSupplyReorderRequest(
    prisma,
    reorderCasInput,
    user
  );
  assert.equal(reorderCasUpdated.revision, 1);
  await assert.rejects(
    updateSupplyReorderRequest(
      prisma,
      { ...reorderCasInput, supplierName: "stale supplier" },
      user
    ),
    (error) => error?.code === "SUPPLY_REORDER_STALE_STATE"
  );
  await prisma.supply_reorder_requests.delete({
    where: { reorder_request_id: reorderCas.reorder_request_id },
  });

  const openStatuses = [
    SUPPLY_REORDER_STATUS.suggested,
    SUPPLY_REORDER_STATUS.requested,
    SUPPLY_REORDER_STATUS.approved,
    SUPPLY_REORDER_STATUS.ordered,
  ];
  const oldOpenRows = [];
  for (const [index, status] of openStatuses.entries()) {
    const openSupply = await prisma.supplies.create({
      data: {
        supply_code: `SUPPLY_OPEN_OLD_${index}`,
        supply_name: `Old open supply ${index}`,
      },
    });
    oldOpenRows.push(
      await prisma.supply_reorder_requests.create({
        data: {
          supply_id: openSupply.supply_id,
          request_status: status,
          recommended_quantity: 1,
          requested_quantity: 1,
          updated_at: new Date(`2020-01-0${index + 1}T00:00:00.000Z`),
        },
      })
    );
  }
  await prisma.supply_reorder_requests.createMany({
    data: Array.from({ length: 301 }, (_, index) => ({
      supply_id: created.supply_id,
      request_status:
        index % 2 === 0
          ? SUPPLY_REORDER_STATUS.received
          : SUPPLY_REORDER_STATUS.cancelled,
      recommended_quantity: index + 1,
      updated_at: new Date(`2026-07-${String(1 + (index % 28)).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`),
    })),
  });

  let page = await getSupplyWorkspaceData(prisma);
  assert.equal(page.summary.openReorderCount, openStatuses.length);
  assert.deepEqual(
    new Set(page.openReorders.map((row) => row.reorderRequestId)),
    new Set(oldOpenRows.map((row) => row.reorder_request_id))
  );
  assert.equal(page.reorderHistory.length, 80);
  assert.equal(page.reorderHistoryPage.hasMore, true);
  const historyIds = new Set(page.reorderHistory.map((row) => row.reorderRequestId));
  const insertedAfterSnapshot = await prisma.supply_reorder_requests.create({
    data: {
      supply_id: created.supply_id,
      request_status: SUPPLY_REORDER_STATUS.cancelled,
      recommended_quantity: 999,
      updated_at: new Date(Date.now() + 60_000),
    },
  });
  while (page.reorderHistoryPage.hasMore) {
    page = await getSupplyWorkspaceData(prisma, {
      reorderCursor: page.reorderHistoryPage.nextCursor,
    });
    for (const row of page.reorderHistory) {
      assert.equal(historyIds.has(row.reorderRequestId), false, "Reorder keyset page duplicated a row.");
      historyIds.add(row.reorderRequestId);
    }
  }
  assert.equal(historyIds.size, 301);
  assert.equal(historyIds.has(insertedAfterSnapshot.reorder_request_id), false);

  console.log("Supply PostgreSQL aggregate, audit, and keyset convergence verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
