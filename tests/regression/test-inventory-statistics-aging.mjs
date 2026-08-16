import assert from "node:assert/strict";
import {
  aggregateInventoryStatistics,
  resolveCurrentHoldingCycle,
} from "../../quickhack_server/statistics/inventory-statistics-service.ts";
import { formatKstSqlDateTime } from "../../quickhack_shared/core/time.ts";
import { INVENTORY_STATUS } from "../../quickhack_shared/inventory/inventory-status.ts";

const NOW = new Date("2026-07-28T03:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;
let movementId = 0;

function timestampDaysAgo(days) {
  return formatKstSqlDateTime(
    new Date(NOW.getTime() - days * MS_PER_DAY)
  );
}

function sku(inventorySkuId) {
  return {
    skuCode: `STATS-SKU-${inventorySkuId}`,
    model: `모델 ${inventorySkuId}`,
    storage: `${inventorySkuId * 128}GB`,
    color: `색상 ${inventorySkuId}`,
    saleGrade: "A",
  };
}

function inventory(
  inventoryId,
  pgNo,
  inventorySkuId,
  inventoryStatus,
  purchasePrice = null
) {
  return {
    inventoryId,
    pgNo,
    inventorySkuId,
    inventoryStatus,
    sku: sku(inventorySkuId),
    purchasePrice,
  };
}

function movement({
  operationKey,
  movementType,
  pgNo,
  inventorySkuId,
  inventoryStatus,
  quantityDelta,
  occurredAt,
}) {
  movementId += 1;
  return {
    movementId,
    operationKey,
    movementType,
    pgNo,
    inventorySkuId,
    inventoryStatus,
    quantityDelta,
    occurredAt,
  };
}

function created(
  pgNo,
  inventorySkuId,
  inventoryStatus,
  occurredAt,
  movementType = "INVENTORY_CREATED"
) {
  return [
    movement({
      operationKey: `${pgNo}:${movementType}:${occurredAt}`,
      movementType,
      pgNo,
      inventorySkuId,
      inventoryStatus,
      quantityDelta: 1,
      occurredAt,
    }),
  ];
}

function transfer(
  pgNo,
  inventorySkuId,
  fromStatus,
  toStatus,
  occurredAt
) {
  const operationKey =
    `${pgNo}:STATUS:${fromStatus}:${toStatus}:${occurredAt}`;

  return [
    movement({
      operationKey,
      movementType: "STATUS_TRANSFER",
      pgNo,
      inventorySkuId,
      inventoryStatus: fromStatus,
      quantityDelta: -1,
      occurredAt,
    }),
    movement({
      operationKey,
      movementType: "STATUS_TRANSFER",
      pgNo,
      inventorySkuId,
      inventoryStatus: toStatus,
      quantityDelta: 1,
      occurredAt,
    }),
  ];
}

function reclassify(
  pgNo,
  previousInventorySkuId,
  nextInventorySkuId,
  inventoryStatus,
  occurredAt
) {
  const operationKey =
    `${pgNo}:SKU:${previousInventorySkuId}:${nextInventorySkuId}:${occurredAt}`;

  return [
    movement({
      operationKey,
      movementType: "SKU_RECLASSIFICATION",
      pgNo,
      inventorySkuId: previousInventorySkuId,
      inventoryStatus,
      quantityDelta: -1,
      occurredAt,
    }),
    movement({
      operationKey,
      movementType: "SKU_RECLASSIFICATION",
      pgNo,
      inventorySkuId: nextInventorySkuId,
      inventoryStatus,
      quantityDelta: 1,
      occurredAt,
    }),
  ];
}

function balancesFor(rows) {
  const quantities = new Map();

  for (const row of rows) {
    const key = `${row.inventorySkuId}\u0000${row.inventoryStatus}`;
    quantities.set(key, (quantities.get(key) ?? 0) + 1);
  }

  return Array.from(quantities.entries()).map(([key, quantity], index) => {
    const [inventorySkuId, inventoryStatus] = key.split("\u0000");

    return {
      balanceId: index + 1,
      inventorySkuId: Number(inventorySkuId),
      inventoryStatus,
      quantity,
    };
  });
}

function aggregate(rows, movements, options = {}) {
  return aggregateInventoryStatistics(
    {
      inventory: rows,
      balances: balancesFor(rows),
      movementCount:
        options.movementCount ?? Math.max(movements.length, rows.length),
      movements,
    },
    { now: options.now ?? NOW }
  );
}

function bucketQuantities(data) {
  return Object.fromEntries(
    data.aging.buckets.map((bucket) => [bucket.key, bucket.quantity])
  );
}

const internalPg = "AGING-INTERNAL";
const returnedPg = "AGING-RETURNED";
const preShipmentPg = "AGING-PRESHIPMENT";
const allocatedPg = "AGING-ALLOCATED";
const deliveringPg = "AGING-DELIVERING";
const mainRows = [
  inventory(1, internalPg, 1, INVENTORY_STATUS.hold, 100_000),
  inventory(2, returnedPg, 1, INVENTORY_STATUS.sellable, 110_000),
  inventory(3, preShipmentPg, 2, INVENTORY_STATUS.sellable, null),
  inventory(4, allocatedPg, 2, INVENTORY_STATUS.reserved, 130_000),
  inventory(5, deliveringPg, 3, INVENTORY_STATUS.delivering, 140_000),
];
const mainMovements = [
  ...created(
    internalPg,
    1,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(100)
  ),
  ...transfer(
    internalPg,
    1,
    INVENTORY_STATUS.sellable,
    INVENTORY_STATUS.reserved,
    timestampDaysAgo(80)
  ),
  ...reclassify(
    internalPg,
    1,
    1,
    INVENTORY_STATUS.reserved,
    timestampDaysAgo(70)
  ),
  ...transfer(
    internalPg,
    1,
    INVENTORY_STATUS.reserved,
    INVENTORY_STATUS.hold,
    timestampDaysAgo(20)
  ),
  ...created(
    returnedPg,
    1,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(120)
  ),
  ...transfer(
    returnedPg,
    1,
    INVENTORY_STATUS.sellable,
    INVENTORY_STATUS.delivering,
    timestampDaysAgo(60)
  ),
  ...transfer(
    returnedPg,
    1,
    INVENTORY_STATUS.delivering,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(20)
  ),
  ...created(
    preShipmentPg,
    2,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(40)
  ),
  ...transfer(
    preShipmentPg,
    2,
    INVENTORY_STATUS.sellable,
    INVENTORY_STATUS.reserved,
    timestampDaysAgo(5)
  ),
  ...transfer(
    preShipmentPg,
    2,
    INVENTORY_STATUS.reserved,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(2)
  ),
  ...created(
    allocatedPg,
    2,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(100)
  ),
  ...transfer(
    allocatedPg,
    2,
    INVENTORY_STATUS.sellable,
    INVENTORY_STATUS.reserved,
    timestampDaysAgo(10)
  ),
  ...created(
    deliveringPg,
    3,
    INVENTORY_STATUS.delivering,
    timestampDaysAgo(10)
  ),
];
const main = aggregate(mainRows, mainMovements);

assert.equal(main.integrity.availability, "READY");
assert.equal(main.aging.integrity.availability, "READY");
assert.equal(main.aging.warehouseQuantity, 4);
assert.equal(main.aging.resolvedCycleQuantity, 4);
assert.equal(main.aging.missingCycleQuantity, 0);
assert.equal(main.aging.longTermQuantity, 2);
assert.deepEqual(bucketQuantities(main), {
  DAYS_0_29: 1,
  DAYS_30_59: 1,
  DAYS_60_89: 0,
  DAYS_90_PLUS: 1,
});
assert.deepEqual(main.aging.longTermPurchaseCost, {
  amount: 100_000,
  pricedQuantity: 1,
  totalQuantity: 2,
  missingPriceQuantity: 1,
  coveragePercent: 50,
});
assert.equal(main.aging.skuRows.length, 2);
assert.equal(
  main.aging.buckets.reduce(
    (sum, bucket) => sum + (bucket.quantity ?? 0),
    0
  ),
  3,
  "Order-allocated and non-warehouse inventory must not enter burden buckets."
);

const returnedResolution = resolveCurrentHoldingCycle({
  pgNo: returnedPg,
  currentStatus: INVENTORY_STATUS.sellable,
  movements: mainMovements.filter((row) => row.pgNo === returnedPg),
});
assert.equal(returnedResolution.startedAt, timestampDaysAgo(20));
assert.equal(returnedResolution.issueCode, null);

const preShipmentResolution = resolveCurrentHoldingCycle({
  pgNo: preShipmentPg,
  currentStatus: INVENTORY_STATUS.sellable,
  movements: mainMovements.filter((row) => row.pgNo === preShipmentPg),
});
assert.equal(preShipmentResolution.startedAt, timestampDaysAgo(40));
assert.equal(preShipmentResolution.issueCode, null);

const reclassifiedPg = "AGING-RECLASSIFIED";
const reclassifiedResolution = resolveCurrentHoldingCycle({
  pgNo: reclassifiedPg,
  currentStatus: INVENTORY_STATUS.sellable,
  movements: [
    ...created(
      reclassifiedPg,
      90,
      INVENTORY_STATUS.sellable,
      timestampDaysAgo(70)
    ),
    ...reclassify(
      reclassifiedPg,
      90,
      91,
      INVENTORY_STATUS.sellable,
      timestampDaysAgo(10)
    ),
  ],
});
assert.equal(reclassifiedResolution.startedAt, timestampDaysAgo(70));
assert.equal(reclassifiedResolution.issueCode, null);

const boundaryRows = [29, 30, 59, 60, 89, 90].map((days, index) =>
  inventory(
    100 + index,
    `AGING-BOUNDARY-${days}`,
    10,
    INVENTORY_STATUS.sellable,
    10_000 + index
  )
);
const boundaryMovements = [29, 30, 59, 60, 89, 90].flatMap(
  (days) =>
    created(
      `AGING-BOUNDARY-${days}`,
      10,
      INVENTORY_STATUS.sellable,
      timestampDaysAgo(days)
    )
);
const boundaries = aggregate(boundaryRows, boundaryMovements);

assert.equal(boundaries.aging.integrity.availability, "READY");
assert.deepEqual(bucketQuantities(boundaries), {
  DAYS_0_29: 2,
  DAYS_30_59: 2,
  DAYS_60_89: 2,
  DAYS_90_PLUS: 0,
});
assert.equal(boundaries.aging.longTermQuantity, 4);

const lifecycleReentryPg = "AGING-LIFECYCLE-REENTRY";
const lifecycleReentry = aggregate(
  [
    inventory(
      202,
      lifecycleReentryPg,
      20,
      INVENTORY_STATUS.sellable,
      100_000
    ),
  ],
  [
    ...created(
      lifecycleReentryPg,
      20,
      INVENTORY_STATUS.sellable,
      timestampDaysAgo(100)
    ),
    ...transfer(
      lifecycleReentryPg,
      20,
      INVENTORY_STATUS.sellable,
      INVENTORY_STATUS.delivering,
      timestampDaysAgo(50)
    ),
    ...transfer(
      lifecycleReentryPg,
      20,
      INVENTORY_STATUS.delivering,
      INVENTORY_STATUS.sellable,
      timestampDaysAgo(10)
    ),
  ]
);
assert.equal(lifecycleReentry.aging.integrity.availability, "READY");
assert.deepEqual(bucketQuantities(lifecycleReentry), {
  DAYS_0_29: 1,
  DAYS_30_59: 0,
  DAYS_60_89: 0,
  DAYS_90_PLUS: 0,
});

const missingHistory = aggregate(
  [
    inventory(
      301,
      "AGING-MISSING",
      30,
      INVENTORY_STATUS.sellable,
      100_000
    ),
  ],
  [],
  { movementCount: 1 }
);
assert.equal(missingHistory.integrity.availability, "READY");
assert.equal(missingHistory.aging.integrity.availability, "PARTIAL");
assert.ok(
  missingHistory.aging.integrity.issues.some(
    (issue) => issue.code === "MISSING_PG_MOVEMENT_HISTORY"
  )
);

const malformedPg = "AGING-MALFORMED";
const malformedCreated = created(
  malformedPg,
  31,
  INVENTORY_STATUS.sellable,
  timestampDaysAgo(50)
);
const malformedTransfer = transfer(
  malformedPg,
  31,
  INVENTORY_STATUS.sellable,
  INVENTORY_STATUS.reserved,
  timestampDaysAgo(10)
).slice(1);
const malformed = aggregate(
  [
    inventory(
      302,
      malformedPg,
      31,
      INVENTORY_STATUS.reserved,
      100_000
    ),
  ],
  [...malformedCreated, ...malformedTransfer]
);
assert.equal(malformed.aging.integrity.availability, "PARTIAL");
assert.ok(
  malformed.aging.integrity.issues.some(
    (issue) => issue.code === "INVALID_PG_MOVEMENT_GROUP"
  )
);

const mismatchPg = "AGING-MISMATCH";
const mismatch = aggregate(
  [
    inventory(
      303,
      mismatchPg,
      32,
      INVENTORY_STATUS.hold,
      100_000
    ),
  ],
  created(
    mismatchPg,
    32,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(30)
  )
);
assert.equal(mismatch.aging.integrity.availability, "PARTIAL");
assert.ok(
  mismatch.aging.integrity.issues.some(
    (issue) => issue.code === "CURRENT_STATUS_HISTORY_MISMATCH"
  )
);

const invalidTimestampPg = "AGING-INVALID-TIMESTAMP";
const invalidTimestamp = aggregate(
  [
    inventory(
      304,
      invalidTimestampPg,
      33,
      INVENTORY_STATUS.sellable,
      100_000
    ),
  ],
  created(
    invalidTimestampPg,
    33,
    INVENTORY_STATUS.sellable,
    "not-a-timestamp"
  )
);
assert.equal(invalidTimestamp.aging.integrity.availability, "PARTIAL");
assert.ok(
  invalidTimestamp.integrity.issues.some(
    (issue) => issue.code === "AS_OF_RECONSTRUCTION_FAILED"
  )
);

const futurePg = "AGING-FUTURE";
const future = aggregate(
  [
    inventory(
      305,
      futurePg,
      34,
      INVENTORY_STATUS.sellable,
      100_000
    ),
  ],
  created(
    futurePg,
    34,
    INVENTORY_STATUS.sellable,
    timestampDaysAgo(-1)
  )
);
assert.equal(future.aging.integrity.availability, "PARTIAL");
assert.equal(future.source.cutoffExcludedMovementCount, 1);
assert.equal(future.asOf.totalQuantity, null);
assert.ok(
  future.integrity.issues.some(
    (issue) => issue.code === "AS_OF_RECONSTRUCTION_FAILED"
  )
);

console.log(
  "Inventory statistics holding-cycle, aging, long-term burden, and purchase-cost contracts verified."
);
