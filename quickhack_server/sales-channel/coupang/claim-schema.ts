import {
  expectIntegrationArray,
  expectIntegrationDecimalId,
  expectIntegrationObject,
  expectIntegrationSafeInteger,
  schemaError,
} from "@/quickhack_server/integration/schema-validation";
import {
  coupangReturnReasonLabel,
  normalizeCoupangReasonLabel,
} from "@/quickhack_shared/sales-channel/coupang-return-reasons";

type ValidationContext = { provider: string; endpoint: string };

export type StrictCoupangReturnItem = {
  externalShipmentId: string;
  externalVendorItemId: string;
  sellerProductItemId: string | null;
  vendorItemName: string | null;
  cancelCount: number;
  reasonCode: string | null;
  reasonLabel: string | null;
};

export type StrictCoupangReturn = {
  externalReceiptId: string;
  externalOrderId: string;
  externalShipmentId: string;
  cancelType: string;
  receiptType: string;
  receiptStatus: string;
  reasonCode: string | null;
  reasonLabel: string | null;
  reasonCategory: string | null;
  reasonDetail: string | null;
  historyReasonDetail: string | null;
  releaseStatus: string | null;
  faultByType: string | null;
  externalCreatedAt: string | null;
  externalModifiedAt: string | null;
  externalCompletedAt: string | null;
  externalCompletionType: string | null;
  invalidTimestampCount: number;
  cancelCount: number;
  itemIntegrityStatus: "VALID" | "COUNT_MISMATCH";
  items: StrictCoupangReturnItem[];
};

export type StrictCoupangExchange = {
  externalExchangeId: string;
  externalOrderId: string;
  externalShipmentId: string | null;
  externalShipmentIds: string[];
  scopeIntegrityStatus: "VALID" | "MISSING_SCOPE";
  exchangeStatus: string;
  faultByType: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  reasonDetail: string | null;
  externalCreatedAt: string | null;
  externalModifiedAt: string | null;
  invalidTimestampCount: number;
};

export type StrictCoupangReturnWithdrawal = {
  externalReceiptId: string;
  externalOrderId: string;
  externalWithdrawnAt: string | null;
  refundDeliveryDuty: string | null;
  vendorItemIds: string;
  invalidTimestampCount: number;
};

function optionalText(value: unknown, context: ValidationContext, path: string) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    return schemaError({ ...context, path, reason: "EXPECTED_TEXT" });
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function requiredText(value: unknown, context: ValidationContext, path: string) {
  const normalized = optionalText(value, context, path);
  if (!normalized) return schemaError({ ...context, path, reason: "REQUIRED_TEXT" });
  return normalized;
}

function positiveInteger(value: unknown, context: ValidationContext, path: string) {
  const parsed = expectIntegrationSafeInteger(value, context, path);
  if (parsed <= 0) {
    return schemaError({ ...context, path, reason: "EXPECTED_POSITIVE_SAFE_INTEGER" });
  }
  return parsed;
}

function optionalTimestamp(value: unknown, context: ValidationContext, path: string) {
  const text = optionalText(value, context, path);
  if (!text) return { value: null, invalid: false } as const;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return { value: null, invalid: true } as const;
  return { value: parsed.toISOString(), invalid: false } as const;
}

function successEnvelope(payload: unknown, context: ValidationContext) {
  const root = expectIntegrationObject(payload, context);
  if (root.code === undefined || root.code === null) {
    return schemaError({ ...context, path: "$.code", reason: "MISSING_SUCCESS_CODE" });
  }
  const code = String(root.code).trim().toUpperCase();
  if (!["200", "SUCCESS"].includes(code)) {
    return schemaError({ ...context, path: "$.code", reason: "APPLICATION_ERROR" });
  }
  return root;
}

function normalizeFault(value: unknown, context: ValidationContext, path: string) {
  return optionalText(value, context, path)?.toUpperCase() ?? null;
}

function normalizeReasonDetail(value: unknown, context: ValidationContext, path: string) {
  return normalizeCoupangReasonLabel(optionalText(value, context, path));
}

function returnRow(value: unknown, context: ValidationContext, path: string): StrictCoupangReturn {
  const row = expectIntegrationObject(value, context, path);
  const rawItems = expectIntegrationArray(row.returnItems, context, `${path}.returnItems`);
  if (rawItems.length === 0) {
    return schemaError({ ...context, path: `${path}.returnItems`, reason: "EMPTY_RETURN_ITEMS" });
  }
  const items = rawItems.map((itemValue, index) => {
    const itemPath = `${path}.returnItems[${index}]`;
    const item = expectIntegrationObject(itemValue, context, itemPath);
    const reasonCode = optionalText(item.reasonCode ?? row.reasonCode, context, `${itemPath}.reasonCode`);
    return {
      externalShipmentId: expectIntegrationDecimalId(item.shipmentBoxId, context, `${itemPath}.shipmentBoxId`),
      externalVendorItemId: expectIntegrationDecimalId(item.vendorItemId, context, `${itemPath}.vendorItemId`),
      sellerProductItemId:
        item.sellerProductItemId == null
          ? null
          : expectIntegrationDecimalId(item.sellerProductItemId, context, `${itemPath}.sellerProductItemId`),
      vendorItemName: optionalText(item.vendorItemName, context, `${itemPath}.vendorItemName`),
      cancelCount: positiveInteger(item.cancelCount, context, `${itemPath}.cancelCount`),
      reasonCode,
      reasonLabel:
        normalizeCoupangReasonLabel(optionalText(item.reasonCodeText, context, `${itemPath}.reasonCodeText`)) ||
        coupangReturnReasonLabel(reasonCode) ||
        null,
    };
  });
  const itemCount = items.reduce((sum, item) => sum + item.cancelCount, 0);
  const cancelCount = positiveInteger(row.cancelCountSum, context, `${path}.cancelCountSum`);
  const createdAt = optionalTimestamp(row.createdAt, context, `${path}.createdAt`);
  const modifiedAt = optionalTimestamp(row.modifiedAt, context, `${path}.modifiedAt`);
  const completedAt = optionalTimestamp(row.completeConfirmDate, context, `${path}.completeConfirmDate`);
  const reasonCode = optionalText(row.reasonCode, context, `${path}.reasonCode`);
  const rawReceiptType = requiredText(row.cancelType ?? row.receiptType, context, `${path}.receiptType`);
  const shipmentIds = [...new Set(items.map((item) => item.externalShipmentId))].sort();

  return {
    externalReceiptId: expectIntegrationDecimalId(row.receiptId, context, `${path}.receiptId`),
    externalOrderId: expectIntegrationDecimalId(row.orderId, context, `${path}.orderId`),
    externalShipmentId: shipmentIds[0],
    cancelType: rawReceiptType,
    receiptType: rawReceiptType.toUpperCase(),
    receiptStatus: requiredText(row.receiptStatus ?? row.status, context, `${path}.receiptStatus`),
    reasonCode,
    reasonLabel:
      normalizeCoupangReasonLabel(optionalText(row.reasonCodeText, context, `${path}.reasonCodeText`)) ||
      coupangReturnReasonLabel(reasonCode) ||
      null,
    reasonCategory: normalizeReasonDetail(row.cancelReasonCategory1, context, `${path}.cancelReasonCategory1`),
    reasonDetail: normalizeReasonDetail(row.cancelReason ?? row.reasonEtcDetail, context, `${path}.cancelReason`),
    historyReasonDetail: normalizeReasonDetail(row.cancelReason ?? row.reasonEtcDetail, context, `${path}.cancelReason`),
    releaseStatus: optionalText(row.releaseStatus ?? row.releaseStopStatus, context, `${path}.releaseStatus`),
    faultByType: normalizeFault(row.faultByType, context, `${path}.faultByType`),
    externalCreatedAt: createdAt.value,
    externalModifiedAt: modifiedAt.value,
    externalCompletedAt: completedAt.value,
    externalCompletionType: optionalText(row.completeConfirmType, context, `${path}.completeConfirmType`),
    invalidTimestampCount: [createdAt, modifiedAt, completedAt].filter((item) => item.invalid).length,
    cancelCount,
    itemIntegrityStatus: cancelCount === itemCount ? "VALID" : "COUNT_MISMATCH",
    items,
  };
}

function exchangeRow(value: unknown, context: ValidationContext, path: string): StrictCoupangExchange {
  const row = expectIntegrationObject(value, context, path);
  const items = expectIntegrationArray(row.exchangeItemDtoV1s, context, `${path}.exchangeItemDtoV1s`);
  const scopes = items.flatMap((itemValue, index) => {
    const item = expectIntegrationObject(itemValue, context, `${path}.exchangeItemDtoV1s[${index}]`);
    const raw = item.originalShipmentBoxId;
    if (raw === null || raw === undefined || String(raw).trim() === "") return [];
    return [expectIntegrationDecimalId(raw, context, `${path}.exchangeItemDtoV1s[${index}].originalShipmentBoxId`)];
  });
  const rootScope = row.originalShipmentBoxId == null
    ? null
    : expectIntegrationDecimalId(row.originalShipmentBoxId, context, `${path}.originalShipmentBoxId`);
  const shipmentIds = [...new Set([...(rootScope ? [rootScope] : []), ...scopes])].sort();
  const createdAt = optionalTimestamp(row.createdAt, context, `${path}.createdAt`);
  const modifiedAt = optionalTimestamp(row.modifiedAt, context, `${path}.modifiedAt`);

  return {
    externalExchangeId: expectIntegrationDecimalId(row.exchangeId, context, `${path}.exchangeId`),
    externalOrderId: expectIntegrationDecimalId(row.orderId, context, `${path}.orderId`),
    externalShipmentId: shipmentIds[0] ?? null,
    externalShipmentIds: shipmentIds,
    scopeIntegrityStatus: shipmentIds.length > 0 ? "VALID" : "MISSING_SCOPE",
    exchangeStatus: requiredText(row.exchangeStatus, context, `${path}.exchangeStatus`),
    faultByType: normalizeFault(row.faultType ?? row.faultByType, context, `${path}.faultType`),
    reasonCode: optionalText(row.reasonCode, context, `${path}.reasonCode`),
    reasonLabel: optionalText(row.reasonCodeText, context, `${path}.reasonCodeText`),
    reasonDetail: normalizeReasonDetail(row.reasonEtcDetail ?? row.reasonDetail, context, `${path}.reasonEtcDetail`),
    externalCreatedAt: createdAt.value,
    externalModifiedAt: modifiedAt.value,
    invalidTimestampCount: [createdAt, modifiedAt].filter((item) => item.invalid).length,
  };
}

function withdrawalRow(value: unknown, context: ValidationContext, path: string): StrictCoupangReturnWithdrawal {
  const row = expectIntegrationObject(value, context, path);
  const withdrawnAt = optionalTimestamp(row.createdAt, context, `${path}.createdAt`);
  const rawVendorItemIds = expectIntegrationArray(row.vendorItemIds, context, `${path}.vendorItemIds`);
  const vendorItemIds = [...new Set(rawVendorItemIds.map((item, index) =>
    expectIntegrationDecimalId(item, context, `${path}.vendorItemIds[${index}]`)
  ))].sort();
  return {
    externalReceiptId: expectIntegrationDecimalId(row.cancelId, context, `${path}.cancelId`),
    externalOrderId: expectIntegrationDecimalId(row.orderId, context, `${path}.orderId`),
    externalWithdrawnAt: withdrawnAt.value,
    refundDeliveryDuty: optionalText(row.refundDeliveryDuty, context, `${path}.refundDeliveryDuty`),
    vendorItemIds: vendorItemIds.join(","),
    invalidTimestampCount: withdrawnAt.invalid ? 1 : 0,
  };
}

export function validateCoupangReturnPage(payload: unknown, context: ValidationContext = { provider: "COUPANG", endpoint: "RETURN_REQUESTS" }) {
  const root = successEnvelope(payload, context);
  const rows = expectIntegrationArray(root.data, context, "$.data");
  return {
    nextToken: optionalText(root.nextToken, context, "$.nextToken"),
    returns: rows.map((row, index) => returnRow(row, context, `$.data[${index}]`)),
  };
}

export function validateCoupangExchangePage(payload: unknown, context: ValidationContext = { provider: "COUPANG", endpoint: "EXCHANGE_REQUESTS" }) {
  const root = successEnvelope(payload, context);
  const rows = expectIntegrationArray(root.data, context, "$.data");
  return {
    nextToken: optionalText(root.nextToken, context, "$.nextToken"),
    exchanges: rows.map((row, index) => exchangeRow(row, context, `$.data[${index}]`)),
  };
}

export function validateCoupangReturnWithdrawalPage(payload: unknown, context: ValidationContext = { provider: "COUPANG", endpoint: "RETURN_WITHDRAWALS" }) {
  const root = successEnvelope(payload, context);
  const rows = expectIntegrationArray(root.data, context, "$.data");
  const rawNextPageIndex = optionalText(root.nextPageIndex, context, "$.nextPageIndex");
  const nextPageIndex = rawNextPageIndex ? Number(rawNextPageIndex) : null;
  if (nextPageIndex !== null && (!Number.isSafeInteger(nextPageIndex) || nextPageIndex <= 0)) {
    return schemaError({ ...context, path: "$.nextPageIndex", reason: "EXPECTED_POSITIVE_PAGE_INDEX" });
  }
  return {
    nextPageIndex,
    withdrawals: rows.map((row, index) => withdrawalRow(row, context, `$.data[${index}]`)),
  };
}
