import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import {
  assertWorkerLeaseActive,
  throwIfWorkerLeaseAborted,
} from "@/quickhack_server/workers/lease-guard";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";

type CountRow = { count: bigint | number };

const KNOWN_INVENTORY_STATUSES = new Set<string>(Object.values(INVENTORY_STATUS));

function countValue(rows: CountRow[]) {
  return Number(rows[0]?.count ?? 0);
}

async function auditLedgerStructure(client: Prisma.TransactionClient) {
  const [movementGroupRows, balanceTailRows, unknownMovementTypeRows] =
    await Promise.all([
      client.$queryRawUnsafe<CountRow[]>(`
      SELECT count(*) AS count
      FROM (
        SELECT operation_key, movement_type
        FROM inventory_quantity_movements
        GROUP BY operation_key, movement_type
        HAVING
          (
            movement_type IN ('STATUS_TRANSFER', 'SKU_RECLASSIFICATION')
            AND (
              count(*) <> 2
              OR coalesce(sum(quantity_delta), 0) <> 0
              OR sum(CASE WHEN quantity_delta = -1 THEN 1 ELSE 0 END) <> 1
              OR sum(CASE WHEN quantity_delta = 1 THEN 1 ELSE 0 END) <> 1
            )
          )
          OR (
            movement_type = 'INVENTORY_CREATED'
            AND (count(*) <> 1 OR coalesce(sum(quantity_delta), 0) <> 1)
          )
          OR (
            movement_type = 'INVENTORY_REMOVED'
            AND (count(*) <> 1 OR coalesce(sum(quantity_delta), 0) <> -1)
          )
      ) AS invalid_groups
      `),
      client.$queryRawUnsafe<CountRow[]>(`
      SELECT count(*) AS count
      FROM inventory_quantity_balances AS balance
      LEFT JOIN inventory_quantity_movements AS movement
        ON movement.inventory_quantity_movement_id = (
          SELECT max(latest.inventory_quantity_movement_id)
          FROM inventory_quantity_movements AS latest
          WHERE latest.inventory_quantity_balance_id =
            balance.inventory_quantity_balance_id
        )
      WHERE movement.inventory_quantity_movement_id IS NULL
         OR movement.after_quantity <> balance.quantity
      `),
      client.$queryRawUnsafe<CountRow[]>(`
        SELECT count(*) AS count
        FROM inventory_quantity_movements
        WHERE movement_type NOT IN (
          'INVENTORY_CREATED',
          'STATUS_TRANSFER',
          'SKU_RECLASSIFICATION',
          'INVENTORY_REMOVED'
        )
      `),
    ]);

  return {
    invalidMovementGroupCount: countValue(movementGroupRows),
    balanceTailMismatchCount: countValue(balanceTailRows),
    unknownMovementTypeCount: countValue(unknownMovementTypeRows),
  };
}

function balanceKey(inventorySkuId: number, inventoryStatus: string) {
  return `${inventorySkuId}\u0000${inventoryStatus}`;
}

async function auditInventoryQuantityLedgerSnapshot(
  client: Prisma.TransactionClient,
  workerLease?: WorkerLeaseGuard
) {
  const [inventoryRows, balanceRows, structureAudit] = await Promise.all([
    client.inventory.findMany({
      include: {
        devices: {
          select: { inventory_sku_id: true },
        },
      },
    }),
    client.inventory_quantity_balances.findMany(),
    auditLedgerStructure(client),
  ]);
  const actual = new Map<string, number>();
  let unclassifiedCount = 0;
  let unknownStatusCount = 0;

  for (const row of inventoryRows) {
    throwIfWorkerLeaseAborted(workerLease);
    if (!KNOWN_INVENTORY_STATUSES.has(row.inventory_status)) {
      unknownStatusCount += 1;
    }

    const inventorySkuId = row.devices.inventory_sku_id;

    if (!inventorySkuId) {
      unclassifiedCount += 1;
      continue;
    }

    const key = balanceKey(inventorySkuId, row.inventory_status);
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }

  const balanceByKey = new Map(
    balanceRows.map((row) => [
      balanceKey(row.inventory_sku_id, row.inventory_status),
      row,
    ])
  );
  unknownStatusCount += balanceRows.filter(
    (row) => !KNOWN_INVENTORY_STATUSES.has(row.inventory_status)
  ).length;
  const allKeys = new Set([...actual.keys(), ...balanceByKey.keys()]);
  const mismatches = [...allKeys].flatMap((key) => {
    const expectedQuantity = actual.get(key) ?? 0;
    const balance = balanceByKey.get(key);
    const recordedQuantity = balance?.quantity ?? 0;

    if (expectedQuantity === recordedQuantity) {
      return [];
    }

    const [inventorySkuId, inventoryStatus] = key.split("\u0000");

    return [{
      inventorySkuId: Number(inventorySkuId),
      inventoryStatus,
      expectedQuantity,
      recordedQuantity,
      difference: recordedQuantity - expectedQuantity,
    }];
  });

  const invariantViolationCount =
    unclassifiedCount +
    unknownStatusCount +
    mismatches.length +
    structureAudit.invalidMovementGroupCount +
    structureAudit.balanceTailMismatchCount +
    structureAudit.unknownMovementTypeCount;

  return {
    inventoryRowCount: inventoryRows.length,
    balanceRowCount: balanceRows.length,
    unclassifiedCount,
    unknownStatusCount,
    mismatchCount: mismatches.length,
    mismatches,
    ...structureAudit,
    invariantViolationCount,
  };
}

export async function auditInventoryQuantityLedger(
  workerLease?: WorkerLeaseGuard,
  owner: PrismaClient = prisma
) {
  await assertWorkerLeaseActive(workerLease);
  const audit = await runConsistentReadSnapshot(
    owner,
    "inventory.quantity-ledger.audit",
    (tx) => auditInventoryQuantityLedgerSnapshot(tx, workerLease),
    { timeout: 120_000 }
  );
  await assertWorkerLeaseActive(workerLease);

  if (audit.invariantViolationCount > 0) {
    throw new Error(
      `재고 수량 원장 불변 조건 위반 ${audit.invariantViolationCount}건이 발견되었습니다. 자동 보정하지 않습니다.`
    );
  }

  return audit;
}
