import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { isRetryablePostgresqlTransactionError } from "@/quickhack_server/core/database/postgres-errors";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { setOperationTraceField } from "@/quickhack_server/observability/operation-trace";

type TransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

type TransactionOwner = {
  $transaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;
};

export class DomainOperationKeyConflictError extends Error {
  readonly code = "DOMAIN_OPERATION_KEY_CONFLICT";
  readonly scope: string;
  readonly operationKey: string;

  constructor(scope: string, operationKey: string) {
    super(`Domain operation key was reused with a different request: ${scope}.`);
    this.name = "DomainOperationKeyConflictError";
    this.scope = scope;
    this.operationKey = operationKey;
  }
}

export class AtomicInsertObservationError extends Error {
  readonly code = "ATOMIC_INSERT_OBSERVATION_MISSING";
  constructor(name: string) {
    super(`Atomic insert lost a conflict but could not observe the winner: ${name}.`);
    this.name = "AtomicInsertObservationError";
  }
}

export type AtomicInsertOrObserveResult<T> = {
  row: T;
  inserted: boolean;
};

export async function insertOrObserve<T>(input: {
  name: string;
  insert: () => Promise<readonly T[]>;
  observe: () => Promise<T | null>;
}): Promise<AtomicInsertOrObserveResult<T>> {
  const inserted = await input.insert();
  if (inserted.length > 1) {
    throw new Error(`Atomic insert returned more than one row: ${input.name}.`);
  }
  if (inserted.length === 1) return { row: inserted[0], inserted: true };

  const observed = await input.observe();
  if (!observed) throw new AtomicInsertObservationError(input.name);
  return { row: observed, inserted: false };
}

export async function lockAggregateRow<T>(input: {
  name: string;
  lock: () => Promise<readonly T[]>;
}) {
  const rows = await input.lock();
  if (rows.length > 1) {
    throw new Error(`Aggregate lock returned more than one row: ${input.name}.`);
  }
  return rows[0] ?? null;
}

// PostgreSQL advisory transaction locks cover aggregate identities whose root row
// does not exist yet (for example, the first inbound received for a PG).
export async function lockAggregateKey(
  tx: Prisma.TransactionClient,
  input: { namespace: string; key: string }
) {
  const namespace = input.namespace.trim();
  const key = input.key.trim();
  if (!namespace || !key) {
    throw new Error("Aggregate lock namespace and key are required.");
  }

  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${namespace}:${key}`}, 0)
    ) AS locked
  `;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "[undefined]";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function digestDomainOperation(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export async function reserveDomainOperationKey(
  tx: Prisma.TransactionClient,
  input: {
    scope: string;
    operationKey: string;
    aggregateType: string;
    aggregateId: string;
    requestDigest: string;
  }
) {
  const operationId = randomUUID();
  const createdAt = databaseNow();
  const inserted = await tx.$queryRaw<Array<{ operation_id: string }>>`
    INSERT INTO domain_operation_keys (
      operation_id,
      scope,
      operation_key,
      aggregate_type,
      aggregate_id,
      request_digest,
      status,
      created_at
    ) VALUES (
      ${operationId}::uuid,
      ${input.scope},
      ${input.operationKey},
      ${input.aggregateType},
      ${input.aggregateId},
      ${input.requestDigest},
      'COMMITTED',
      ${createdAt}
    )
    ON CONFLICT (scope, operation_key) DO NOTHING
    RETURNING operation_id
  `;

  const row = inserted.length === 1
    ? await tx.domain_operation_keys.findUniqueOrThrow({
        where: { operation_id: inserted[0].operation_id },
      })
    : await tx.domain_operation_keys.findUniqueOrThrow({
        where: {
          scope_operation_key: {
            scope: input.scope,
            operation_key: input.operationKey,
          },
        },
      });

  if (
    row.aggregate_type !== input.aggregateType ||
    row.aggregate_id !== input.aggregateId ||
    row.request_digest !== input.requestDigest
  ) {
    throw new DomainOperationKeyConflictError(input.scope, input.operationKey);
  }

  return { row, owned: inserted.length === 1 } as const;
}

export async function completeDomainOperationKey(
  tx: Prisma.TransactionClient,
  operationId: string,
  resultDigest: string
) {
  await tx.domain_operation_keys.update({
    where: { operation_id: operationId },
    data: { result_digest: resultDigest },
  });
}

function retryDelay(attempt: number) {
  const base = Math.min(100, 10 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * base);
}

export async function runRetriableMeasuredTransaction<T>(
  owner: TransactionOwner,
  name: string,
  callback: (tx: Prisma.TransactionClient, attempt: number) => Promise<T>,
  options: TransactionOptions & { maxAttempts?: number } = {}
) {
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  const { maxAttempts: _ignored, ...transactionOptions } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runMeasuredTransaction(
        owner,
        name,
        (tx) => callback(tx, attempt),
        transactionOptions
      );
      setOperationTraceField("db.transaction_attempts", attempt);
      return result;
    } catch (error) {
      if (!isRetryablePostgresqlTransactionError(error) || attempt >= maxAttempts) {
        setOperationTraceField("db.transaction_attempts", attempt);
        throw error;
      }
      setOperationTraceField("db.transaction_retry_count", attempt);
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
    }
  }

  throw new Error(`Transaction retry loop exhausted unexpectedly: ${name}.`);
}
