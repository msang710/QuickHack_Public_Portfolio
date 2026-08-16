import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";
import { SUPPLY_MOVEMENT_TYPE } from "@/quickhack_shared/supplies/supplies";

export const SUPPLIES_FORM_IDS = {
  master: "supplies.master",
  inventoryMovement: "supplies.inventory-movement",
  consumptionRule: "supplies.consumption-rule",
  reorderRequest: "supplies.reorder-request",
} as const;

export type SupplyMovementDraft = {
  supplyId: string;
  movementType: string;
  quantity: string;
  reason: string;
};

function normalizeSupplyMovementTargetId(supplyId: string) {
  return supplyId === "NONE" ? "" : supplyId;
}

export function createSupplyMovementTargetState(
  supplyId: string
): {
  current: SupplyMovementDraft;
  baseline: SupplyMovementDraft;
} {
  const current = {
    supplyId: normalizeSupplyMovementTargetId(supplyId),
    movementType: SUPPLY_MOVEMENT_TYPE.inbound,
    quantity: "",
    reason: "",
  };

  return {
    current,
    baseline: { ...current },
  };
}

function normalizeDraftValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDraftValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        normalizeDraftValue(nestedValue),
      ])
    );
  }

  return value;
}

export function normalizeSuppliesDraft<T>(draft: T): T {
  return normalizeDraftValue(draft) as T;
}

export function suppliesDraftSnapshotsEqual(
  baseline: unknown,
  current: unknown
) {
  return unsavedFormSnapshotsEqual(
    normalizeSuppliesDraft(baseline),
    normalizeSuppliesDraft(current)
  );
}
