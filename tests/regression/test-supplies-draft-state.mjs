import assert from "node:assert/strict";
import {
  SUPPLIES_FORM_IDS,
  normalizeSuppliesDraft,
  suppliesDraftSnapshotsEqual,
} from "../../quickhack_client/components/supplies/supplies-draft-state.ts";

{
  assert.deepEqual(SUPPLIES_FORM_IDS, {
    master: "supplies.master",
    inventoryMovement: "supplies.inventory-movement",
    consumptionRule: "supplies.consumption-rule",
    reorderRequest: "supplies.reorder-request",
  });
}

{
  const baseline = {
    supplyId: "17",
    supplyName: "에어캡",
    orderUnitQuantity: "10",
    isActive: true,
  };

  assert.equal(
    suppliesDraftSnapshotsEqual(baseline, {
      ...baseline,
      supplyName: "  에어캡  ",
    }),
    true,
    "Leading and trailing whitespace created a false dirty state."
  );
  assert.equal(
    suppliesDraftSnapshotsEqual(baseline, {
      ...baseline,
      orderUnitQuantity: "010",
    }),
    false,
    "A distinct numeric input string was incorrectly normalized."
  );
  assert.equal(
    suppliesDraftSnapshotsEqual(baseline, {
      ...baseline,
      isActive: false,
    }),
    false,
    "A boolean change was not detected."
  );
}

{
  const movementBaseline = {
    supplyId: "17",
    movementType: "INBOUND",
    quantity: "",
    reason: "",
  };
  const nextSupplyMovement = {
    supplyId: "23",
    movementType: "INBOUND",
    quantity: "",
    reason: "",
  };

  assert.equal(
    suppliesDraftSnapshotsEqual(movementBaseline, nextSupplyMovement),
    false,
    "Changing the movement target supply was not detected."
  );
  assert.equal(
    suppliesDraftSnapshotsEqual(nextSupplyMovement, {
      ...nextSupplyMovement,
      quantity: "2",
    }),
    false,
    "A movement quantity change was not detected."
  );
}

{
  assert.deepEqual(
    normalizeSuppliesDraft({
      supplierName: " 공급사 ",
      nested: {
        note: " 메모 ",
      },
    }),
    {
      supplierName: "공급사",
      nested: {
        note: "메모",
      },
    }
  );
}

console.log("Supplies draft state verified.");
