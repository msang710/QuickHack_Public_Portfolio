import type { Prisma } from "@/generated/prisma/client";
import { lockAggregateKey } from "@/quickhack_server/core/database/aggregate-command";
import { canonicalPgNos } from "@/quickhack_shared/inventory/pg-no";

export function buildDeviceAggregateLockPlan(pgNos: readonly unknown[]) {
  return Object.freeze(canonicalPgNos(pgNos));
}

export async function lockDeviceAggregates(
  tx: Prisma.TransactionClient,
  input: {
    pgNos: readonly unknown[];
    requireDevice?: boolean;
    requireInventory?: boolean;
    lockInventory?: boolean;
  }
) {
  const pgNos = buildDeviceAggregateLockPlan(input.pgNos);
  for (const pgNo of pgNos) {
    await lockAggregateKey(tx, { namespace: "device-inbound", key: pgNo });
  }
  const devices = [];
  for (const pgNo of pgNos) {
    const rows = await tx.$queryRaw<
      Array<{ device_id: number; revision: number; inventory_sku_id: number | null }>
    >`
      SELECT device_id, revision, inventory_sku_id
      FROM devices
      WHERE pg_no = ${pgNo}
      FOR UPDATE
    `;
    if (rows.length > 1) throw new Error(`More than one device root exists for PG ${pgNo}.`);
    if (input.requireDevice && rows.length === 0) throw new Error(`Device root does not exist for PG ${pgNo}.`);
    devices.push({ pgNo, row: rows[0] ?? null });
  }
  const inventories: Array<{
    pgNo: string;
    row: { inventory_id: number; revision: number; inventory_status: string } | null;
  }> = [];
  if (input.lockInventory !== false) {
    for (const pgNo of pgNos) {
      const rows = await tx.$queryRaw<
        Array<{ inventory_id: number; revision: number; inventory_status: string }>
      >`
        SELECT inventory_id, revision, inventory_status
        FROM inventory
        WHERE pg_no = ${pgNo}
        FOR UPDATE
      `;
      if (rows.length > 1) throw new Error(`More than one inventory root exists for PG ${pgNo}.`);
      if (input.requireInventory && rows.length === 0) throw new Error(`Inventory root does not exist for PG ${pgNo}.`);
      inventories.push({ pgNo, row: rows[0] ?? null });
    }
  }
  return { pgNos, devices, inventories };
}

export async function lockDeviceAggregateRow(
  tx: Prisma.TransactionClient,
  pgNo: string
) {
  const locked = await lockDeviceAggregates(tx, {
    pgNos: [pgNo],
    lockInventory: false,
  });
  return locked.devices[0]?.row?.device_id ?? null;
}
