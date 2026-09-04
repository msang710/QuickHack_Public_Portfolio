export type InvoiceChannelSubmission = {
  status: "COMPLETED" | "REVIEW_REQUIRED" | "PARTIAL" | "FAILED";
  completedCount?: number;
  reviewRequiredCount?: number;
  requests?: Array<{
    requestId: number | null;
    status: string;
    skipped?: boolean;
    error?: string | null;
  }>;
  errorCode?: string;
  errorMessage?: string;
};

export function failedInvoiceChannelSubmission(
  errorCode = "COUPANG_INVOICE_SUBMIT_FAILED"
): InvoiceChannelSubmission {
  return {
    status: "FAILED",
    errorCode,
    requests: [],
  };
}

export function buildInvoiceIssueMutationResponse(input: {
  issueBatch: { status: string };
  channelSubmission: InvoiceChannelSubmission | null;
}) {
  const allocated = input.issueBatch.status === "ALLOCATED";
  const allocating = input.issueBatch.status === "ALLOCATING";
  const failed = input.issueBatch.status === "FAILED";
  const channelStatus = input.channelSubmission?.status ?? null;
  const completed = allocated && channelStatus === "COMPLETED";
  const reviewRequired =
    input.issueBatch.status === "REVIEW_REQUIRED" ||
    channelStatus === "REVIEW_REQUIRED" ||
    channelStatus === "PARTIAL" ||
    channelStatus === "FAILED";
  const requestIds = (input.channelSubmission?.requests ?? [])
    .map((request) => request.requestId)
    .filter((requestId): requestId is number => Number.isSafeInteger(requestId));
  return {
    ok: completed,
    reviewRequired,
    partial: channelStatus === "PARTIAL",
    requestIds,
    status: completed ? 200 : failed ? 502 : 202,
    resultCode: completed
      ? "INVOICE_ISSUE_COMPLETED"
      : reviewRequired
        ? "INVOICE_ISSUE_REVIEW_REQUIRED"
        : allocating
          ? "INVOICE_ISSUE_ALLOCATING"
          : "INVOICE_ISSUE_RESULT_SAVED",
  } as const;
}
