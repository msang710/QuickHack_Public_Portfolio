import {
  LIFECYCLE_DAY_MS,
  defineLifecyclePolicy,
  lifecycleCutoffExclusive,
} from "../../../quickhack_shared/lifecycle/lifecycle-policy.mjs";

export const MANUAL_ORDER_MATCH_RECEIPT_RETENTION_POLICY =
  defineLifecyclePolicy({
    retentionMs: 7 * LIFECYCLE_DAY_MS,
    maxBatchSize: 500,
  });

export const MANUAL_ORDER_MATCH_INTENT_RETENTION_POLICY =
  defineLifecyclePolicy({
    retentionMs: 30 * LIFECYCLE_DAY_MS,
    maxBatchSize: 500,
  });

export const MANUAL_ORDER_MATCH_RETENTION_MAX_BATCHES = 20;

export function manualOrderMatchRetentionCutoffs(referenceDate = new Date()) {
  return {
    receipt: lifecycleCutoffExclusive(
      referenceDate,
      MANUAL_ORDER_MATCH_RECEIPT_RETENTION_POLICY
    ),
    intent: lifecycleCutoffExclusive(
      referenceDate,
      MANUAL_ORDER_MATCH_INTENT_RETENTION_POLICY
    ),
  };
}
