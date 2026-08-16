import assert from "node:assert/strict";
import {
  INVENTORY_QUANTITY_MATRIX_PRESETS,
  buildInventoryQuantityModelGroups,
  filterInventoryQuantityModelGroups,
  inventoryQuantityMetricForGroup,
  inventoryQuantityMetricForRow,
  mergeInventoryQuantityMovementPages,
} from "@/quickhack_shared/inventory/inventory-quantity-matrix-view";

const statuses = [
  "SELLABLE",
  "RESERVED",
  "PACKING",
  "PACKED",
  "DEPARTURE",
  "DELIVERING",
  "FINAL_DELIVERY",
  "NONE_TRACKING",
  "HOLD",
  "DEFECTIVE",
  "RETURN_REQUESTED",
  "EXCHANGE_REQUESTED",
  "RETURN_CHECK",
];

function rowFixture({
  rowKey,
  model,
  storage,
  color,
  saleGrade = "A",
  skuActive = true,
  rowKind = "SKU",
  balances = {},
  unavailable = false,
  devices = [],
}) {
  return {
    rowKind,
    rowKey,
    inventorySkuId: rowKind === "SKU" ? Number(rowKey.replace(/\D/g, "")) : null,
    skuCode: rowKind === "SKU" ? `SKU-${rowKey}` : null,
    model,
    storage,
    color,
    saleGrade,
    skuActive: rowKind === "SKU" ? skuActive : null,
    cells: statuses.map((inventoryStatus) => ({
      balanceId: balances[inventoryStatus]?.balanceId ?? null,
      inventoryStatus,
      quantity: unavailable
        ? null
        : balances[inventoryStatus]?.quantity ?? 0,
      version: balances[inventoryStatus]?.balanceId ? 1 : null,
      lastMovementAt: null,
      updatedAt: null,
    })),
    prePurchase: {
      inspectingQuantity: devices.filter(
        (device) => device.inboundStatus === "INSPECTING"
      ).length,
      inspectedQuantity: devices.filter(
        (device) => device.inboundStatus === "INSPECTED"
      ).length,
      devices,
    },
  };
}

const inboundDevice = {
  inboundId: 10,
  pgNo: "PG-SEARCH-001",
  inboundBatchId: 3,
  inboundStatus: "INSPECTING",
  receivedAt: null,
  createdAt: "2026-07-26 09:00:00",
  updatedAt: "2026-07-26 09:00:00",
  inventorySkuId: 1,
  model: "Galaxy S24",
  storage: "128GB",
  color: "Blue",
  saleGrade: "A",
};

const rows = [
  rowFixture({
    rowKey: "SKU:2",
    model: "Galaxy S24",
    storage: "512GB",
    color: "Black",
    skuActive: false,
  }),
  rowFixture({
    rowKey: "SKU:1",
    model: "Galaxy S24",
    storage: "128GB",
    color: "Blue",
    balances: {
      SELLABLE: { balanceId: 11, quantity: 0 },
      PACKING: { balanceId: 12, quantity: 2 },
    },
    devices: [inboundDevice],
  }),
  rowFixture({
    rowKey: "UNCLASSIFIED:1",
    rowKind: "UNCLASSIFIED_INBOUND",
    model: "Galaxy S24",
    storage: "미정",
    color: "Green",
    devices: [
      {
        ...inboundDevice,
        inboundId: 11,
        pgNo: "PG-UNCLASSIFIED",
        inventorySkuId: null,
        storage: null,
      },
    ],
  }),
  rowFixture({
    rowKey: "SKU:9",
    model: "Galaxy S9",
    storage: "64GB",
    color: "Black",
  }),
];

const groups = buildInventoryQuantityModelGroups(rows);
assert.deepEqual(
  groups.map((group) => group.model),
  ["Galaxy S9", "Galaxy S24"],
  "Models must use stable natural ordering."
);

const s24 = groups[1];
assert.deepEqual(
  s24.rows.map((row) => row.storage),
  ["128GB", "512GB", "미정"],
  "Rows must sort by numeric storage and then the remaining dimensions."
);
assert.equal(s24.activeSkuCount, 1);
assert.equal(s24.inactiveSkuCount, 1);
assert.equal(s24.unclassifiedRowCount, 1);

const pgSearch = filterInventoryQuantityModelGroups(
  groups,
  "PG-SEARCH"
);
assert.equal(pgSearch.groups.length, 1);
assert.equal(pgSearch.groups[0].rows.length, 1);
assert.deepEqual(pgSearch.autoExpandedGroupKeys, [s24.groupKey]);

const modelSearch = filterInventoryQuantityModelGroups(groups, "s24");
assert.equal(modelSearch.groups[0].rows.length, 3);
assert.deepEqual(modelSearch.autoExpandedGroupKeys, [s24.groupKey]);

assert.deepEqual(
  Object.fromEntries(
    Object.entries(INVENTORY_QUANTITY_MATRIX_PRESETS).map(
      ([key, preset]) => [key, preset.columns.length]
    )
  ),
  {
    SUMMARY: 4,
    OUTBOUND: 6,
    EXCEPTIONS: 6,
    ALL: 13,
  }
);

const exactRow = s24.rows[0];
const summaryColumns =
  INVENTORY_QUANTITY_MATRIX_PRESETS.SUMMARY.columns;
const sellableMetric = inventoryQuantityMetricForRow(
  exactRow,
  summaryColumns[0]
);
assert.equal(sellableMetric.displayQuantity, 0);
assert.equal(sellableMetric.detailKind, "MOVEMENT");
assert.equal(sellableMetric.balanceId, 11);

const missingHoldMetric = inventoryQuantityMetricForRow(
  exactRow,
  INVENTORY_QUANTITY_MATRIX_PRESETS.EXCEPTIONS.columns[0]
);
assert.equal(missingHoldMetric.calculatedQuantity, 0);
assert.equal(missingHoldMetric.displayQuantity, null);
assert.equal(missingHoldMetric.detailKind, null);

const todayOrderMetric = inventoryQuantityMetricForRow(
  exactRow,
  summaryColumns[1]
);
assert.equal(todayOrderMetric.displayQuantity, 2);
assert.equal(todayOrderMetric.detailKind, "TODAY_ORDER");

const prePurchaseMetric = inventoryQuantityMetricForRow(
  exactRow,
  summaryColumns[2]
);
assert.equal(prePurchaseMetric.displayQuantity, 1);
assert.equal(prePurchaseMetric.detailKind, "PRE_PURCHASE");

const totalMetric = inventoryQuantityMetricForRow(
  exactRow,
  summaryColumns[3]
);
assert.equal(totalMetric.displayQuantity, 3);
assert.equal(totalMetric.detailKind, null);

const groupOrderMetric = inventoryQuantityMetricForGroup(
  s24,
  summaryColumns[1]
);
assert.equal(groupOrderMetric.displayQuantity, 2);
assert.equal(groupOrderMetric.detailKind, null);

const unavailableRow = rowFixture({
  rowKey: "SKU:99",
  model: "Unavailable",
  storage: "128GB",
  color: "Black",
  unavailable: true,
});
assert.equal(
  inventoryQuantityMetricForRow(
    unavailableRow,
    summaryColumns[0]
  ).displayQuantity,
  null
);
assert.equal(
  inventoryQuantityMetricForRow(
    unavailableRow,
    summaryColumns[3]
  ).displayQuantity,
  null
);

const movement = (movementId) => ({
  movementId,
  balanceId: 11,
  inventorySkuId: 1,
  skuCode: "SKU-1",
  model: "Galaxy S24",
  storage: "128GB",
  color: "Blue",
  saleGrade: "A",
  inventoryStatus: "SELLABLE",
  pgNo: null,
  movementType: "TEST",
  quantityDelta: 1,
  beforeQuantity: 0,
  afterQuantity: 1,
  sourceType: "TEST",
  sourceId: null,
  reason: null,
  actorUserId: null,
  actorName: null,
  workerJobId: null,
  occurredAt: "2026-07-26 09:00:00",
});
const balance = {
  balanceId: 11,
  inventorySkuId: 1,
  skuCode: "SKU-1",
  model: "Galaxy S24",
  storage: "128GB",
  color: "Blue",
  saleGrade: "A",
  inventoryStatus: "SELLABLE",
  quantity: 2,
  version: 2,
  skuActive: true,
  lastMovementAt: "2026-07-26 09:00:00",
  updatedAt: "2026-07-26 09:00:00",
};
const merged = mergeInventoryQuantityMovementPages(
  {
    balance,
    items: [movement(3), movement(2)],
    nextCursor: 2,
  },
  {
    balance: { ...balance, quantity: 3 },
    items: [movement(2), movement(1)],
    nextCursor: null,
  }
);
assert.deepEqual(
  merged.items.map((item) => item.movementId),
  [3, 2, 1]
);
assert.equal(merged.balance.quantity, 3);
assert.equal(merged.nextCursor, null);

console.log("Inventory quantity matrix view model verified.");
