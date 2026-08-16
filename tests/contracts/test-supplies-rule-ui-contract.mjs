import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  supplyConsumptionRuleFilterDefinitions,
  supplyConsumptionRuleFilterText,
  supplyConsumptionRuleFormForTrigger,
} from "../../quickhack_client/components/supplies/supply-consumption-rule-ui.ts";
import {
  SUPPLY_CONSUMPTION_TRIGGER,
  normalizeSupplyConsumptionQuantity,
} from "../../quickhack_shared/supplies/supplies.ts";

const managementViewSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../quickhack_client/components/supplies/supplies-management-view.tsx",
      import.meta.url
    )
  ),
  "utf8"
);

assert.equal(normalizeSupplyConsumptionQuantity(1.49), 1);
assert.equal(normalizeSupplyConsumptionQuantity(1.5), 2);
assert.match(managementViewSource, /min=\{1\}/);
assert.match(managementViewSource, /step=\{1\}/);
assert.match(managementViewSource, /normalizedRuleQuantityInput/);

const completeRule = {
  triggerType: SUPPLY_CONSUMPTION_TRIGGER.shipmentCreated,
  channel: "COUPANG",
  model: "Galaxy S24",
  saleGrade: "A",
  warranty: "2년 보증",
  inventoryStatus: "SELLABLE",
};

assert.deepEqual(
  supplyConsumptionRuleFilterDefinitions(
    SUPPLY_CONSUMPTION_TRIGGER.orderItem
  ).map((definition) => definition.key),
  ["channel", "model", "warranty"]
);
assert.deepEqual(
  supplyConsumptionRuleFilterDefinitions(
    SUPPLY_CONSUMPTION_TRIGGER.purchasedDevice
  ).map((definition) => definition.key),
  ["model", "saleGrade", "warranty", "inventoryStatus"]
);
assert.deepEqual(
  supplyConsumptionRuleFilterDefinitions(
    SUPPLY_CONSUMPTION_TRIGGER.shipmentCreated
  ).map((definition) => definition.key),
  ["model", "saleGrade", "warranty", "inventoryStatus"]
);
assert.deepEqual(
  supplyConsumptionRuleFilterDefinitions(
    SUPPLY_CONSUMPTION_TRIGGER.packingCompleted
  ).map((definition) => definition.key),
  ["model", "saleGrade", "warranty", "inventoryStatus"]
);
assert.deepEqual(
  supplyConsumptionRuleFilterDefinitions(
    SUPPLY_CONSUMPTION_TRIGGER.returnReceived
  ),
  []
);

const orderItemRule = supplyConsumptionRuleFormForTrigger(
  completeRule,
  SUPPLY_CONSUMPTION_TRIGGER.orderItem
);
assert.deepEqual(orderItemRule, {
  ...completeRule,
  triggerType: SUPPLY_CONSUMPTION_TRIGGER.orderItem,
  saleGrade: "",
  inventoryStatus: "",
});
assert.equal(
  supplyConsumptionRuleFilterText(orderItemRule),
  "채널: COUPANG / 기종: Galaxy S24 / 보증: 2년 보증"
);

const returnRule = supplyConsumptionRuleFormForTrigger(
  completeRule,
  SUPPLY_CONSUMPTION_TRIGGER.returnReceived
);
assert.deepEqual(returnRule, {
  triggerType: SUPPLY_CONSUMPTION_TRIGGER.returnReceived,
  channel: "",
  model: "",
  saleGrade: "",
  warranty: "",
  inventoryStatus: "",
});
assert.equal(supplyConsumptionRuleFilterText(returnRule), "");

assert.equal(
  supplyConsumptionRuleFilterText({
    ...completeRule,
    channel: "IGNORED",
  }),
  "기종: Galaxy S24 / 판매등급: A / 보증: 2년 보증 / 재고상태: SELLABLE"
);

console.log("Supply consumption rule UI contract verified.");
