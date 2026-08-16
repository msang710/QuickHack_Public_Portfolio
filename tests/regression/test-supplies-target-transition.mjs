import assert from "node:assert/strict";
import {
  createSupplyMovementTargetState,
  suppliesDraftSnapshotsEqual,
} from "../../quickhack_client/components/supplies/supplies-draft-state.ts";
import { SUPPLY_MOVEMENT_TYPE } from "../../quickhack_shared/supplies/supplies.ts";

{
  const nextState = createSupplyMovementTargetState("23");

  assert.deepEqual(nextState, {
    current: {
      supplyId: "23",
      movementType: SUPPLY_MOVEMENT_TYPE.inbound,
      quantity: "",
      reason: "",
    },
    baseline: {
      supplyId: "23",
      movementType: SUPPLY_MOVEMENT_TYPE.inbound,
      quantity: "",
      reason: "",
    },
  });
  assert.notEqual(
    nextState.current,
    nextState.baseline,
    "Current and baseline shared the same mutable object."
  );
  assert.equal(
    suppliesDraftSnapshotsEqual(nextState.baseline, nextState.current),
    true,
    "A completed target transition did not produce a clean movement form."
  );
}

{
  const previousDraft = {
    supplyId: "17",
    movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
    quantity: "8",
    reason: "월말 실사",
  };
  const nextState = createSupplyMovementTargetState("23");

  assert.deepEqual(
    nextState.current,
    {
      supplyId: "23",
      movementType: SUPPLY_MOVEMENT_TYPE.inbound,
      quantity: "",
      reason: "",
    },
    "The previous quantity or reason leaked into the next supply."
  );
  assert.deepEqual(previousDraft, {
    supplyId: "17",
    movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
    quantity: "8",
    reason: "월말 실사",
  });
}

{
  const clearedState = createSupplyMovementTargetState("NONE");

  assert.equal(clearedState.current.supplyId, "");
  assert.equal(
    suppliesDraftSnapshotsEqual(clearedState.baseline, clearedState.current),
    true
  );
}

{
  const baseline = createSupplyMovementTargetState("17").baseline;
  const uncommittedTargetChange = {
    ...baseline,
    supplyId: "23",
  };

  assert.equal(
    suppliesDraftSnapshotsEqual(baseline, uncommittedTargetChange),
    false,
    "A target change without baseline advancement was not dirty."
  );
}

console.log("Supplies target transition verified.");
