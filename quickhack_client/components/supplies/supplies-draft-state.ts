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

export type PendingSupplyMovementOperation = {
  fingerprint: string;
  operationId: string;
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

export function supplyMovementCommandFingerprint(draft: SupplyMovementDraft) {
  const normalizedQuantity = Number(draft.quantity);
  return JSON.stringify({
    supplyId: draft.supplyId.trim(),
    movementType: draft.movementType.trim().toUpperCase(),
    quantity:
      draft.quantity.trim() && Number.isInteger(normalizedQuantity)
        ? normalizedQuantity
        : draft.quantity.trim(),
    reason: draft.reason.trim(),
  });
}

export function prepareSupplyMovementOperation(
  draft: SupplyMovementDraft,
  pending: PendingSupplyMovementOperation | null,
  createUuid: () => string
): PendingSupplyMovementOperation {
  const fingerprint = supplyMovementCommandFingerprint(draft);
  if (pending?.fingerprint === fingerprint) {
    return pending;
  }

  return {
    fingerprint,
    operationId: `supply:movement:${createUuid()}`,
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
