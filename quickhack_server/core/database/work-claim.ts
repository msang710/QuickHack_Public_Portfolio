import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";

type TransactionOwner = {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T>;
};

export type WorkClaimSeed = {
  leaseToken: string;
  lockedUntil: Date;
};

export type WorkClaimIdentity = WorkClaimSeed & {
  claimGeneration: number;
};

export class WorkClaimOwnershipLostError extends Error {
  readonly code = "WORK_CLAIM_OWNERSHIP_LOST";
  readonly workKey: string;

  constructor(workKey: string, detail?: string) {
    super(detail ? `Work claim lost (${workKey}): ${detail}` : `Work claim lost (${workKey}).`);
    this.name = "WorkClaimOwnershipLostError";
    this.workKey = workKey;
  }
}

export function newWorkClaimSeed(lockSeconds: number): WorkClaimSeed {
  const now = databaseNow();
  return {
    leaseToken: randomUUID(),
    lockedUntil: new Date(now.getTime() + Math.max(1, lockSeconds) * 1000),
  };
}

export async function claimWork<T>(input: {
  owner: TransactionOwner;
  name: string;
  lockSeconds: number;
  claim: (
    tx: Prisma.TransactionClient,
    seed: WorkClaimSeed
  ) => Promise<readonly T[]>;
  generationOf: (row: T) => number;
}) {
  return runMeasuredTransaction(input.owner, `work_claim.${input.name}`, async (tx) => {
    const seed = newWorkClaimSeed(input.lockSeconds);
    const rows = await input.claim(tx, seed);
    if (rows.length > 1) {
      throw new Error(`Work claim returned more than one row: ${input.name}.`);
    }
    const row = rows[0];
    if (!row) return null;
    const claimGeneration = input.generationOf(row);
    if (!Number.isSafeInteger(claimGeneration) || claimGeneration <= 0) {
      throw new Error(`Work claim returned an invalid generation: ${input.name}.`);
    }
    return { row, ...seed, claimGeneration };
  });
}

export function assertOwnedWorkMutation(
  affectedCount: number,
  workKey: string,
  detail: string
) {
  if (affectedCount !== 1) {
    throw new WorkClaimOwnershipLostError(workKey, detail);
  }
}
