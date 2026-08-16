import { createHash, randomUUID } from "node:crypto";
import {
  MUTATION_RECEIPT_OUTCOMES,
  MUTATION_WARNING_CODES,
  type MutationReceipt,
  type MutationReceiptOutcome,
  type MutationWarningCode,
} from "@/quickhack_shared/core/mutation-receipt";
import { setOperationTraceField } from "@/quickhack_server/observability/operation-trace";

function operationIdentityPart(value: string | number | boolean | null) {
  return value === null ? "null" : String(value);
}

export function stableMutationOperationId(
  scope: string,
  identity: readonly (string | number | boolean | null)[]
) {
  const normalizedScope = scope
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const digest = createHash("sha256")
    .update(JSON.stringify(identity.map(operationIdentityPart)))
    .digest("hex")
    .slice(0, 32);

  return `${normalizedScope || "mutation"}:${digest}`;
}

export function randomMutationOperationId(scope: string) {
  const normalizedScope = scope
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${normalizedScope || "mutation"}:${randomUUID()}`;
}

export function createMutationReceipt<TResult>(
  result: TResult,
  input: {
    operationId: string;
    outcome?: MutationReceiptOutcome;
    committedAt?: Date | string;
  }
): MutationReceipt<TResult> {
  const candidateCommittedAt =
    input.committedAt instanceof Date
      ? input.committedAt
      : typeof input.committedAt === "string"
        ? new Date(input.committedAt)
        : null;
  const committedAt =
    candidateCommittedAt && Number.isFinite(candidateCommittedAt.getTime())
      ? candidateCommittedAt.toISOString()
      : new Date().toISOString();
  const receipt: MutationReceipt<TResult> = {
    operationId: input.operationId,
    outcome: input.outcome ?? MUTATION_RECEIPT_OUTCOMES.committed,
    committedAt,
    result,
    refreshRequired: false,
    warnings: [],
  };

  setOperationTraceField("mutation.outcome", receipt.outcome);
  return receipt;
}

function withWarning<TResult>(
  receipt: MutationReceipt<TResult>,
  code: MutationWarningCode
) {
  if (receipt.warnings.some((warning) => warning.code === code)) {
    return receipt;
  }

  setOperationTraceField("mutation.post_commit_warning", code);
  return {
    ...receipt,
    refreshRequired:
      receipt.refreshRequired || code === MUTATION_WARNING_CODES.refreshDeferred,
    warnings: [...receipt.warnings, { code, retryable: true as const }],
  };
}

export type OptionalMutationStep<TResult, TValue> =
  | {
      completed: true;
      receipt: MutationReceipt<TResult>;
      value: TValue;
    }
  | {
      completed: false;
      receipt: MutationReceipt<TResult>;
    };

export async function settleOptionalMutationRefresh<TResult, TValue>(
  receipt: MutationReceipt<TResult>,
  refresh: () => Promise<TValue>
): Promise<OptionalMutationStep<TResult, TValue>> {
  try {
    return { completed: true, receipt, value: await refresh() };
  } catch {
    return {
      completed: false,
      receipt: withWarning(receipt, MUTATION_WARNING_CODES.refreshDeferred),
    };
  }
}

export async function settleOptionalWorkerWake<TResult>(
  receipt: MutationReceipt<TResult>,
  wake: () => void | Promise<void>
) {
  try {
    await wake();
    return receipt;
  } catch {
    return withWarning(receipt, MUTATION_WARNING_CODES.workerWakeDeferred);
  }
}
