import type { Prisma } from "@/generated/prisma/client";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";

export const QUICKHACK_SERVER_STATE_KEY = "QUICKHACK";

export type LockedServerSecurityState = {
  instance_epoch: number;
  revision: number;
};

export async function lockServerSecurityState(
  tx: Prisma.TransactionClient
): Promise<LockedServerSecurityState> {
  const rows = await tx.$queryRaw<LockedServerSecurityState[]>`
    SELECT instance_epoch, revision
    FROM server_instance_state
    WHERE singleton_key = ${QUICKHACK_SERVER_STATE_KEY}
    FOR SHARE
  `;

  if (rows.length !== 1) {
    throw new Error("QuickHack server security state is not initialized.");
  }

  return rows[0];
}

export async function lockAndAdvanceServerSecurityState(
  tx: Prisma.TransactionClient
): Promise<LockedServerSecurityState> {
  const rows = await tx.$queryRaw<LockedServerSecurityState[]>`
    UPDATE server_instance_state
    SET revision = revision + 1,
        updated_at = ${databaseNow()}
    WHERE singleton_key = ${QUICKHACK_SERVER_STATE_KEY}
    RETURNING instance_epoch, revision
  `;

  if (rows.length !== 1) {
    throw new Error("QuickHack server security state is not initialized.");
  }

  return rows[0];
}
