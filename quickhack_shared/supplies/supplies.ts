// QuickHack note: 비품관리 메뉴와 서버 로직이 공유하는 비품 재고 상태값과 라벨입니다.
export const SUPPLY_MOVEMENT_TYPE = {
  inbound: "INBOUND",
  consumed: "CONSUMED",
  adjustment: "ADJUSTMENT",
  returned: "RETURNED",
  discarded: "DISCARDED",
} as const;

export type SupplyMovementType =
  (typeof SUPPLY_MOVEMENT_TYPE)[keyof typeof SUPPLY_MOVEMENT_TYPE];

export const SUPPLY_MOVEMENT_TYPE_LABELS: Record<SupplyMovementType, string> = {
  INBOUND: "입고",
  CONSUMED: "사용",
  ADJUSTMENT: "조정",
  RETURNED: "반납",
  DISCARDED: "폐기",
};

export const SUPPLY_CONSUMPTION_TRIGGER = {
  purchasedDevice: "PURCHASED_DEVICE",
  shipmentCreated: "SHIPMENT_CREATED",
  orderItem: "ORDER_ITEM",
  packingCompleted: "PACKING_COMPLETED",
  returnReceived: "RETURN_RECEIVED",
} as const;

export type SupplyConsumptionTrigger =
  (typeof SUPPLY_CONSUMPTION_TRIGGER)[keyof typeof SUPPLY_CONSUMPTION_TRIGGER];

export function normalizeSupplyConsumptionQuantity(value: unknown) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }

  const rounded = Math.round(number);
  return rounded >= 1 ? rounded : null;
}

export const SUPPLY_CONSUMPTION_RULE_FILTER = {
  channel: "channel",
  model: "model",
  saleGrade: "saleGrade",
  warranty: "warranty",
  inventoryStatus: "inventoryStatus",
} as const;

export type SupplyConsumptionRuleFilter =
  (typeof SUPPLY_CONSUMPTION_RULE_FILTER)[keyof typeof SUPPLY_CONSUMPTION_RULE_FILTER];

export const SUPPLY_CONSUMPTION_TRIGGER_FILTERS = {
  PURCHASED_DEVICE: ["model", "saleGrade", "warranty", "inventoryStatus"],
  SHIPMENT_CREATED: ["model", "saleGrade", "warranty", "inventoryStatus"],
  ORDER_ITEM: ["channel", "model", "warranty"],
  PACKING_COMPLETED: ["model", "saleGrade", "warranty", "inventoryStatus"],
  RETURN_RECEIVED: [],
} as const satisfies Record<
  SupplyConsumptionTrigger,
  readonly SupplyConsumptionRuleFilter[]
>;

export function supplyConsumptionTriggerSupportsFilter(
  triggerType: string | null | undefined,
  filter: SupplyConsumptionRuleFilter
) {
  const filters = SUPPLY_CONSUMPTION_TRIGGER_FILTERS[
    triggerType as SupplyConsumptionTrigger
  ] as readonly SupplyConsumptionRuleFilter[] | undefined;

  return filters?.includes(filter) ?? false;
}

export const OUTBOUND_SUPPLY_CONSUMPTION_POLICY = {
  prepackAllowed: "PREPACK_ALLOWED",
  packingConfirmedOnly: "PACKING_CONFIRMED_ONLY",
} as const;

export type OutboundSupplyConsumptionPolicy =
  (typeof OUTBOUND_SUPPLY_CONSUMPTION_POLICY)[keyof typeof OUTBOUND_SUPPLY_CONSUMPTION_POLICY];

export const OUTBOUND_SUPPLY_CONSUMPTION_POLICY_LABELS: Record<
  OutboundSupplyConsumptionPolicy,
  string
> = {
  PREPACK_ALLOWED: "\uC120\uD3EC\uC7A5 \uB610\uB294 \uD3EC\uC7A5 \uAC80\uC99D \uC2DC \uCC28\uAC10",
  PACKING_CONFIRMED_ONLY: "\uD3EC\uC7A5 \uAC80\uC99D \uC644\uB8CC \uC2DC\uB9CC \uCC28\uAC10",
};

export const SUPPLY_CONSUMPTION_STAGE = {
  prepack: "PREPACK",
  packingConfirmed: "PACKING_CONFIRMED",
} as const;

export type SupplyConsumptionStage =
  (typeof SUPPLY_CONSUMPTION_STAGE)[keyof typeof SUPPLY_CONSUMPTION_STAGE];

export const PREPACK_COMPLETED_LOCATION = "\uD3EC\uC7A5 \uC644\uB8CC";
export const NON_REUSABLE_AFTER_PACKING_SUPPLY_CODE = "COMMON_A8_BOX";

export const SUPPLY_CONSUMPTION_TRIGGER_LABELS: Record<
  SupplyConsumptionTrigger,
  string
> = {
  PURCHASED_DEVICE: "매입 확정 기기",
  SHIPMENT_CREATED: "출고/송장 건",
  ORDER_ITEM: "주문 상품 수량",
  PACKING_COMPLETED: "재고실사 포장 완료",
  RETURN_RECEIVED: "반품 입고 건",
};

export const SUPPLY_REORDER_STATUS = {
  suggested: "SUGGESTED",
  requested: "REQUESTED",
  approved: "APPROVED",
  ordered: "ORDERED",
  received: "RECEIVED",
  cancelled: "CANCELLED",
} as const;

export type SupplyReorderStatus =
  (typeof SUPPLY_REORDER_STATUS)[keyof typeof SUPPLY_REORDER_STATUS];

export const SUPPLY_REORDER_STATUS_LABELS: Record<SupplyReorderStatus, string> = {
  SUGGESTED: "시스템 추천",
  REQUESTED: "구매 요청",
  APPROVED: "승인",
  ORDERED: "주문 완료",
  RECEIVED: "입고 완료",
  CANCELLED: "취소",
};

export function supplyMovementTypeLabel(value: string | null | undefined) {
  return (
    SUPPLY_MOVEMENT_TYPE_LABELS[value as SupplyMovementType] ||
    String(value || "-")
  );
}

export function supplyConsumptionTriggerLabel(value: string | null | undefined) {
  return (
    SUPPLY_CONSUMPTION_TRIGGER_LABELS[value as SupplyConsumptionTrigger] ||
    String(value || "-")
  );
}

export function outboundSupplyConsumptionPolicyLabel(
  value: string | null | undefined
) {
  return (
    OUTBOUND_SUPPLY_CONSUMPTION_POLICY_LABELS[
      value as OutboundSupplyConsumptionPolicy
    ] || String(value || "-")
  );
}

export function supplyReorderStatusLabel(value: string | null | undefined) {
  return (
    SUPPLY_REORDER_STATUS_LABELS[value as SupplyReorderStatus] ||
    String(value || "-")
  );
}
