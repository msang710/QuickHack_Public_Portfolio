import type { InvoiceReplacement } from "@/quickhack_client/components/invoice/invoice-operation-types";

export type MatchedWarrantyTabKey =
  | "coupang-2y"
  | "coupang-1y"
  | "external-2y"
  | "external-1y";

export type ShipmentOutputReturnMenuId =
  | "invoice-manual-issue"
  | "shipment-delivery-changes";

export type ShipmentOutputFocus = {
  replacementWorkId: number;
  issueBatchId: number;
  shipmentListPrintBatchId: number;
  tabKey: MatchedWarrantyTabKey;
  batchLabel: string;
  trackingNumber: string;
  returnMenuId: ShipmentOutputReturnMenuId;
};

type InvoiceIssueBatchIdentity = {
  issueBatchId: number;
  issueType: string;
};

const MATCHED_WARRANTY_TAB_KEYS = new Set<MatchedWarrantyTabKey>([
  "coupang-2y",
  "coupang-1y",
  "external-2y",
  "external-1y",
]);

export function isMatchedWarrantyTabKey(
  value: string | null | undefined
): value is MatchedWarrantyTabKey {
  return MATCHED_WARRANTY_TAB_KEYS.has(value as MatchedWarrantyTabKey);
}

export function shipmentOutputFocusForReplacement(
  replacement: InvoiceReplacement,
  returnMenuId: ShipmentOutputReturnMenuId
): ShipmentOutputFocus | null {
  if (
    !replacement.issueBatchId ||
    !replacement.shipmentListPrintBatchId ||
    !isMatchedWarrantyTabKey(replacement.shipmentListPrintTabKey) ||
    !replacement.shipmentListPrintTabKey.startsWith("coupang-")
  ) {
    return null;
  }

  return {
    replacementWorkId: replacement.replacementWorkId,
    issueBatchId: replacement.issueBatchId,
    shipmentListPrintBatchId: replacement.shipmentListPrintBatchId,
    tabKey: replacement.shipmentListPrintTabKey,
    batchLabel:
      replacement.shipmentListPrintBatchLabel ??
      `출력 차수 #${replacement.shipmentListPrintBatchId}`,
    trackingNumber:
      replacement.candidateTrackingNumber ?? replacement.oldTrackingNumber,
    returnMenuId,
  };
}

export function selectInvoiceIssueBatch<
  T extends InvoiceIssueBatchIdentity,
>(
  issueBatches: T[],
  preferredIssueBatchId?: number | null
): T | null {
  if (preferredIssueBatchId) {
    return (
      issueBatches.find(
        (candidate) => candidate.issueBatchId === preferredIssueBatchId
      ) ?? null
    );
  }

  return (
    issueBatches.find((candidate) => candidate.issueType === "INITIAL") ??
    issueBatches[0] ??
    null
  );
}
