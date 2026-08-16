import assert from "node:assert/strict";
import {
  createSupplyMovementTargetState,
  prepareSupplyMovementOperation,
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

{
  const draft = {
    supplyId: "17",
    movementType: SUPPLY_MOVEMENT_TYPE.adjustment,
    quantity: "08",
    reason: " 월말 실사 ",
  };
  const first = prepareSupplyMovementOperation(draft, null, () => "uuid-1");
  const replay = prepareSupplyMovementOperation(
    { ...draft, quantity: "8", reason: "월말 실사" },
    first,
    () => "must-not-be-used"
  );
  const changed = prepareSupplyMovementOperation(
    { ...draft, quantity: "7" },
    first,
    () => "uuid-2"
  );

  assert.equal(first.operationId, "supply:movement:uuid-1");
  assert.equal(replay, first, "A canonical same-command retry changed operation ID.");
  assert.equal(changed.operationId, "supply:movement:uuid-2");
  assert.notEqual(changed.fingerprint, first.fingerprint);
}

console.log("Supplies target transition verified.");
