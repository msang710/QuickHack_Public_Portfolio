import {
  SUPPLY_CONSUMPTION_RULE_FILTER,
  supplyConsumptionTriggerSupportsFilter,
  type SupplyConsumptionRuleFilter,
} from "@/quickhack_shared/supplies/supplies";

type SupplyConsumptionRuleFilterValues = Record<
  SupplyConsumptionRuleFilter,
  string
>;

export type SupplyConsumptionRuleUiValue = SupplyConsumptionRuleFilterValues & {
  triggerType: string;
};

export const SUPPLY_CONSUMPTION_RULE_FILTER_DEFINITIONS = [
  {
    key: SUPPLY_CONSUMPTION_RULE_FILTER.channel,
    formLabel: "채널 필터",
    summaryLabel: "채널",
  },
  {
    key: SUPPLY_CONSUMPTION_RULE_FILTER.model,
    formLabel: "기종 필터",
    summaryLabel: "기종",
  },
  {
    key: SUPPLY_CONSUMPTION_RULE_FILTER.saleGrade,
    formLabel: "판매등급 필터",
    summaryLabel: "판매등급",
  },
  {
    key: SUPPLY_CONSUMPTION_RULE_FILTER.warranty,
    formLabel: "보증 필터",
    summaryLabel: "보증",
  },
  {
    key: SUPPLY_CONSUMPTION_RULE_FILTER.inventoryStatus,
    formLabel: "재고상태 필터",
    summaryLabel: "재고상태",
  },
] as const;

export function supplyConsumptionRuleFilterDefinitions(triggerType: string) {
  return SUPPLY_CONSUMPTION_RULE_FILTER_DEFINITIONS.filter((definition) =>
    supplyConsumptionTriggerSupportsFilter(triggerType, definition.key)
  );
}

export function supplyConsumptionRuleFormForTrigger<
  T extends SupplyConsumptionRuleUiValue,
>(ruleForm: T, triggerType: string): T {
  const nextForm = {
    ...ruleForm,
    triggerType,
  };

  for (const definition of SUPPLY_CONSUMPTION_RULE_FILTER_DEFINITIONS) {
    if (!supplyConsumptionTriggerSupportsFilter(triggerType, definition.key)) {
      nextForm[definition.key] = "";
    }
  }

  return nextForm;
}

export function supplyConsumptionRuleFilterText(
  rule: SupplyConsumptionRuleUiValue
) {
  return supplyConsumptionRuleFilterDefinitions(rule.triggerType)
    .map((definition) => {
      const value = rule[definition.key].trim();
      return value ? `${definition.summaryLabel}: ${value}` : "";
    })
    .filter(Boolean)
    .join(" / ");
}
