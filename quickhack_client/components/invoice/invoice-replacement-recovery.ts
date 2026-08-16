import type { InvoiceReplacement } from "./invoice-operation-types";

type CarrierRegistrationRecoveryResponse = {
  ok?: boolean;
  message?: string;
  queuedCount?: number;
};

export async function recoverCarrierRegistration(
  replacement: InvoiceReplacement
) {
  if (!replacement.issueBatchId) {
    throw new Error("로젠 등록을 복구할 송장 발급 차수를 찾지 못했습니다.");
  }

  const registrationStatus = replacement.carrierRegistration?.status ?? "";
  const reconcileOnly = registrationStatus === "REVIEW_REQUIRED";
  const suffix = reconcileOnly ? "/reconcile" : "";
  const response = await fetch(
    `/api/invoices/issue-batches/${replacement.issueBatchId}/carrier-registration${suffix}`,
    { method: "POST" }
  );
  const payload = (await response.json().catch(() => null)) as
    | CarrierRegistrationRecoveryResponse
    | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(
      payload?.message || "로젠 등록 복구 작업을 시작하지 못했습니다."
    );
  }

  return reconcileOnly
    ? "로젠의 실제 등록 상태를 다시 조회합니다."
    : "로젠 등록 작업을 다시 실행하도록 예약했습니다.";
}
