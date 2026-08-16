// QuickHack note: 비품 출고 소모 규칙의 실제 적용과 저장 시 중첩 검증이 같은 필터 의미를 사용하도록 합니다.
import {
  SUPPLY_CONSUMPTION_TRIGGER,
  type SupplyConsumptionTrigger,
} from "@/quickhack_shared/supplies/supplies";
import {
  isWarrantyGroupCode,
  warrantyGroupLabel,
} from "@/quickhack_shared/sales-channel/sales-matching";

export const OUTBOUND_SUPPLY_CONSUMPTION_TRIGGERS = [
  SUPPLY_CONSUMPTION_TRIGGER.shipmentCreated,
  SUPPLY_CONSUMPTION_TRIGGER.orderItem,
  SUPPLY_CONSUMPTION_TRIGGER.packingCompleted,
] as const;

type OutboundSupplyConsumptionTrigger =
  (typeof OUTBOUND_SUPPLY_CONSUMPTION_TRIGGERS)[number];

export type SupplyConsumptionRuleMatchFields = {
  trigger_type: string;
  channel: string | null;
  model: string | null;
  sale_grade: string | null;
  warranty: string | null;
  inventory_status: string | null;
};

export type SupplyConsumptionRuleMatchContext = {
  channel: string | null;
  model: string | null;
  sale_grade: string | null;
  warranty: string | null;
  inventoryStatus: string | null;
};

const OUTBOUND_TRIGGER_SET = new Set<SupplyConsumptionTrigger>(
  OUTBOUND_SUPPLY_CONSUMPTION_TRIGGERS
);

function normalizedText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function normalizedChannel(value: string | null | undefined) {
  return normalizedText(value).toUpperCase();
}

function normalizedWarranty(value: string | null | undefined) {
  const warranty = normalizedText(value);
  const code = warranty.toUpperCase();

  return isWarrantyGroupCode(code) ? warrantyGroupLabel(code) : warranty;
}

function filterMatches(
  expected: string | null,
  actual: string | null,
  normalize: (value: string | null | undefined) => string = normalizedText
) {
  const normalizedExpected = normalize(expected);

  return !normalizedExpected || normalizedExpected === normalize(actual);
}

function filtersOverlap(
  left: string | null,
  right: string | null,
  normalize: (value: string | null | undefined) => string = normalizedText
) {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);

  return (
    !normalizedLeft ||
    !normalizedRight ||
    normalizedLeft === normalizedRight
  );
}

export function isOutboundSupplyConsumptionTrigger(
  triggerType: string
): triggerType is OutboundSupplyConsumptionTrigger {
  return OUTBOUND_TRIGGER_SET.has(triggerType as SupplyConsumptionTrigger);
}

export function supplyConsumptionRuleMatchesOutboundContext(
  rule: SupplyConsumptionRuleMatchFields,
  context: SupplyConsumptionRuleMatchContext
) {
  return (
    isOutboundSupplyConsumptionTrigger(rule.trigger_type) &&
    filterMatches(rule.channel, context.channel, normalizedChannel) &&
    filterMatches(rule.model, context.model) &&
    filterMatches(rule.sale_grade, context.sale_grade) &&
    filterMatches(rule.warranty, context.warranty, normalizedWarranty) &&
    filterMatches(rule.inventory_status, context.inventoryStatus)
  );
}

export function outboundSupplyConsumptionRulesOverlap(
  left: SupplyConsumptionRuleMatchFields,
  right: SupplyConsumptionRuleMatchFields
) {
  return (
    isOutboundSupplyConsumptionTrigger(left.trigger_type) &&
    isOutboundSupplyConsumptionTrigger(right.trigger_type) &&
    filtersOverlap(left.channel, right.channel, normalizedChannel) &&
    filtersOverlap(left.model, right.model) &&
    filtersOverlap(left.sale_grade, right.sale_grade) &&
    filtersOverlap(left.warranty, right.warranty, normalizedWarranty) &&
    filtersOverlap(left.inventory_status, right.inventory_status)
  );
}
