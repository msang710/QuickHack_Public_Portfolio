import type { Prisma } from "@/generated/prisma/client";
import {
  recordOperationTransaction,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

type TransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

type TransactionClientOwner = {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;
};

export async function runMeasuredTransaction<T>(
  owner: TransactionClientOwner,
  name: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: TransactionOptions
) {
  const requestedAt = performance.now();
  let enteredAt: number | null = null;
  let callbackFinishedAt: number | null = null;

  try {
    return await traceOperationSpan(`transaction.${name}.total`, () =>
      owner.$transaction(async (tx) => {
        enteredAt = performance.now();

        try {
          return await traceOperationSpan(`transaction.${name}.run`, () =>
            callback(tx)
          );
        } finally {
          callbackFinishedAt = performance.now();
        }
      }, options)
    );
  } finally {
    const finishedAt = performance.now();
    const effectiveEnteredAt = enteredAt ?? finishedAt;
    const effectiveCallbackFinishedAt = callbackFinishedAt ?? effectiveEnteredAt;

    recordOperationTransaction({
      waitMs: effectiveEnteredAt - requestedAt,
      runMs: effectiveCallbackFinishedAt - effectiveEnteredAt,
      totalMs: finishedAt - requestedAt,
    });
  }
}
