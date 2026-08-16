import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const {
  activityLogChangeData,
  explicitActivityLogChangeData,
} = await import("@/quickhack_server/audit/structured-log-values");
const { purchaseConfirmActivityChangeData } = await import(
  "@/quickhack_server/inbound/purchase-confirm-service"
);
const { productCriteriaRelationAuditChanges } = await import(
  "@/quickhack_server/catalog/product-criteria-service"
);

assert.throws(
  () => activityLogChangeData([{ id: 1 }], [{ id: 2 }]),
  /cannot serialize object arrays/
);
assert.throws(
  () => activityLogChangeData({ nested: { rows: [{ id: 1 }] } }, null),
  /before\.nested\.rows/
);
assert.doesNotThrow(() => activityLogChangeData(["one", "two"], ["three"]));

const changes = Array.from({ length: 104 }, (_, index) => ({
  fieldName: `targets.PG-${index}.outcome`,
  beforeValue: null,
  afterValue: "CONFIRMED",
}));
assert.equal(
  explicitActivityLogChangeData(changes, {
    beforeSummary: "targets=13",
    afterSummary: "confirmed=13",
  }).changes.create.length,
  104,
  "Explicit per-target audit rows must not inherit the generic 80-field cap."
);

const purchaseResults = Array.from({ length: 13 }, (_, index) => ({
  pgNo: `PG-${String(index + 1).padStart(2, "0")}`,
  mode: ["CONFIRMED", "RECOVERED", "SKIPPED", "CONFLICT"][index % 4],
  auditReasonCode: `REASON_${index % 4}`,
  before: { inboundStatus: "INSPECTED", purchasePrice: 1000 + index },
  after: { inboundStatus: "PURCHASED", purchasePrice: 1000 + index },
}));
const purchaseAudit = purchaseConfirmActivityChangeData(purchaseResults, {
  confirmedCount: 4,
  recoveredCount: 3,
  skippedCount: 3,
  conflictCount: 3,
});
assert.equal(
  purchaseAudit.changes.create.filter((change) => change.field_name.endsWith(".outcome")).length,
  13
);
assert.equal(
  purchaseAudit.changes.create.filter((change) => change.field_name.endsWith(".reasonCode")).length,
  13
);
assert.ok(purchaseAudit.changes.create.length > 26);

const link = (childOptionId, isActive, sortOrder = 10) => ({
  relation_type: "MODEL_STORAGE",
  child_option_id: childOptionId,
  is_active: isActive ? 1 : 0,
  sort_order: sortOrder,
});
const camera = (focusRuleOptionId, isActive = true) => ({
  rule_id: 1,
  camera_lens_option_id: 101,
  focus_rule_option_id: focusRuleOptionId,
  is_active: isActive ? 1 : 0,
  sort_order: 10,
});
const swap = productCriteriaRelationAuditChanges(
  [link(1, true)],
  [link(1, false), link(2, true)],
  [camera(201)],
  [camera(202)]
);
assert.ok(swap.some((change) => change.fieldName === "relations.MODEL_STORAGE.1.active"));
assert.ok(swap.some((change) => change.fieldName === "relations.MODEL_STORAGE.2.active"));
assert.ok(swap.some((change) => change.fieldName === "cameraRules.101.focusRuleOptionId"));
assert.deepEqual(
  productCriteriaRelationAuditChanges([link(1, true)], [link(1, true)], [camera(201)], [camera(201)]),
  []
);
assert.ok(
  productCriteriaRelationAuditChanges([], [], [camera(201)], [camera(201, false)]).some(
    (change) => change.fieldName === "cameraRules.101.active"
  )
);

const root = process.cwd();
const source = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const purchase = source("quickhack_server/inbound/purchase-confirm-service.ts");
const criteria = source("quickhack_server/catalog/product-criteria-service.ts");
const inventory = source("quickhack_server/inventory/inventory-audit-service.ts");
const inventoryManagement = source(
  "quickhack_server/inventory/inventory-management-service.ts"
);
const orderMatching = source(
  "quickhack_server/sales-channel/coupang/order-matching-service.ts"
);

assert.match(purchase, /targets\.\$\{targetKey\}\.outcome/);
assert.match(purchase, /targets\.\$\{targetKey\}\.reasonCode/);
assert.match(purchase, /purchaseConfirmActivityChangeData/);
assert.match(criteria, /productCriteriaRelationAuditChanges/);
assert.match(criteria, /cameraRules\.\$\{key\}\.focusRuleOptionId/);
assert.match(inventory, /target_type:\s*"INVENTORY_AUDIT_SESSION"/);
assert.match(inventory, /target_id:\s*String\(session\.inventory_audit_session_id\)/);
assert.doesNotMatch(inventory, /activityLogChangeData\(beforeValue/);
assert.match(inventoryManagement, /inventoryManagementActivityChangeData/);
assert.match(inventoryManagement, /snapshot\.inbounds/);
assert.match(inventoryManagement, /snapshot\.inspections/);
assert.doesNotMatch(inventoryManagement, /activityLogChangeData\(beforeValue/);
assert.match(orderMatching, /refreshedShipmentCount:\s*summary\.refreshedShipments\.length/);
assert.doesNotMatch(orderMatching, /activityLogChangeData\(null, summary\)/);

console.log("Object-array fail-fast and CR-95 per-target audit ownership verified.");
