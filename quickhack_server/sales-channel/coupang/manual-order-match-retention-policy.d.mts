export const MANUAL_ORDER_MATCH_RECEIPT_RETENTION_POLICY: Readonly<{
  retentionMs: number;
  graceMs: number;
  maxBatchSize: number;
  keepLatest: number;
}>;
export const MANUAL_ORDER_MATCH_INTENT_RETENTION_POLICY: typeof MANUAL_ORDER_MATCH_RECEIPT_RETENTION_POLICY;
export const MANUAL_ORDER_MATCH_RETENTION_MAX_BATCHES: number;
export function manualOrderMatchRetentionCutoffs(referenceDate?: Date): {
  receipt: Date;
  intent: Date;
};
