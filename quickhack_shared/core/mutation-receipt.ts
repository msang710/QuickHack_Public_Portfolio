export const MUTATION_RECEIPT_OUTCOMES = Object.freeze({
  committed: "COMMITTED",
  observed: "OBSERVED",
  accepted: "ACCEPTED",
} as const);

export type MutationReceiptOutcome =
  (typeof MUTATION_RECEIPT_OUTCOMES)[keyof typeof MUTATION_RECEIPT_OUTCOMES];

export const MUTATION_WARNING_CODES = Object.freeze({
  refreshDeferred: "REFRESH_DEFERRED",
  workerWakeDeferred: "WORKER_WAKE_DEFERRED",
} as const);

export type MutationWarningCode =
  (typeof MUTATION_WARNING_CODES)[keyof typeof MUTATION_WARNING_CODES];

export type MutationWarning = {
  code: MutationWarningCode;
  retryable: true;
};

export type MutationReceipt<TResult> = {
  operationId: string;
  outcome: MutationReceiptOutcome;
  committedAt: string;
  result: TResult;
  refreshRequired: boolean;
  warnings: MutationWarning[];
};

export type MutationReceiptEnvelope<TResult> = {
  receipt?: MutationReceipt<TResult>;
};

export function mutationRefreshRequired(
  receipt: MutationReceipt<unknown> | null | undefined
) {
  return receipt?.refreshRequired === true;
}

export function mutationWakeDeferred(
  receipt: MutationReceipt<unknown> | null | undefined
) {
  return Boolean(
    receipt?.warnings.some(
      (warning) => warning.code === MUTATION_WARNING_CODES.workerWakeDeferred
    )
  );
}
