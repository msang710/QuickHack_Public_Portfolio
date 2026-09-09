import type { Prisma } from "@/generated/prisma/client";
import {
  completeDomainOperationKey,
  digestDomainOperation,
  insertOrObserve,
  lockAggregateKey,
  lockAggregateRow,
  reserveDomainOperationKey,
} from "@/quickhack_server/core/database/aggregate-command";
import { databaseDateTime, databaseNow } from "@/quickhack_server/core/database/time-boundary";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import { assignCurrentInventorySkuToDevice } from "@/quickhack_server/catalog/inventory-sku-service";
import type { InventorySkuCriteriaChanges } from "@/quickhack_server/catalog/inventory-sku-service";
import {
  assertInventorySkuEditAllowed,
  assertInventoryStatusTransition,
  assertKnownInventoryStatus,
  type InventoryTransitionPolicy,
} from "@/quickhack_shared/inventory/inventory-write-rules";
import {
  publicConflict,
  publicNotFound,
  publicUnavailable,
} from "@/quickhack_server/core/public-error";

export { INVENTORY_QUANTITY_MOVEMENT_TYPE } from "@/quickhack_shared/inventory/inventory-quantity-movement";

type TransactionClient = Prisma.TransactionClient;

type InventoryQuantityBalanceKey = {
  inventorySkuId: number;
  inventoryStatus: string;
};

export function buildInventoryQuantityBalanceLockPlan(
  keys: readonly InventoryQuantityBalanceKey[]
) {
  return Object.freeze([...new Set(keys.map((key) => {
    if (!Number.isSafeInteger(key.inventorySkuId) || key.inventorySkuId <= 0) {
      throw new Error("inventorySkuId 값이 올바르지 않습니다.");
    }
    return `${key.inventorySkuId}:${requiredText(key.inventoryStatus, "inventoryStatus")}`;
  }))].sort());
}

export async function lockInventoryQuantityBalanceKeys(
  tx: TransactionClient,
  keys: readonly InventoryQuantityBalanceKey[]
) {
  const sortedKeys = buildInventoryQuantityBalanceLockPlan(keys);
  for (const key of sortedKeys) {
    await lockAggregateKey(tx, {
      namespace: "inventory-quantity-balance",
      key,
    });
  }
  return sortedKeys;
}

function assertPublicInventoryRule(work: () => void) {
  try {
    work();
  } catch (error) {
    throw publicConflict(
      "INVENTORY_STATE_CONFLICT",
      "INVENTORY_STATE_CONFLICT"
    );
  }
}

type MovementContext = {
  operationKey: string;
  movementType: string;
  sourceType: string;
  sourceId?: string | null;
  reason?: string | null;
  actorUserId?: number | null;
  workerJobId?: number | null;
  occurredAt?: DateTimeInput;
  beforeBalanceLock?: (input: {
    inventorySkuId: number;
    fromStatus: string;
    toStatus: string;
  }) => Promise<void>;
};

function requiredText(value: unknown, label: string) {
  const text = String(value ?? "").trim();

  if (!text) {
    throw new Error(`${label} 값이 필요합니다.`);
  }

  return text;
}

async function applyQuantityDelta(
  tx: TransactionClient,
  input: MovementContext & {
    inventorySkuId: number;
    inventoryStatus: string;
    pgNo?: string | null;
    quantityDelta: number;
    idempotencySuffix: string;
  }
) {
  const operationKey = requiredText(input.operationKey, "operationKey");
  const inventoryStatus = requiredText(input.inventoryStatus, "inventoryStatus");
  const movementType = requiredText(input.movementType, "movementType");
  const sourceType = requiredText(input.sourceType, "sourceType");

  if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) {
    throw new Error("재고 수량 증감값은 0이 아닌 정수여야 합니다.");
  }

  const idempotencyKey = `${operationKey}:${input.idempotencySuffix}`;
  const requestDigest = digestDomainOperation({
    inventorySkuId: input.inventorySkuId,
    inventoryStatus,
    movementType,
    pgNo: input.pgNo ?? null,
    quantityDelta: input.quantityDelta,
    sourceType,
    sourceId: input.sourceId ?? null,
  });
  const operation = await reserveDomainOperationKey(tx, {
    scope: "INVENTORY_QUANTITY_MOVEMENT",
    operationKey: idempotencyKey,
    aggregateType: "INVENTORY_QUANTITY_BALANCE",
    aggregateId: `${input.inventorySkuId}:${inventoryStatus}`,
    requestDigest,
  });
  const existingMovement =
    await tx.inventory_quantity_movements.findUnique({
      where: { idempotency_key: idempotencyKey },
      include: {
        balance: {
          select: {
            inventory_sku_id: true,
            inventory_status: true,
          },
        },
      },
    });

  if (existingMovement) {
    const sameMovement =
      existingMovement.operation_key === operationKey &&
      existingMovement.movement_type === movementType &&
      existingMovement.pg_no === (input.pgNo ?? null) &&
      existingMovement.quantity_delta === input.quantityDelta &&
      existingMovement.source_type === sourceType &&
      existingMovement.source_id === (input.sourceId ?? null) &&
      existingMovement.balance.inventory_sku_id === input.inventorySkuId &&
      existingMovement.balance.inventory_status === inventoryStatus;

    if (!sameMovement) {
      throw new Error(
        `Inventory quantity idempotency key collision: ${idempotencyKey}`
      );
    }

    if (operation.owned) {
      await completeDomainOperationKey(
        tx,
        operation.row.operation_id,
        digestDomainOperation({ movementId: existingMovement.inventory_quantity_movement_id })
      );
    }
    return { applied: false, movement: existingMovement };
  }

  const balanceWhere = {
    inventory_sku_id_inventory_status: {
      inventory_sku_id: input.inventorySkuId,
      inventory_status: inventoryStatus,
    },
  } as const;
  let balance = await tx.inventory_quantity_balances.findUnique({
    where: balanceWhere,
  });
  const timestamp = databaseDateTime(input.occurredAt ?? databaseNow());

  if (!balance) {
    if (input.quantityDelta < 0) {
      throw new Error(
        `재고 수량 원장에 ${input.inventorySkuId}/${inventoryStatus} 잔액이 없습니다.`
      );
    }

    const resolved = await insertOrObserve({
      name: "inventory_quantity_balances.sku_status",
      insert: () => tx.$queryRaw<Array<{ inventory_quantity_balance_id: number }>>`
        INSERT INTO inventory_quantity_balances (
          inventory_sku_id,
          inventory_status,
          quantity,
          version,
          created_at,
          updated_at
        ) VALUES (
          ${input.inventorySkuId},
          ${inventoryStatus},
          0,
          0,
          ${timestamp},
          ${timestamp}
        )
        ON CONFLICT (inventory_sku_id, inventory_status) DO NOTHING
        RETURNING inventory_quantity_balance_id
      `,
      observe: () => tx.inventory_quantity_balances.findUnique({
        where: balanceWhere,
        select: { inventory_quantity_balance_id: true },
      }),
    });
    balance = await tx.inventory_quantity_balances.findUniqueOrThrow({
      where: {
        inventory_quantity_balance_id:
          resolved.row.inventory_quantity_balance_id,
      },
    });
  }

  const balanceId = balance.inventory_quantity_balance_id;
  await lockAggregateRow({
    name: `inventory_quantity_balance.${balanceId}`,
    lock: () => tx.$queryRaw<Array<{ inventory_quantity_balance_id: number }>>`
      SELECT inventory_quantity_balance_id
      FROM inventory_quantity_balances
      WHERE inventory_quantity_balance_id = ${balanceId}
      FOR UPDATE
    `,
  });
  balance = await tx.inventory_quantity_balances.findUniqueOrThrow({
    where: {
      inventory_quantity_balance_id: balanceId,
    },
  });

  const beforeQuantity = balance.quantity;
  const afterQuantity = beforeQuantity + input.quantityDelta;

  if (afterQuantity < 0) {
    throw new Error(
      `재고 수량이 음수가 됩니다: SKU ${input.inventorySkuId}, ${inventoryStatus}, ${beforeQuantity} ${input.quantityDelta}`
    );
  }

  const updated = await tx.inventory_quantity_balances.updateMany({
    where: {
      inventory_quantity_balance_id: balance.inventory_quantity_balance_id,
      version: balance.version,
      quantity: beforeQuantity,
    },
    data: {
      quantity: afterQuantity,
      version: { increment: 1 },
      last_movement_at: timestamp,
      updated_at: timestamp,
    },
  });

  if (updated.count !== 1) {
    throw publicConflict(
      "INVENTORY_QUANTITY_CONCURRENT_CHANGE",
      "INVENTORY_QUANTITY_CONCURRENT_CHANGE"
    );
  }

  const movement = await tx.inventory_quantity_movements.create({
    data: {
      inventory_quantity_balance_id:
        balance.inventory_quantity_balance_id,
      operation_key: operationKey,
      idempotency_key: idempotencyKey,
      movement_type: movementType,
      pg_no: input.pgNo ?? null,
      quantity_delta: input.quantityDelta,
      before_quantity: beforeQuantity,
      after_quantity: afterQuantity,
      source_type: sourceType,
      source_id: input.sourceId ?? null,
      reason: input.reason ?? null,
      actor_user_id: input.actorUserId ?? null,
      worker_job_id: input.workerJobId ?? null,
      occurred_at: timestamp,
      created_at: timestamp,
    },
  });

  await completeDomainOperationKey(
    tx,
    operation.row.operation_id,
    digestDomainOperation({ movementId: movement.inventory_quantity_movement_id })
  );

  return { applied: true, movement };
}

export async function transitionInventoryStatusWithLedger(
  tx: TransactionClient,
  input: MovementContext & {
    pgNo: string;
    toStatus: string;
    expectedFromStatus?: string | null;
    expectedRevision?: number;
    inventoryUpdate?: {
      location?: string | null;
      stockedAt?: Date | null;
    };
    transitionPolicy: InventoryTransitionPolicy;
  }
) {
  const pgNo = requiredText(input.pgNo, "pgNo");
  const toStatus = requiredText(input.toStatus, "toStatus");
  const operationKey = requiredText(input.operationKey, "operationKey");
  const inventoryRow = await tx.inventory.findUnique({
    where: { pg_no: pgNo },
  });

  if (!inventoryRow) {
    throw publicNotFound(
      "INVENTORY_NOT_FOUND",
      "INVENTORY_NOT_FOUND"
    );
  }

  const fromStatus = inventoryRow.inventory_status;
  assertPublicInventoryRule(() => {
    assertKnownInventoryStatus(fromStatus, "현재");
    assertKnownInventoryStatus(toStatus, "변경할");
  });
  const outKey = `${operationKey}:OUT`;
  const inKey = `${operationKey}:IN`;
  const existingMovements = await tx.inventory_quantity_movements.findMany({
    where: { idempotency_key: { in: [outKey, inKey] } },
    include: {
      balance: {
        select: {
          inventory_sku_id: true,
          inventory_status: true,
        },
      },
    },
  });

  if (existingMovements.length > 0) {
    const outMovement = existingMovements.find(
      (movement) => movement.idempotency_key === outKey
    );
    const inMovement = existingMovements.find(
      (movement) => movement.idempotency_key === inKey
    );
    const matchesCompletedTransition =
      existingMovements.length === 2 &&
      outMovement !== undefined &&
      inMovement !== undefined &&
      outMovement.operation_key === operationKey &&
      inMovement.operation_key === operationKey &&
      outMovement.movement_type === input.movementType &&
      inMovement.movement_type === input.movementType &&
      outMovement.source_type === input.sourceType &&
      inMovement.source_type === input.sourceType &&
      outMovement.source_id === (input.sourceId ?? null) &&
      inMovement.source_id === (input.sourceId ?? null) &&
      outMovement.pg_no === pgNo &&
      inMovement.pg_no === pgNo &&
      outMovement.quantity_delta === -1 &&
      inMovement.quantity_delta === 1 &&
      outMovement.balance.inventory_sku_id ===
        inMovement.balance.inventory_sku_id &&
      inMovement.balance.inventory_status === toStatus &&
      (!input.expectedFromStatus ||
        outMovement.balance.inventory_status === input.expectedFromStatus);

    if (!matchesCompletedTransition) {
      throw new Error(
        `Inventory quantity transition idempotency conflict: ${operationKey}`
      );
    }

    assertPublicInventoryRule(() => {
      assertInventoryStatusTransition({
        fromStatus: outMovement.balance.inventory_status,
        toStatus,
        policy: input.transitionPolicy,
      });
    });

    return {
      applied: false,
      fromStatus: outMovement.balance.inventory_status,
      toStatus,
      inventorySkuId: inMovement.balance.inventory_sku_id,
    };
  }

  if (
    input.expectedFromStatus &&
    fromStatus !== input.expectedFromStatus
  ) {
    throw publicConflict(
      "INVENTORY_STATE_CONFLICT",
      "INVENTORY_STATE_CONFLICT"
    );
  }

  if (fromStatus === toStatus) {
    return {
      applied: false,
      fromStatus,
      toStatus,
      inventorySkuId: null,
    };
  }


  assertPublicInventoryRule(() => {
    assertInventoryStatusTransition({
      fromStatus,
      toStatus,
      policy: input.transitionPolicy,
    });
  });

  const sku = await assignCurrentInventorySkuToDevice(tx, pgNo, {
    actorUserId: input.actorUserId,
    required: true,
  });

  if (!sku) {
    throw publicConflict(
      "INVENTORY_SKU_INCOMPLETE",
      "INVENTORY_SKU_INCOMPLETE"
    );
  }

  await input.beforeBalanceLock?.({
    inventorySkuId: sku.inventory_sku_id,
    fromStatus,
    toStatus,
  });

  await lockInventoryQuantityBalanceKeys(tx, [
    { inventorySkuId: sku.inventory_sku_id, inventoryStatus: fromStatus },
    { inventorySkuId: sku.inventory_sku_id, inventoryStatus: toStatus },
  ]);

  const updated = await tx.inventory.updateMany({
    where: {
      inventory_id: inventoryRow.inventory_id,
      inventory_status: fromStatus,
      revision: input.expectedRevision ?? inventoryRow.revision,
    },
    data: {
      inventory_status: toStatus,
      location: input.inventoryUpdate?.location,
      stocked_at: input.inventoryUpdate?.stockedAt,
      revision: { increment: 1 },
      updated_at: databaseDateTime(input.occurredAt ?? databaseNow()),
    },
  });

  if (updated.count !== 1) {
    throw publicConflict(
      "INVENTORY_STATE_CONCURRENT_CHANGE",
      "INVENTORY_STATE_CONCURRENT_CHANGE"
    );
  }

  const baseMovement = {
    ...input,
    operationKey,
    inventorySkuId: sku.inventory_sku_id,
    pgNo,
  };

  await applyQuantityDelta(tx, {
    ...baseMovement,
    inventoryStatus: fromStatus,
    quantityDelta: -1,
    idempotencySuffix: "OUT",
  });
  await applyQuantityDelta(tx, {
    ...baseMovement,
    inventoryStatus: toStatus,
    quantityDelta: 1,
    idempotencySuffix: "IN",
  });

  return {
    applied: true,
    fromStatus,
    toStatus,
    inventorySkuId: sku.inventory_sku_id,
  };
}

export async function recordInventoryCreatedWithLedger(
  tx: TransactionClient,
  input: MovementContext & {
    pgNo: string;
    inventoryStatus: string;
  }
) {
  const sku = await assignCurrentInventorySkuToDevice(tx, input.pgNo, {
    actorUserId: input.actorUserId,
    required: true,
  });

  if (!sku) {
    throw publicConflict(
      "INVENTORY_SKU_INCOMPLETE",
      "INVENTORY_SKU_INCOMPLETE"
    );
  }

  return applyQuantityDelta(tx, {
    ...input,
    inventorySkuId: sku.inventory_sku_id,
    pgNo: input.pgNo,
    quantityDelta: 1,
    idempotencySuffix: "IN",
  });
}

export async function recordInventoryRemovedWithLedger(
  tx: TransactionClient,
  input: MovementContext & {
    pgNo: string;
    inventoryStatus: string;
    inventorySkuId: number;
  }
) {
  return applyQuantityDelta(tx, {
    ...input,
    pgNo: input.pgNo,
    quantityDelta: -1,
    idempotencySuffix: "OUT",
  });
}

export async function reclassifyInventorySkuWithLedger(
  tx: TransactionClient,
  input: MovementContext & {
    pgNo: string;
    previousInventorySkuId: number | null;
    changedCriteria?: InventorySkuCriteriaChanges;
  }
) {
  const newSku = await assignCurrentInventorySkuToDevice(tx, input.pgNo, {
    actorUserId: input.actorUserId,
    required: true,
    changedCriteria: input.changedCriteria,
  });

  const inventoryRow = await tx.inventory.findUnique({
    where: { pg_no: input.pgNo },
  });

  if (!inventoryRow) {
    return {
      applied: false,
      inventorySkuId: newSku?.inventory_sku_id ?? null,
    };
  }

  if (!newSku || newSku.inventory_sku_id === input.previousInventorySkuId) {
    return {
      applied: false,
      inventorySkuId: newSku?.inventory_sku_id ?? null,
    };
  }


  assertPublicInventoryRule(() =>
    assertInventorySkuEditAllowed(inventoryRow.inventory_status)
  );

  if (input.previousInventorySkuId === null) {
    const movementCount = await tx.inventory_quantity_movements.count();
    const inventoryCount = await tx.inventory.count();

    if (inventoryCount > 0 && movementCount === 0) {
      throw publicUnavailable(
        "INVENTORY_LEDGER_NOT_READY",
        "INVENTORY_LEDGER_NOT_READY"
      );
    }

    await applyQuantityDelta(tx, {
      ...input,
      inventorySkuId: newSku.inventory_sku_id,
      inventoryStatus: inventoryRow.inventory_status,
      pgNo: input.pgNo,
      quantityDelta: 1,
      idempotencySuffix: "NEW-SKU-IN",
    });

    return { applied: true, inventorySkuId: newSku.inventory_sku_id };
  }

  await applyQuantityDelta(tx, {
    ...input,
    inventorySkuId: input.previousInventorySkuId,
    inventoryStatus: inventoryRow.inventory_status,
    pgNo: input.pgNo,
    quantityDelta: -1,
    idempotencySuffix: "OLD-SKU-OUT",
  });
  await applyQuantityDelta(tx, {
    ...input,
    inventorySkuId: newSku.inventory_sku_id,
    inventoryStatus: inventoryRow.inventory_status,
    pgNo: input.pgNo,
    quantityDelta: 1,
    idempotencySuffix: "NEW-SKU-IN",
  });

  return { applied: true, inventorySkuId: newSku.inventory_sku_id };
}
