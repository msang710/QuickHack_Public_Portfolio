// QuickHack note: 주문 매칭 상태와 활성 매칭 상태 상수를 클라이언트/서버가 공유합니다.
export const ACTIVE_CHANNEL_MATCH_STATUSES = [
  "MATCHED",
  "INVOICE_ISSUED",
] as const;

export const ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES = [
  "ALLOCATED",
  "API_ACKED",
  "SHIPMENT_LIST_PRINTED",
] as const;

export const RANDOM_MATCHING_OPTION_VALUE = "랜덤";

export const RANDOM_MATCHING_OPTION_ALIASES = [
  "랜덤",
  "무작위",
  "랜덤색상",
  "색상랜덤",
  "랜덤용량",
  "용량랜덤",
  "RANDOM",
  "RANDOMCOLOR",
  "COLORRANDOM",
  "RANDOMSTORAGE",
  "STORAGERANDOM",
  "ANY",
] as const;

export function matchingOptionKey(value: string) {
  return value.replace(/[\s_-]/g, "").toUpperCase();
}

export function isRandomMatchingOption(value: unknown) {
  const text = String(value ?? "").trim();

  if (!text) {
    return false;
  }

  return (RANDOM_MATCHING_OPTION_ALIASES as readonly string[]).some(
    (alias) => matchingOptionKey(alias) === matchingOptionKey(text)
  );
}

export function includesRandomMatchingOptionText(value: unknown) {
  const text = matchingOptionKey(String(value ?? ""));

  if (!text) {
    return false;
  }

  if (isRandomMatchingOption(value)) {
    return true;
  }

  return (RANDOM_MATCHING_OPTION_ALIASES as readonly string[]).some((alias) => {
    const aliasKey = matchingOptionKey(alias);

    return aliasKey !== "ANY" && text.includes(aliasKey);
  });
}

export const INVENTORY_MATCH_STATUSES = {
  unmatched: "UNMATCHED",
  matched: "MATCHED",
  partial: "PARTIAL",
  failed: "FAILED",
  skipped: "SKIPPED",
  expired: "EXPIRED",
} as const;

export const INVENTORY_MATCH_FAILURE_REASONS = {
  noChannelSalesOffer: "NO_CHANNEL_SALES_OFFER",
  insufficientInventory: "INSUFFICIENT_INVENTORY",
  orderCanceled: "ORDER_CANCELED",
  noAvailableQuantity: "NO_AVAILABLE_QUANTITY",
  autoMatchDisabled: "AUTO_MATCH_DISABLED",
  activeAllocationQuantityExceeded: "ACTIVE_ALLOCATION_QUANTITY_EXCEEDED",
  noModelCandidate: "NO_MODEL_CANDIDATE",
  syncWindowExpired: "SYNC_WINDOW_EXPIRED",
} as const;

export type InventoryMatchStatusCode =
  (typeof INVENTORY_MATCH_STATUSES)[keyof typeof INVENTORY_MATCH_STATUSES];

export type InventoryMatchFailureReasonCode =
  (typeof INVENTORY_MATCH_FAILURE_REASONS)[keyof typeof INVENTORY_MATCH_FAILURE_REASONS];

export const INVENTORY_MATCH_STATUS_LABELS: Record<
  InventoryMatchStatusCode,
  string
> = {
  UNMATCHED: "매칭 대기",
  MATCHED: "매칭 완료",
  PARTIAL: "부분 매칭",
  FAILED: "매칭 실패",
  SKIPPED: "제외",
  EXPIRED: "만료",
};

export const INVENTORY_MATCH_FAILURE_REASON_LABELS: Record<
  InventoryMatchFailureReasonCode,
  string
> = {
  NO_CHANNEL_SALES_OFFER: "판매 오퍼 매핑 없음",
  INSUFFICIENT_INVENTORY: "출고 가능 재고 없음",
  ORDER_CANCELED: "주문 취소",
  NO_AVAILABLE_QUANTITY: "매칭 대상 수량 없음",
  AUTO_MATCH_DISABLED: "자동 매칭 꺼짐",
  ACTIVE_ALLOCATION_QUANTITY_EXCEEDED: "주문 가능 수량보다 활성 배정이 많음",
  NO_MODEL_CANDIDATE: "모델 재고 없음",
  SYNC_WINDOW_EXPIRED: "24시간 초과",
};

export const CHANNEL_ORDER_MAPPING_FAILURE_REASONS = {
  noChannelProductMapping: "NO_CHANNEL_PRODUCT_MAPPING",
  salesOfferNotMapped: "SALES_OFFER_NOT_MAPPED",
  salesOfferNotFound: "SALES_OFFER_NOT_FOUND",
  salesOfferInactive: "SALES_OFFER_INACTIVE",
} as const;

export type ChannelOrderMappingFailureReasonCode =
  (typeof CHANNEL_ORDER_MAPPING_FAILURE_REASONS)[keyof typeof CHANNEL_ORDER_MAPPING_FAILURE_REASONS];

export const CHANNEL_ORDER_MAPPING_FAILURE_REASON_LABELS: Record<
  ChannelOrderMappingFailureReasonCode,
  string
> = {
  NO_CHANNEL_PRODUCT_MAPPING: "SKU 매핑 없음",
  SALES_OFFER_NOT_MAPPED: "판매 오퍼 매핑 없음",
  SALES_OFFER_NOT_FOUND: "판매 오퍼 없음",
  SALES_OFFER_INACTIVE: "판매 오퍼 비활성",
};

export function inventoryMatchStatusLabel(value: unknown) {
  const status = String(value ?? "").trim();

  if (!status) {
    return "-";
  }

  return (
    INVENTORY_MATCH_STATUS_LABELS[status as InventoryMatchStatusCode] ?? status
  );
}

export function inventoryMatchFailureReasonLabel(value: unknown) {
  const reason = String(value ?? "").trim();

  if (!reason) {
    return "";
  }

  return (
    INVENTORY_MATCH_FAILURE_REASON_LABELS[
      reason as InventoryMatchFailureReasonCode
    ] ?? reason
  );
}

export function channelOrderMappingFailureReasonLabel(value: unknown) {
  const reason = String(value ?? "").trim();

  if (!reason) {
    return "";
  }

  return (
    CHANNEL_ORDER_MAPPING_FAILURE_REASON_LABELS[
      reason as ChannelOrderMappingFailureReasonCode
    ] ?? reason
  );
}
