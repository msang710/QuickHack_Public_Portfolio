export const LIFECYCLE_DAY_MS: number;
export const LIFECYCLE_MAX_BATCH_SIZE: 1000;

export type LifecyclePolicy = Readonly<{
  retentionMs: number;
  graceMs: number;
  maxBatchSize: number;
  keepLatest: number;
}>;

export function defineLifecyclePolicy(input: {
  retentionMs: number;
  graceMs?: number;
  maxBatchSize: number;
  keepLatest?: number;
}): LifecyclePolicy;

export function lifecycleCutoffExclusive(
  referenceDate: Date | string | number,
  policy: LifecyclePolicy,
  options?: { useGrace?: boolean }
): Date;

export function isStrictlyBeforeLifecycleCutoff(
  value: Date | string | number,
  cutoffExclusive: Date | string | number
): boolean;

export function lifecycleAgeMs(
  referenceDate: Date | string | number,
  timestamp: Date | string | number
): number | null;

export function resolveLifecycleBatchSize(
  policy: LifecyclePolicy,
  override?: number
): number;
