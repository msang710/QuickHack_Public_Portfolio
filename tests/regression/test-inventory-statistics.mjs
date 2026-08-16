import assert from "node:assert/strict";
import {
  aggregateInventoryStatistics,
  INVENTORY_STATISTICS_STATUS_GROUPS,
} from "../../quickhack_server/statistics/inventory-statistics-service.ts";
import { INVENTORY_STATUS } from "../../quickhack_shared/inventory/inventory-status.ts";

const NOW = new Date("2026-07-28T03:00:00.000Z");
const allStatuses = Object.values(INVENTORY_STATUS);

function inventory(id, inventorySkuId, inventoryStatus) {
  return {
    inventoryId: id,
    inventorySkuId,
    inventoryStatus,
  };
}

function balance(id, inventorySkuId, inventoryStatus, quantity = 1) {
  return {
    balanceId: id,
    inventorySkuId,
    inventoryStatus,
    quantity,
  };
}

function issueCodes(data) {
  return data.integrity.issues.map((issue) => issue.code);
}

const flattenedStatuses = INVENTORY_STATISTICS_STATUS_GROUPS.flatMap(
  (group) => group.statuses
);
assert.deepEqual(
  [...flattenedStatuses].sort(),
  [...allStatuses].sort(),
  "Every known inventory status must belong to a statistics group."
);
assert.equal(
  new Set(flattenedStatuses).size,
  flattenedStatuses.length,
  "An inventory status must not belong to more than one statistics group."
);

const ready = aggregateInventoryStatistics(
  {
    inventory: allStatuses.map((status, index) =>
      inventory(index + 1, 1, status)
    ),
    balances: allStatuses.map((status, index) =>
      balance(index + 1, 1, status)
    ),
    movementCount: allStatuses.length,
  },
  { now: NOW }
);
assert.equal(ready.generatedAt, NOW.toISOString());
assert.equal(ready.integrity.availability, "READY");
assert.deepEqual(ready.integrity.issues, []);
assert.equal(ready.asOf.totalQuantity, allStatuses.length);
assert.equal(ready.source.classifiedInventoryRowCount, allStatuses.length);
assert.equal(ready.source.skuStatusMismatchCount, 0);
assert.deepEqual(
  Object.fromEntries(
    ready.asOf.groups.map((group) => [group.key, group.quantity])
  ),
  {
    SELLABLE: 1,
    ORDER_ALLOCATED: 4,
    SALES_RESTRICTED: 3,
    DELIVERING: 1,
    TRACKING_EXCEPTION: 1,
    FINAL_DELIVERY: 1,
    CLAIM_LOCATION_UNKNOWN: 2,
  }
);

const trackingException = ready.asOf.groups.find(
  (group) => group.key === "TRACKING_EXCEPTION"
);
const delivering = ready.asOf.groups.find(
  (group) => group.key === "DELIVERING"
);
const claims = ready.asOf.groups.find(
  (group) => group.key === "CLAIM_LOCATION_UNKNOWN"
);
assert.deepEqual(
  trackingException?.statuses.map((status) => status.status),
  [INVENTORY_STATUS.noneTracking]
);
assert.deepEqual(
  delivering?.statuses.map((status) => status.status),
  [INVENTORY_STATUS.delivering]
);
assert.deepEqual(
  claims?.statuses.map((status) => status.status),
  [
    INVENTORY_STATUS.returnRequested,
    INVENTORY_STATUS.exchangeRequested,
  ]
);

const empty = aggregateInventoryStatistics(
  { inventory: [], balances: [], movementCount: 0 },
  { now: NOW }
);
assert.equal(empty.integrity.availability, "EMPTY");
assert.equal(empty.asOf.totalQuantity, 0);
assert.ok(empty.asOf.groups.every((group) => group.quantity === 0));

const initializationPending = aggregateInventoryStatistics(
  {
    inventory: [inventory(1, 1, INVENTORY_STATUS.sellable)],
    balances: [],
    movementCount: 0,
  },
  { now: NOW }
);
assert.equal(
  initializationPending.integrity.availability,
  "PARTIAL"
);
assert.equal(initializationPending.asOf.totalQuantity, null);
assert.ok(
  issueCodes(initializationPending).includes(
    "LEDGER_MISSING"
  )
);

const oneSided = aggregateInventoryStatistics(
  {
    inventory: [inventory(1, 1, INVENTORY_STATUS.sellable)],
    balances: [balance(1, 1, INVENTORY_STATUS.sellable)],
    movementCount: 0,
  },
  { now: NOW }
);
assert.equal(oneSided.integrity.availability, "PARTIAL");
assert.equal(oneSided.asOf.totalQuantity, null);
assert.ok(issueCodes(oneSided).includes("LEDGER_ONE_SIDED"));
assert.ok(oneSided.asOf.groups.every((group) => group.quantity === null));

const unclassified = aggregateInventoryStatistics(
  {
    inventory: [inventory(1, null, INVENTORY_STATUS.sellable)],
    balances: [],
    movementCount: 0,
  },
  { now: NOW }
);
assert.equal(unclassified.integrity.availability, "PARTIAL");
assert.equal(unclassified.source.unclassifiedInventoryRowCount, 1);
assert.ok(issueCodes(unclassified).includes("UNCLASSIFIED_INVENTORY"));

const unknownInventoryStatus = aggregateInventoryStatistics(
  {
    inventory: [inventory(1, 1, "UNKNOWN_STATUS")],
    balances: [],
    movementCount: 0,
  },
  { now: NOW }
);
assert.equal(unknownInventoryStatus.integrity.availability, "PARTIAL");
assert.equal(unknownInventoryStatus.source.unknownInventoryStatusCount, 1);
assert.ok(
  issueCodes(unknownInventoryStatus).includes("UNKNOWN_INVENTORY_STATUS")
);

const unknownBalanceStatus = aggregateInventoryStatistics(
  {
    inventory: [],
    balances: [balance(1, 1, "UNKNOWN_STATUS", 0)],
    movementCount: 1,
  },
  { now: NOW }
);
assert.equal(unknownBalanceStatus.integrity.availability, "PARTIAL");
assert.equal(unknownBalanceStatus.source.unknownBalanceStatusCount, 1);
assert.ok(
  issueCodes(unknownBalanceStatus).includes("UNKNOWN_BALANCE_STATUS")
);

const negativeBalance = aggregateInventoryStatistics(
  {
    inventory: [],
    balances: [balance(1, 1, INVENTORY_STATUS.sellable, -1)],
    movementCount: 1,
  },
  { now: NOW }
);
assert.equal(negativeBalance.integrity.availability, "PARTIAL");
assert.equal(negativeBalance.source.negativeBalanceCount, 1);
assert.ok(issueCodes(negativeBalance).includes("NEGATIVE_BALANCE"));
assert.equal(negativeBalance.asOf.totalQuantity, null);

const swappedBuckets = aggregateInventoryStatistics(
  {
    inventory: [
      inventory(1, 1, INVENTORY_STATUS.sellable),
      inventory(2, 2, INVENTORY_STATUS.reserved),
    ],
    balances: [
      balance(1, 1, INVENTORY_STATUS.reserved),
      balance(2, 2, INVENTORY_STATUS.sellable),
    ],
    movementCount: 2,
  },
  { now: NOW }
);
assert.equal(swappedBuckets.source.inventoryRowCount, 2);
assert.equal(swappedBuckets.source.balanceQuantity, 2);
assert.equal(swappedBuckets.source.skuStatusMismatchCount, 4);
assert.equal(swappedBuckets.integrity.availability, "PARTIAL");
assert.equal(swappedBuckets.asOf.totalQuantity, null);
assert.ok(issueCodes(swappedBuckets).includes("SKU_STATUS_MISMATCH"));

assert.deepEqual(
  aggregateInventoryStatistics(
    {
      inventory: [inventory(1, 1, INVENTORY_STATUS.sellable)],
      balances: [balance(1, 1, INVENTORY_STATUS.sellable)],
      movementCount: 1,
    },
    { now: NOW }
  ),
  aggregateInventoryStatistics(
    {
      inventory: [inventory(1, 1, INVENTORY_STATUS.sellable)],
      balances: [balance(1, 1, INVENTORY_STATUS.sellable)],
      movementCount: 1,
    },
    { now: NOW }
  ),
  "The pure aggregate must be deterministic for the same input and clock."
);

console.log(
  "Inventory statistics grouping, availability, and integrity contracts verified."
);
