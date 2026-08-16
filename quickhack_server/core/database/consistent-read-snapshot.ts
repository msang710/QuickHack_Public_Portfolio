import type { Prisma } from "@/generated/prisma/client";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";

type ReadSnapshotOwner = {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    }
  ): Promise<T>;
};

type ConsistentReadSnapshotOptions = {
  maxWait?: number;
  timeout?: number;
};

// PostgreSQL READ COMMITTED takes a new snapshot for every statement. Multi-query
// projections must use this boundary so every page and aggregate is derived from
// the same committed database state. READ ONLY also makes accidental writes fail.
export function runConsistentReadSnapshot<T>(
  owner: ReadSnapshotOwner,
  name: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: ConsistentReadSnapshotOptions = {}
) {
  return runMeasuredTransaction(
    owner,
    name,
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return callback(tx);
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: options.maxWait ?? 10_000,
      timeout: options.timeout ?? 60_000,
    }
  );
}
