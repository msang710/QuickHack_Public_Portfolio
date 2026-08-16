import assert from "node:assert/strict";
import {
  createReturnActionDraftSnapshot,
  restoreReturnActionDraft,
  returnActionDraftSnapshotsEqual,
} from "../../quickhack_client/components/returns/return-action-draft-state.ts";

function draft(values = {}) {
  return {
    inspectionResult: "PASSED",
    appearanceGrade: "",
    appearanceDefect: "",
    functionDefect: "",
    note: "",
    reusableSupplyConsumptionEventIds: [],
    ...values,
  };
}

{
  const baseline = createReturnActionDraftSnapshot({
    allocationIds: [2, 1],
    inspectionDrafts: {
      1: draft({ reusableSupplyConsumptionEventIds: [20, 10] }),
      2: draft(),
    },
  });
  const sameValuesInAnotherOrder = createReturnActionDraftSnapshot({
    allocationIds: [1, 2, 2],
    inspectionDrafts: {
      1: draft({ reusableSupplyConsumptionEventIds: [10, 20] }),
      2: draft(),
    },
  });

  assert.equal(
    returnActionDraftSnapshotsEqual(baseline, sameValuesInAnotherOrder),
    true,
    "Set-like return selections were sensitive to ordering."
  );

  const changedNote = createReturnActionDraftSnapshot({
    allocationIds: [1, 2],
    inspectionDrafts: {
      1: draft({
        note: "구성품 누락",
        reusableSupplyConsumptionEventIds: [10, 20],
      }),
      2: draft(),
    },
  });
  assert.equal(
    returnActionDraftSnapshotsEqual(baseline, changedNote),
    false,
    "A return inspection note change was not detected."
  );

  const changedSelection = createReturnActionDraftSnapshot({
    allocationIds: [1],
    inspectionDrafts: {
      1: draft({ reusableSupplyConsumptionEventIds: [10, 20] }),
    },
  });
  assert.equal(
    returnActionDraftSnapshotsEqual(baseline, changedSelection),
    false,
    "A return allocation selection change was not detected."
  );

  const restored = restoreReturnActionDraft(baseline);
  assert.deepEqual(restored.allocationIds, [1, 2]);
  assert.deepEqual(
    restored.inspectionDrafts[1].reusableSupplyConsumptionEventIds,
    [10, 20],
    "Return draft discard did not restore reusable-supply selections."
  );
  assert.equal(
    returnActionDraftSnapshotsEqual(
      baseline,
      createReturnActionDraftSnapshot({
        allocationIds: restored.allocationIds,
        inspectionDrafts: restored.inspectionDrafts,
      })
    ),
    true,
    "A restored return draft did not return to clean."
  );
}

console.log("Return action draft state verified.");
