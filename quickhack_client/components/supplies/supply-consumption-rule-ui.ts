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
  },
  {
    key: SUPPLY_CONSUMPTION_RULE_FILTER.model,
  },
  {
    key: SUPPLY_CONSUMPTION_RULE_FILTER.saleGrade,
  },
  {
    key: SUPPLY_CONSUMPTION_RULE_FILTER.warranty,
  },
  {
    key: SUPPLY_CONSUMPTION_RULE_FILTER.inventoryStatus,
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
  rule: SupplyConsumptionRuleUiValue,
  label: (key: SupplyConsumptionRuleFilter) => string
) {
  return supplyConsumptionRuleFilterDefinitions(rule.triggerType)
    .map((definition) => {
      const value = rule[definition.key].trim();
      return value ? `${label(definition.key)}: ${value}` : "";
    })
    .filter(Boolean)
    .join(" / ");
}
