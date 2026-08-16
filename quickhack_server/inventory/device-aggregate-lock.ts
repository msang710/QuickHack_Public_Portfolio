import type { Prisma } from "@/generated/prisma/client";

export async function lockDeviceAggregateRow(
  tx: Prisma.TransactionClient,
  pgNo: string
) {
  const rows = await tx.$queryRaw<Array<{ device_id: number }>>`
    SELECT device_id
    FROM devices
    WHERE pg_no = ${pgNo}
    FOR UPDATE
  `;
  if (rows.length > 1) {
    throw new Error(`More than one device root exists for PG ${pgNo}.`);
  }
  return rows[0]?.device_id ?? null;
}
