import { SALES_CHANNEL_WRITE_REQUEST_STATUS } from "@/quickhack_shared/sales-channel/write-requests";

export const SALES_CHANNEL_WRITE_RETRYABLE_REQUEST_STATUSES = [
  SALES_CHANNEL_WRITE_REQUEST_STATUS.rejected,
  SALES_CHANNEL_WRITE_REQUEST_STATUS.notApplied,
] as const;

const RETRYABLE_REQUEST_STATUS_SET = new Set<string>(
  SALES_CHANNEL_WRITE_RETRYABLE_REQUEST_STATUSES
);

export function isSalesChannelWriteRequestRetryable(status: string) {
  return RETRYABLE_REQUEST_STATUS_SET.has(status);
}
