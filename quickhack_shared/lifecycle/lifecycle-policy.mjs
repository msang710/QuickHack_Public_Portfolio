export const LIFECYCLE_DAY_MS = 24 * 60 * 60 * 1_000;
export const LIFECYCLE_MAX_BATCH_SIZE = 1_000;

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

export function defineLifecyclePolicy(input) {
  const retentionMs = nonNegativeSafeInteger(
    input?.retentionMs,
    "retentionMs"
  );
  const graceMs = nonNegativeSafeInteger(input?.graceMs ?? 0, "graceMs");
  const maxBatchSize = nonNegativeSafeInteger(
    input?.maxBatchSize,
    "maxBatchSize"
  );
  if (maxBatchSize < 1 || maxBatchSize > LIFECYCLE_MAX_BATCH_SIZE) {
    throw new TypeError(
      `maxBatchSize must be between 1 and ${LIFECYCLE_MAX_BATCH_SIZE}.`
    );
  }
  const keepLatest = nonNegativeSafeInteger(
    input?.keepLatest ?? 0,
    "keepLatest"
  );
  return Object.freeze({ retentionMs, graceMs, maxBatchSize, keepLatest });
}

export function lifecycleCutoffExclusive(referenceDate, policy, options = {}) {
  const referenceMs = new Date(referenceDate).getTime();
  if (!Number.isFinite(referenceMs)) {
    throw new TypeError("referenceDate must be a valid date.");
  }
  const durationMs = options.useGrace
    ? policy.graceMs
    : policy.retentionMs;
  return new Date(referenceMs - durationMs);
}

export function isStrictlyBeforeLifecycleCutoff(value, cutoffExclusive) {
  const valueMs = new Date(value).getTime();
  const cutoffMs = new Date(cutoffExclusive).getTime();
  return (
    Number.isFinite(valueMs) &&
    Number.isFinite(cutoffMs) &&
    valueMs < cutoffMs
  );
}

export function lifecycleAgeMs(referenceDate, timestamp) {
  const referenceMs = new Date(referenceDate).getTime();
  const timestampMs = new Date(timestamp).getTime();
  if (!Number.isFinite(referenceMs) || !Number.isFinite(timestampMs)) {
    return null;
  }
  return Math.max(0, referenceMs - timestampMs);
}

export function resolveLifecycleBatchSize(policy, override) {
  if (override === undefined) return policy.maxBatchSize;
  if (!Number.isSafeInteger(override) || override < 1) {
    throw new TypeError("maxBatchSize override must be a positive safe integer.");
  }
  return Math.min(policy.maxBatchSize, override);
}
