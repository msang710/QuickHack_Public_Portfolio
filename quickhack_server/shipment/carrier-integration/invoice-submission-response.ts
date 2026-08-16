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
    errorMessage: "쿠팡 송장 등록을 완료하지 못했습니다.",
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
    message: completed
      ? "송장번호 채번과 쿠팡 송장 등록을 완료했습니다."
      : reviewRequired
        ? "송장 채번 결과는 보존되었지만 쿠팡 등록 결과를 점검해야 합니다."
        : allocating
          ? "다른 요청에서 송장번호를 채번 중입니다. 완료 후 결과를 확인하세요."
          : "송장 처리 결과를 저장했습니다.",
  } as const;
}
