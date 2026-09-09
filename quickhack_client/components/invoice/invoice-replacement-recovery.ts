import type { InvoiceReplacement } from "./invoice-operation-types";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
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
  replacement: InvoiceReplacement,
  message: (
    key:
      | "missingBatch"
      | "startFailed"
      | "reconcileQueued"
      | "retryQueued"
      | "backgroundDeferred"
  ) => string
) {
  if (!replacement.issueBatchId) {
    throw new Error(message("missingBatch"));
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
      legacyApiMessage(payload, message("startFailed"))
    );
  }

  const resultMessage = message(reconcileOnly ? "reconcileQueued" : "retryQueued");
  return mutationWakeDeferred(payload.receipt)
    ? `${resultMessage} ${message("backgroundDeferred")}`
    : resultMessage;
}
