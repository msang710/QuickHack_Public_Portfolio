import assert from "node:assert/strict";
import {
  aggregateInventoryStatistics,
  InventoryStatisticsPeriodError,
  normalizeInventoryStatisticsPeriod,
  resolveInventoryStatisticsPeriod,
} from "../../quickhack_server/statistics/inventory-statistics-service.ts";
import { formatKstSqlDateTime } from "../../quickhack_shared/core/time.ts";
import { INVENTORY_STATUS } from "../../quickhack_shared/inventory/inventory-status.ts";
import { INVENTORY_QUANTITY_MOVEMENT_TYPE } from "../../quickhack_shared/inventory/inventory-quantity-movement.ts";

const NOW = new Date("2026-07-28T03:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function timestampDaysAgo(days, hourOffset = 0) {
  return formatKstSqlDateTime(
    new Date(NOW.getTime() - days * MS_PER_DAY + hourOffset * 60 * 60 * 1000)
  );
}

function sku(inventorySkuId) {
  return {
    skuCode: `PERIOD-SKU-${inventorySkuId}`,
    model: `Model ${inventorySkuId}`,
    storage: `${inventorySkuId * 128}GB`,
    color: `Color ${inventorySkuId}`,
    saleGrade: "A",
  };
}

function clone(value) {
  return structuredClone(value);
}

class LedgerFixture {
  constructor() {
    this.nextMovementId = 1;
    this.nextBalanceId = 1;
    this.nextInventoryId = 1;
    this.nextSaleRecordId = 1;
    this.balancesByBucket = new Map();
    this.currentByPg = new Map();
    this.movements = [];
    this.sales = [];
  }

  balance(inventorySkuId, inventoryStatus) {
    const key = `${inventorySkuId}\u0000${inventoryStatus}`;
    let balance = this.balancesByBucket.get(key);

    if (!balance) {
      balance = {
        balanceId: this.nextBalanceId,
        inventorySkuId,
        inventoryStatus,
        quantity: 0,
        sku: sku(inventorySkuId),
      };
      this.nextBalanceId += 1;
      this.balancesByBucket.set(key, balance);
    }

    return balance;
  }

  movement({
    operationKey,
    movementType,
    pgNo,
    inventorySkuId,
    inventoryStatus,
    quantityDelta,
    occurredAt,
  }) {
    const balance = this.balance(inventorySkuId, inventoryStatus);
    const beforeQuantity = balance.quantity;
    const afterQuantity = beforeQuantity + quantityDelta;

    assert.ok(afterQuantity >= 0, `${operationKey} would make stock negative.`);
    balance.quantity = afterQuantity;
    this.movements.push({
      movementId: this.nextMovementId,
      balanceId: balance.balanceId,
      operationKey,
      movementType,
      pgNo,
      inventorySkuId,
      inventoryStatus,
      quantityDelta,
      beforeQuantity,
      afterQuantity,
      occurredAt,
    });
    this.nextMovementId += 1;
  }

  create(
    pgNo,
    inventorySkuId,
    inventoryStatus,
    occurredAt,
    movementType = INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated
  ) {
    assert.equal(this.currentByPg.has(pgNo), false);
    const operationKey = `${pgNo}:CREATE:${occurredAt}`;

    this.movement({
      operationKey,
      movementType,
      pgNo,
      inventorySkuId,
      inventoryStatus,
      quantityDelta: 1,
      occurredAt,
    });
    this.currentByPg.set(pgNo, {
      inventorySkuId,
      inventoryStatus,
    });
  }

  transfer(pgNo, toStatus, occurredAt) {
    const current = this.currentByPg.get(pgNo);
    assert.ok(current, `${pgNo} must exist before a status transfer.`);
    const operationKey =
      `${pgNo}:STATUS:${current.inventoryStatus}:${toStatus}:${occurredAt}`;

    this.movement({
      operationKey,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      pgNo,
      inventorySkuId: current.inventorySkuId,
      inventoryStatus: current.inventoryStatus,
      quantityDelta: -1,
      occurredAt,
    });
    this.movement({
      operationKey,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      pgNo,
      inventorySkuId: current.inventorySkuId,
      inventoryStatus: toStatus,
      quantityDelta: 1,
      occurredAt,
    });
    this.currentByPg.set(pgNo, {
      inventorySkuId: current.inventorySkuId,
      inventoryStatus: toStatus,
    });
  }

  reclassify(pgNo, nextInventorySkuId, occurredAt) {
    const current = this.currentByPg.get(pgNo);
    assert.ok(current, `${pgNo} must exist before SKU reclassification.`);
    const operationKey =
      `${pgNo}:SKU:${current.inventorySkuId}:${nextInventorySkuId}:${occurredAt}`;

    this.movement({
      operationKey,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.skuReclassification,
      pgNo,
      inventorySkuId: current.inventorySkuId,
      inventoryStatus: current.inventoryStatus,
      quantityDelta: -1,
      occurredAt,
    });
    this.movement({
      operationKey,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.skuReclassification,
      pgNo,
      inventorySkuId: nextInventorySkuId,
      inventoryStatus: current.inventoryStatus,
      quantityDelta: 1,
      occurredAt,
    });
    this.currentByPg.set(pgNo, {
      inventorySkuId: nextInventorySkuId,
      inventoryStatus: current.inventoryStatus,
    });
  }

  remove(pgNo, occurredAt) {
    const current = this.currentByPg.get(pgNo);
    assert.ok(current, `${pgNo} must exist before removal.`);
    const operationKey = `${pgNo}:REMOVE:${occurredAt}`;

    this.movement({
      operationKey,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryRemoved,
      pgNo,
      inventorySkuId: current.inventorySkuId,
      inventoryStatus: current.inventoryStatus,
      quantityDelta: -1,
      occurredAt,
    });
    this.currentByPg.delete(pgNo);
  }

  sell(pgNo, soldAt, saleStatus = "COMPLETED") {
    const current = this.currentByPg.get(pgNo);
    assert.ok(current, `${pgNo} must exist before a sale is recorded.`);

    this.sales.push({
      saleRecordId: this.nextSaleRecordId,
      pgNo,
      inventorySkuId: current.inventorySkuId,
      soldAt,
      saleStatus,
      sku: sku(current.inventorySkuId),
    });
    this.nextSaleRecordId += 1;
  }

  input() {
    const inventory = Array.from(this.currentByPg.entries()).map(
      ([pgNo, current]) => ({
        inventoryId: this.nextInventoryId++,
        pgNo,
        inventorySkuId: current.inventorySkuId,
        inventoryStatus: current.inventoryStatus,
        sku: sku(current.inventorySkuId),
        purchasePrice: null,
      })
    );

    return {
      inventory,
      balances: Array.from(this.balancesByBucket.values()).map((row) => ({
        ...row,
      })),
      movementCount: this.movements.length,
      movements: this.movements.map((row) => ({ ...row })),
      sales: this.sales.map((row) => ({ ...row })),
    };
  }
}

function buildMainInput() {
  const fixture = new LedgerFixture();

  fixture.create(
    "PERIOD-PG-B",
    1,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(20)
  );
  fixture.create(
    "PERIOD-PG-A",
    1,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(10)
  );
  fixture.transfer(
    "PERIOD-PG-A",
    INVENTORY_STATUS.reserved,
    timestampDaysAgo(8)
  );
  fixture.transfer(
    "PERIOD-PG-A",
    INVENTORY_STATUS.delivering,
    timestampDaysAgo(5)
  );
  fixture.sell("PERIOD-PG-A", timestampDaysAgo(4), "RETURNED");
  fixture.reclassify("PERIOD-PG-B", 2, timestampDaysAgo(3));
  fixture.transfer(
    "PERIOD-PG-A",
    INVENTORY_STATUS.returnCheck,
    timestampDaysAgo(2)
  );
  fixture.transfer(
    "PERIOD-PG-A",
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(1)
  );
  fixture.create(
    "PERIOD-PG-C",
    2,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(1, 1)
  );
  fixture.remove("PERIOD-PG-C", timestampDaysAgo(0, -1));

  return fixture.input();
}

function issueCodes(data) {
  return new Set(data.period.integrity.issues.map((issue) => issue.code));
}

function point(data, date) {
  return data.period.daily.find((row) => row.date === date);
}

assert.equal(normalizeInventoryStatisticsPeriod(undefined), "90d");
assert.equal(normalizeInventoryStatisticsPeriod(" 30D "), "30d");
assert.equal(normalizeInventoryStatisticsPeriod("all"), "all");
assert.throws(
  () => normalizeInventoryStatisticsPeriod("week"),
  InventoryStatisticsPeriodError
);

const thirtyDayRange = resolveInventoryStatisticsPeriod({
  preset: "30d",
  now: NOW,
});
assert.deepEqual(
  {
    fromDate: thirtyDayRange.fromDate,
    toDate: thirtyDayRange.toDate,
    dayCount: thirtyDayRange.dates.length,
  },
  {
    fromDate: "2026-06-28",
    toDate: "2026-07-27",
    dayCount: 30,
  }
);
assert.equal(
  resolveInventoryStatisticsPeriod({ preset: "90d", now: NOW }).dates.length,
  90
);
assert.equal(
  resolveInventoryStatisticsPeriod({ preset: "1y", now: NOW }).dates.length,
  365
);
const allRange = resolveInventoryStatisticsPeriod({
  preset: "all",
  now: NOW,
  sourceDates: [
    new Date(NOW.getTime() - 2 * MS_PER_DAY),
    new Date(NOW.getTime() - 20 * MS_PER_DAY),
  ],
});
assert.equal(allRange.fromDate, "2026-07-08");
assert.equal(allRange.dates.length, 20);
const futureOnlyAllRange = resolveInventoryStatisticsPeriod({
  preset: "all",
  now: NOW,
  sourceDates: [new Date(NOW.getTime() + MS_PER_DAY)],
});
assert.equal(futureOnlyAllRange.fromDate, "2026-07-27");
assert.equal(futureOnlyAllRange.toDate, "2026-07-27");
assert.equal(futureOnlyAllRange.dates.length, 1);

const mainInput = buildMainInput();
const thirtyDays = aggregateInventoryStatistics(mainInput, {
  now: NOW,
  period: "30d",
});
assert.equal(thirtyDays.period.integrity.availability, "READY");
assert.deepEqual(thirtyDays.period.integrity.issues, []);
assert.equal(thirtyDays.period.preset, "30d");
assert.equal(thirtyDays.period.dayCount, 30);
assert.deepEqual(thirtyDays.period.source, {
  movementRowCount: 13,
  operationCount: 8,
  skuReclassificationOperationCount: 1,
  saleRecordCount: 1,
  classifiedSaleRecordCount: 1,
  unclassifiedSaleRecordCount: 0,
  returnedSaleRecordCount: 1,
  invalidSaleTimestampCount: 0,
});
assert.deepEqual(thirtyDays.period.summary, {
  newInventoryQuantity: 3,
  warehouseReentryQuantity: 1,
  customerReturnReentryQuantity: 1,
  otherWarehouseReentryQuantity: 0,
  warehouseExitQuantity: 1,
  removedQuantity: 0,
  salesCompletedQuantity: 1,
  averageWarehouseQuantity: 0.93,
  turnover: {
    value: 1.075,
    soldQuantity: 1,
    averageWarehouseQuantity: 0.93,
  },
});
assert.deepEqual(point(thirtyDays, "2026-07-08"), {
  date: "2026-07-08",
  closingWarehouseQuantity: 1,
  newInventoryQuantity: 1,
  warehouseReentryQuantity: 0,
  customerReturnReentryQuantity: 0,
  otherWarehouseReentryQuantity: 0,
  warehouseExitQuantity: 0,
  removedQuantity: 0,
  salesCompletedQuantity: 0,
});
assert.equal(point(thirtyDays, "2026-07-23").warehouseExitQuantity, 1);
assert.equal(point(thirtyDays, "2026-07-24").salesCompletedQuantity, 1);
assert.equal(point(thirtyDays, "2026-07-26").warehouseReentryQuantity, 1);
assert.equal(
  point(thirtyDays, "2026-07-26").customerReturnReentryQuantity,
  1
);
assert.equal(point(thirtyDays, "2026-07-27").closingWarehouseQuantity, 3);
assert.equal(thirtyDays.source.cutoffExcludedMovementCount, 1);
assert.equal(thirtyDays.source.cutoffExcludedSaleRecordCount, 0);
assert.equal(thirtyDays.asOf.date, "2026-07-27");
assert.equal(thirtyDays.asOf.totalQuantity, 3);
assert.ok(
  thirtyDays.period.transitions.some(
    (row) =>
      row.fromGroup === "ORDER_ALLOCATED" &&
      row.toGroup === "DELIVERING" &&
      row.quantity === 1
  )
);
assert.ok(
  thirtyDays.period.transitions.some(
    (row) =>
      row.fromGroup === "DELIVERING" &&
      row.toGroup === "SALES_RESTRICTED" &&
      row.quantity === 1
  )
);
assert.equal(thirtyDays.period.skuRows.length, 2);
const skuOne = thirtyDays.period.skuRows.find(
  (row) => row.skuCode === "PERIOD-SKU-1"
);
const skuTwo = thirtyDays.period.skuRows.find(
  (row) => row.skuCode === "PERIOD-SKU-2"
);
assert.deepEqual(skuOne, {
  skuCode: "PERIOD-SKU-1",
  model: "Model 1",
  storage: "128GB",
  color: "Color 1",
  saleGrade: "A",
  averageWarehouseQuantity: 0.8,
  salesCompletedQuantity: 1,
  turnover: {
    value: 1.25,
    soldQuantity: 1,
    averageWarehouseQuantity: 0.8,
  },
});
assert.deepEqual(skuTwo, {
  skuCode: "PERIOD-SKU-2",
  model: "Model 2",
  storage: "256GB",
  color: "Color 2",
  saleGrade: "A",
  averageWarehouseQuantity: 0.13,
  salesCompletedQuantity: 0,
  turnover: {
    value: 0,
    soldQuantity: 0,
    averageWarehouseQuantity: 0.13,
  },
});

const ninetyDays = aggregateInventoryStatistics(mainInput, {
  now: NOW,
  period: "90d",
});
assert.equal(ninetyDays.period.preset, "90d");
assert.equal(ninetyDays.period.dayCount, 90);
assert.deepEqual(ninetyDays.asOf, thirtyDays.asOf);
assert.deepEqual(ninetyDays.aging, thirtyDays.aging);
assert.notEqual(
  ninetyDays.period.summary.averageWarehouseQuantity,
  thirtyDays.period.summary.averageWarehouseQuantity
);

const outsideWarehouseRemovalFixture = new LedgerFixture();
outsideWarehouseRemovalFixture.create(
  "PERIOD-PG-OUTSIDE-REMOVAL",
  1,
  INVENTORY_STATUS.delivering,
  timestampDaysAgo(2)
);
outsideWarehouseRemovalFixture.remove(
  "PERIOD-PG-OUTSIDE-REMOVAL",
  timestampDaysAgo(1)
);
const outsideWarehouseRemoval = aggregateInventoryStatistics(
  outsideWarehouseRemovalFixture.input(),
  { now: NOW, period: "30d" }
);
assert.equal(
  outsideWarehouseRemoval.period.integrity.availability,
  "READY"
);
assert.equal(
  outsideWarehouseRemoval.period.summary.newInventoryQuantity,
  0
);
assert.equal(outsideWarehouseRemoval.period.summary.removedQuantity, 1);
assert.equal(
  outsideWarehouseRemoval.period.summary.averageWarehouseQuantity,
  0
);

const otherReentryFixture = new LedgerFixture();
otherReentryFixture.create(
  "PERIOD-PG-OTHER-REENTRY",
  1,
  INVENTORY_STATUS.sellable,
  timestampDaysAgo(3)
);
otherReentryFixture.transfer(
  "PERIOD-PG-OTHER-REENTRY",
  INVENTORY_STATUS.delivering,
  timestampDaysAgo(2)
);
otherReentryFixture.transfer(
  "PERIOD-PG-OTHER-REENTRY",
  INVENTORY_STATUS.returnCheck,
  timestampDaysAgo(1)
);
const otherReentry = aggregateInventoryStatistics(
  otherReentryFixture.input(),
  { now: NOW, period: "30d" }
);
assert.equal(otherReentry.period.summary.warehouseReentryQuantity, 1);
assert.equal(
  otherReentry.period.summary.customerReturnReentryQuantity,
  0
);
assert.equal(otherReentry.period.summary.otherWarehouseReentryQuantity, 1);

const brokenQuantityInput = clone(mainInput);
brokenQuantityInput.movements[0].afterQuantity += 1;
const brokenQuantity = aggregateInventoryStatistics(brokenQuantityInput, {
  now: NOW,
  period: "30d",
});
assert.equal(brokenQuantity.period.integrity.availability, "PARTIAL");
assert.ok(issueCodes(brokenQuantity).has("INVALID_MOVEMENT_QUANTITY"));
assert.ok(
  issueCodes(brokenQuantity).has("BALANCE_MOVEMENT_CHAIN_MISMATCH")
);
assert.equal(brokenQuantity.period.summary.averageWarehouseQuantity, null);

const invalidMovementTimestampInput = clone(mainInput);
invalidMovementTimestampInput.movements[0].occurredAt = "not-a-date";
const invalidMovementTimestamp = aggregateInventoryStatistics(
  invalidMovementTimestampInput,
  { now: NOW, period: "30d" }
);
assert.equal(
  invalidMovementTimestamp.period.integrity.availability,
  "PARTIAL"
);
assert.ok(
  issueCodes(invalidMovementTimestamp).has("INVALID_MOVEMENT_TIMESTAMP")
);
assert.equal(
  invalidMovementTimestamp.period.summary.averageWarehouseQuantity,
  null
);

const brokenTailInput = clone(mainInput);
brokenTailInput.balances.find(
  (row) =>
    row.inventorySkuId === 1 &&
    row.inventoryStatus === INVENTORY_STATUS.sellable
).quantity += 1;
const brokenTail = aggregateInventoryStatistics(brokenTailInput, {
  now: NOW,
  period: "30d",
});
assert.equal(brokenTail.period.integrity.availability, "PARTIAL");
assert.ok(issueCodes(brokenTail).has("CURRENT_LEDGER_NOT_READY"));
assert.ok(issueCodes(brokenTail).has("CURRENT_BALANCE_TAIL_MISMATCH"));
assert.equal(brokenTail.period.summary.averageWarehouseQuantity, null);

const unclassifiedSaleInput = clone(mainInput);
unclassifiedSaleInput.sales[0].inventorySkuId = null;
unclassifiedSaleInput.sales[0].sku = null;
const unclassifiedSale = aggregateInventoryStatistics(
  unclassifiedSaleInput,
  { now: NOW, period: "30d" }
);
assert.equal(unclassifiedSale.period.integrity.availability, "READY");
assert.equal(unclassifiedSale.period.source.saleRecordCount, 1);
assert.equal(unclassifiedSale.period.source.classifiedSaleRecordCount, 0);
assert.equal(unclassifiedSale.period.source.unclassifiedSaleRecordCount, 1);
assert.equal(unclassifiedSale.period.summary.salesCompletedQuantity, 1);
assert.ok(
  unclassifiedSale.period.skuRows.every(
    (row) => row.salesCompletedQuantity === 0
  )
);

const invalidSaleInput = clone(mainInput);
invalidSaleInput.sales[0].soldAt = "not-a-date";
const invalidSale = aggregateInventoryStatistics(invalidSaleInput, {
  now: NOW,
  period: "30d",
});
assert.equal(invalidSale.period.integrity.availability, "PARTIAL");
assert.ok(issueCodes(invalidSale).has("INVALID_SALE_TIMESTAMP"));
assert.equal(invalidSale.period.summary.salesCompletedQuantity, 0);
assert.equal(invalidSale.period.summary.turnover.value, null);

const futureMovementFixture = new LedgerFixture();
futureMovementFixture.create(
  "PERIOD-PG-FUTURE",
  1,
  INVENTORY_STATUS.delivering,
  timestampDaysAgo(-1)
);
futureMovementFixture.remove(
  "PERIOD-PG-FUTURE",
  timestampDaysAgo(-2)
);
const futureMovement = aggregateInventoryStatistics(
  futureMovementFixture.input(),
  { now: NOW, period: "all" }
);
assert.equal(futureMovement.period.fromDate, "2026-07-27");
assert.equal(futureMovement.period.toDate, "2026-07-27");
assert.equal(futureMovement.period.dayCount, 1);
assert.equal(futureMovement.period.integrity.availability, "EMPTY");
assert.equal(futureMovement.source.cutoffExcludedMovementCount, 2);
assert.equal(futureMovement.asOf.totalQuantity, 0);
assert.equal(futureMovement.period.summary.averageWarehouseQuantity, 0);

const cutoffProjectionFixture = new LedgerFixture();
cutoffProjectionFixture.create(
  "PERIOD-PG-CUTOFF",
  1,
  INVENTORY_STATUS.sellable,
  timestampDaysAgo(2)
);
cutoffProjectionFixture.transfer(
  "PERIOD-PG-CUTOFF",
  INVENTORY_STATUS.reserved,
  timestampDaysAgo(0)
);
cutoffProjectionFixture.reclassify(
  "PERIOD-PG-CUTOFF",
  2,
  timestampDaysAgo(0, 1)
);
cutoffProjectionFixture.sell(
  "PERIOD-PG-CUTOFF",
  timestampDaysAgo(0, 2)
);
const cutoffProjectionInput = cutoffProjectionFixture.input();
cutoffProjectionInput.inventory[0].purchasePrice = 450_000;
cutoffProjectionInput.inventory[0].purchasePriceUpdatedAt =
  timestampDaysAgo(0, 3);
const cutoffProjection = aggregateInventoryStatistics(
  cutoffProjectionInput,
  { now: NOW, period: "30d" }
);
assert.equal(cutoffProjection.integrity.availability, "READY");
assert.equal(cutoffProjection.asOf.totalQuantity, 1);
assert.equal(
  cutoffProjection.asOf.groups.find((row) => row.key === "SELLABLE")
    ?.quantity,
  1
);
assert.equal(
  cutoffProjection.asOf.groups.find((row) => row.key === "ORDER_ALLOCATED")
    ?.quantity,
  0
);
assert.equal(cutoffProjection.source.cutoffExcludedMovementCount, 4);
assert.equal(cutoffProjection.source.cutoffExcludedSaleRecordCount, 1);
assert.equal(cutoffProjection.source.asOfPriceExcludedCount, 1);
assert.equal(cutoffProjection.source.asOfReconstructionIssueCount, 0);
assert.equal(
  cutoffProjection.aging.skuRows[0]?.purchaseCost.missingPriceQuantity,
  1
);
assert.equal(cutoffProjection.period.source.saleRecordCount, 0);

const saleWithoutStock = aggregateInventoryStatistics(
  {
    inventory: [],
    balances: [],
    movementCount: 0,
    movements: [],
    sales: [
      {
        saleRecordId: 1,
        pgNo: "PERIOD-SALE-WITHOUT-STOCK",
        inventorySkuId: 1,
        soldAt: timestampDaysAgo(1),
        saleStatus: "COMPLETED",
        sku: sku(1),
      },
    ],
  },
  { now: NOW, period: "30d" }
);
assert.equal(saleWithoutStock.period.integrity.availability, "PARTIAL");
assert.ok(
  issueCodes(saleWithoutStock).has("SALE_WITHOUT_WAREHOUSE_DENOMINATOR")
);
assert.equal(saleWithoutStock.period.summary.averageWarehouseQuantity, 0);
assert.equal(saleWithoutStock.period.summary.turnover.value, null);

const empty = aggregateInventoryStatistics(
  {
    inventory: [],
    balances: [],
    movementCount: 0,
    movements: [],
    sales: [],
  },
  { now: NOW, period: "30d" }
);
assert.equal(empty.period.integrity.availability, "EMPTY");
assert.equal(empty.period.dayCount, 30);
assert.equal(empty.period.summary.salesCompletedQuantity, 0);
assert.equal(empty.period.summary.turnover.value, null);

console.log(
  "Inventory statistics period range, flow, turnover, integrity, and empty contracts verified."
);
