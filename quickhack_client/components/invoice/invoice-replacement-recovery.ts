import type { InvoiceReplacement } from "./invoice-operation-types";
import {
  mutationWakeDeferred,
  type MutationReceipt,
} from "@/quickhack_shared/core/mutation-receipt";

type CarrierRegistrationRecoveryResponse = {
  ok?: boolean;
  message?: string;
  queuedCount?: number;
  receipt?: MutationReceipt<unknown>;
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

  const message = reconcileOnly
    ? "로젠의 실제 등록 상태를 다시 조회합니다."
    : "로젠 등록 작업을 다시 실행하도록 예약했습니다.";
  return mutationWakeDeferred(payload.receipt)
    ? `${message} 백그라운드 작업은 다음 실행 주기에 계속됩니다.`
    : message;
}
