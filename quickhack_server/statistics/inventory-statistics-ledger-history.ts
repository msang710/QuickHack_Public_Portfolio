// QuickHack service: validates and folds append-only inventory movement rows.
import { parseKstSqlDateTime } from "@/quickhack_shared/core/time";
import {
  INVENTORY_STATUS,
} from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_QUANTITY_MOVEMENT_TYPE } from "@/quickhack_shared/inventory/inventory-quantity-movement";
import type { InventoryStatisticsAgingIssueCode } from "@/quickhack_shared/statistics/statistics";

export type InventoryStatisticsMovementInput = {
  movementId: number;
  balanceId?: number;
  operationKey: string;
  movementType: string;
  pgNo: string;
  inventorySkuId: number;
  inventoryStatus: string;
  quantityDelta: number;
  beforeQuantity?: number;
  afterQuantity?: number;
  occurredAt: string;
};

export type InventoryStatisticsMovementOperation = {
  operationKey: string;
  pgNo: string;
  movementType: string;
  occurredAt: string;
  occurredAtMs: number;
  firstMovementId: number;
  inMovement: InventoryStatisticsMovementInput | null;
  outMovement: InventoryStatisticsMovementInput | null;
  rows: readonly InventoryStatisticsMovementInput[];
};

export type InventoryStatisticsHoldingCycleResolution = {
  startedAt: string | null;
  issueCode: InventoryStatisticsAgingIssueCode | null;
};

export type InventoryStatisticsMovementFoldIssueCode =
  | "INVALID_PG_MOVEMENT_GROUP"
  | "INVALID_MOVEMENT_TIMESTAMP"
  | "INVALID_MOVEMENT_QUANTITY";

export const INVENTORY_STATISTICS_WAREHOUSE_STATUSES =
  new Set<string>([
    INVENTORY_STATUS.sellable,
    INVENTORY_STATUS.reserved,
    INVENTORY_STATUS.packing,
    INVENTORY_STATUS.packed,
    INVENTORY_STATUS.departure,
    INVENTORY_STATUS.hold,
    INVENTORY_STATUS.defective,
    INVENTORY_STATUS.returnCheck,
  ]);

const KNOWN_INVENTORY_STATUSES = new Set<string>(
  Object.values(INVENTORY_STATUS)
);

function text(value: unknown) {
  return String(value ?? "").trim();
}

function hasValidQuantityEvidence(row: InventoryStatisticsMovementInput) {
  const hasBefore = row.beforeQuantity !== undefined;
  const hasAfter = row.afterQuantity !== undefined;

  if (!hasBefore && !hasAfter) {
    return true;
  }

  return (
    hasBefore &&
    hasAfter &&
    Number.isInteger(row.beforeQuantity) &&
    Number.isInteger(row.afterQuantity) &&
    (row.beforeQuantity as number) + row.quantityDelta === row.afterQuantity
  );
}

function movementOperation(
  pgNo: string,
  operationKey: string,
  rows: readonly InventoryStatisticsMovementInput[]
):
  | { operation: InventoryStatisticsMovementOperation; issueCode: null }
  | {
      operation: null;
      issueCode: InventoryStatisticsMovementFoldIssueCode;
    } {
  if (rows.length === 0) {
    return { operation: null, issueCode: "INVALID_PG_MOVEMENT_GROUP" };
  }

  const movementType = rows[0]?.movementType ?? "";
  const parsedTimes = rows.map((row) => parseKstSqlDateTime(row.occurredAt));

  if (parsedTimes.some((date) => date === null)) {
    return { operation: null, issueCode: "INVALID_MOVEMENT_TIMESTAMP" };
  }

  if (rows.some((row) => !hasValidQuantityEvidence(row))) {
    return { operation: null, issueCode: "INVALID_MOVEMENT_QUANTITY" };
  }

  const occurredAtMs = (parsedTimes[0] as Date).getTime();
  const sameOperationMetadata = rows.every(
    (row, index) =>
      row.pgNo === pgNo &&
      text(row.operationKey) === operationKey &&
      row.movementType === movementType &&
      KNOWN_INVENTORY_STATUSES.has(row.inventoryStatus) &&
      Number.isInteger(row.inventorySkuId) &&
      row.inventorySkuId > 0 &&
      Number.isInteger(row.quantityDelta) &&
      (parsedTimes[index] as Date).getTime() === occurredAtMs
  );

  if (!sameOperationMetadata) {
    return { operation: null, issueCode: "INVALID_PG_MOVEMENT_GROUP" };
  }

  const inMovements = rows.filter((row) => row.quantityDelta === 1);
  const outMovements = rows.filter((row) => row.quantityDelta === -1);
  const firstMovementId = Math.min(...rows.map((row) => row.movementId));
  const base = {
    operationKey,
    pgNo,
    movementType,
    occurredAt: rows[0]?.occurredAt ?? "",
    occurredAtMs,
    firstMovementId,
    rows,
  };

  if (
    movementType === INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated
  ) {
    if (rows.length !== 1 || inMovements.length !== 1) {
      return { operation: null, issueCode: "INVALID_PG_MOVEMENT_GROUP" };
    }

    return {
      operation: {
        ...base,
        inMovement: inMovements[0] ?? null,
        outMovement: null,
      },
      issueCode: null,
    };
  }

  if (movementType === INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryRemoved) {
    if (rows.length !== 1 || outMovements.length !== 1) {
      return { operation: null, issueCode: "INVALID_PG_MOVEMENT_GROUP" };
    }

    return {
      operation: {
        ...base,
        inMovement: null,
        outMovement: outMovements[0] ?? null,
      },
      issueCode: null,
    };
  }

  if (
    movementType === INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer ||
    movementType === INVENTORY_QUANTITY_MOVEMENT_TYPE.skuReclassification
  ) {
    if (
      rows.length !== 2 ||
      inMovements.length !== 1 ||
      outMovements.length !== 1
    ) {
      return { operation: null, issueCode: "INVALID_PG_MOVEMENT_GROUP" };
    }

    const inMovement = inMovements[0] as InventoryStatisticsMovementInput;
    const outMovement = outMovements[0] as InventoryStatisticsMovementInput;
    const validPair =
      movementType === INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer
        ? inMovement.inventorySkuId === outMovement.inventorySkuId
        : inMovement.inventoryStatus === outMovement.inventoryStatus;

    if (!validPair) {
      return { operation: null, issueCode: "INVALID_PG_MOVEMENT_GROUP" };
    }

    return {
      operation: {
        ...base,
        inMovement,
        outMovement,
      },
      issueCode: null,
    };
  }

  return { operation: null, issueCode: "INVALID_PG_MOVEMENT_GROUP" };
}

export function foldInventoryMovementOperations(
  movements: readonly InventoryStatisticsMovementInput[]
):
  | {
      operations: InventoryStatisticsMovementOperation[];
      issueCode: null;
    }
  | {
      operations: null;
      issueCode: InventoryStatisticsMovementFoldIssueCode;
    } {
  const rowsByOperation = new Map<
    string,
    InventoryStatisticsMovementInput[]
  >();

  for (const row of movements) {
    const operationKey = text(row.operationKey);
    const pgNo = text(row.pgNo);

    if (!operationKey || !pgNo) {
      return {
        operations: null,
        issueCode: "INVALID_PG_MOVEMENT_GROUP",
      };
    }

    const groupKey = `${pgNo}\u0000${operationKey}`;
    const rows = rowsByOperation.get(groupKey) ?? [];
    rows.push(row);
    rowsByOperation.set(groupKey, rows);
  }

  const operations: InventoryStatisticsMovementOperation[] = [];

  for (const [groupKey, rows] of rowsByOperation) {
    const splitAt = groupKey.indexOf("\u0000");
    const pgNo = groupKey.slice(0, splitAt);
    const operationKey = groupKey.slice(splitAt + 1);
    const result = movementOperation(pgNo, operationKey, rows);

    if (result.issueCode) {
      return { operations: null, issueCode: result.issueCode };
    }

    operations.push(result.operation);
  }

  operations.sort(
    (left, right) =>
      left.occurredAtMs - right.occurredAtMs ||
      left.firstMovementId - right.firstMovementId
  );

  return { operations, issueCode: null };
}

export function resolveCurrentHoldingCycle(input: {
  pgNo: string;
  currentStatus: string;
  movements: readonly InventoryStatisticsMovementInput[];
}): InventoryStatisticsHoldingCycleResolution {
  const pgNo = text(input.pgNo);

  if (!pgNo || input.movements.length === 0) {
    return {
      startedAt: null,
      issueCode: "MISSING_PG_MOVEMENT_HISTORY",
    };
  }

  const folded = foldInventoryMovementOperations(input.movements);

  if (folded.issueCode) {
    return {
      startedAt: null,
      issueCode:
        folded.issueCode === "INVALID_MOVEMENT_TIMESTAMP"
          ? "INVALID_MOVEMENT_TIMESTAMP"
          : "INVALID_PG_MOVEMENT_GROUP",
    };
  }

  let present = false;
  let currentStatus: string | null = null;
  let startedAt: string | null = null;

  for (const operation of folded.operations) {
    const inMovement = operation.inMovement;
    const outMovement = operation.outMovement;

    if (
      operation.movementType ===
      INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated
    ) {
      if (present || !inMovement) {
        return {
          startedAt: null,
          issueCode: "CURRENT_STATUS_HISTORY_MISMATCH",
        };
      }

      present = true;
      currentStatus = inMovement.inventoryStatus;

      if (INVENTORY_STATISTICS_WAREHOUSE_STATUSES.has(currentStatus)) {
        startedAt = operation.occurredAt;
      }

      continue;
    }

    if (
      operation.movementType ===
      INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryRemoved
    ) {
      if (
        !present ||
        !outMovement ||
        currentStatus !== outMovement.inventoryStatus
      ) {
        return {
          startedAt: null,
          issueCode: "CURRENT_STATUS_HISTORY_MISMATCH",
        };
      }

      present = false;
      currentStatus = null;
      startedAt = null;
      continue;
    }

    if (!present || !inMovement || !outMovement) {
      return {
        startedAt: null,
        issueCode: "CURRENT_STATUS_HISTORY_MISMATCH",
      };
    }

    if (currentStatus !== outMovement.inventoryStatus) {
      return {
        startedAt: null,
        issueCode: "CURRENT_STATUS_HISTORY_MISMATCH",
      };
    }

    if (
      operation.movementType ===
      INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer
    ) {
      const fromWarehouse = INVENTORY_STATISTICS_WAREHOUSE_STATUSES.has(
        outMovement.inventoryStatus
      );
      const toWarehouse = INVENTORY_STATISTICS_WAREHOUSE_STATUSES.has(
        inMovement.inventoryStatus
      );

      if (!fromWarehouse && toWarehouse) {
        startedAt = operation.occurredAt;
      } else if (fromWarehouse && !toWarehouse) {
        startedAt = null;
      }
    }

    currentStatus = inMovement.inventoryStatus;
  }

  if (!present || currentStatus !== input.currentStatus) {
    return {
      startedAt: null,
      issueCode: "CURRENT_STATUS_HISTORY_MISMATCH",
    };
  }

  if (
    !INVENTORY_STATISTICS_WAREHOUSE_STATUSES.has(
      currentStatus
    )
  ) {
    return { startedAt: null, issueCode: null };
  }

  if (startedAt) {
    return { startedAt, issueCode: null };
  }

  return {
    startedAt: null,
    issueCode: "MISSING_PG_MOVEMENT_HISTORY",
  };
}
