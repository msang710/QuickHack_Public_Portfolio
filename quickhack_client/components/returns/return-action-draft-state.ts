import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";

export type ReturnInspectionDraft = {
  inspectionResult: string;
  appearanceGrade: string;
  appearanceDefect: string;
  functionDefect: string;
  note: string;
  reusableSupplyConsumptionEventIds: number[];
};

export type ReturnActionInspectionSnapshot = ReturnInspectionDraft & {
  allocationId: number;
};

export type ReturnActionDraftSnapshot = {
  allocationIds: number[];
  inspections: ReturnActionInspectionSnapshot[];
};

function normalizedIds(values: readonly number[]) {
  return Array.from(
    new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))
  ).sort((left, right) => left - right);
}

function emptyReturnInspectionDraft(): ReturnInspectionDraft {
  return {
    inspectionResult: "PASSED",
    appearanceGrade: "",
    appearanceDefect: "",
    functionDefect: "",
    note: "",
    reusableSupplyConsumptionEventIds: [],
  };
}

export function createReturnActionDraftSnapshot({
  allocationIds,
  inspectionDrafts,
}: {
  allocationIds: readonly number[];
  inspectionDrafts: Readonly<Record<number, ReturnInspectionDraft>>;
}): ReturnActionDraftSnapshot {
  const normalizedAllocationIds = normalizedIds(allocationIds);

  return {
    allocationIds: normalizedAllocationIds,
    inspections: normalizedAllocationIds.map((allocationId) => {
      const draft =
        inspectionDrafts[allocationId] ?? emptyReturnInspectionDraft();

      return {
        allocationId,
        inspectionResult: draft.inspectionResult,
        appearanceGrade: draft.appearanceGrade,
        appearanceDefect: draft.appearanceDefect,
        functionDefect: draft.functionDefect,
        note: draft.note,
        reusableSupplyConsumptionEventIds: normalizedIds(
          draft.reusableSupplyConsumptionEventIds
        ),
      };
    }),
  };
}

export function returnActionDraftSnapshotsEqual(
  baseline: ReturnActionDraftSnapshot,
  current: ReturnActionDraftSnapshot
) {
  return unsavedFormSnapshotsEqual(baseline, current);
}

export function restoreReturnActionDraft(
  snapshot: ReturnActionDraftSnapshot
) {
  return {
    allocationIds: [...snapshot.allocationIds],
    inspectionDrafts: Object.fromEntries(
      snapshot.inspections.map(({ allocationId, ...draft }) => [
        allocationId,
        {
          ...draft,
          reusableSupplyConsumptionEventIds: [
            ...draft.reusableSupplyConsumptionEventIds,
          ],
        },
      ])
    ) as Record<number, ReturnInspectionDraft>,
  };
}
