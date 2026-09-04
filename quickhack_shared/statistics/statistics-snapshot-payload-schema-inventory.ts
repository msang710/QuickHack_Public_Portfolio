import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import type {
  InventoryStatisticsAgeBucket,
  InventoryStatisticsAgingIssue,
  InventoryStatisticsCurrentGroup,
  InventoryStatisticsIntegrityIssue,
  InventoryStatisticsPeriodDailyPoint,
  InventoryStatisticsPeriodData,
  InventoryStatisticsPeriodIssue,
  InventoryStatisticsPeriodSkuRow,
  InventoryStatisticsPeriodSourceCoverage,
  InventoryStatisticsPeriodTransitionRow,
  InventoryStatisticsPurchaseCostMetric,
  InventoryStatisticsSkuBurdenRow,
  InventoryStatisticsSourceCoverage,
  InventoryStatisticsStatusQuantity,
  InventoryStatisticsTurnoverMetric,
  InventoryStatisticsData,
} from "@/quickhack_shared/statistics/statistics";
import { STATISTICS_UNAVAILABLE_REASON_CODES } from "@/quickhack_shared/statistics/statistics";
import {
  nullableNumberSchema,
  statisticsCalculationMetadataSchema,
} from "@/quickhack_shared/statistics/statistics-snapshot-payload-schema-common";
import {
  arraySchema,
  finiteNumberSchema,
  nullableSchema,
  objectSchema,
  oneOfSchema,
  optionalSchema,
  stringSchema,
} from "@/quickhack_shared/statistics/statistics-runtime-schema";

const ledgerAvailabilitySchema = oneOfSchema(
  "READY",
  "EMPTY",
  "PARTIAL"
);

const inventoryStatusSchema = oneOfSchema(
  ...Object.values(INVENTORY_STATUS)
);

const statusGroupSchema = oneOfSchema(
  "SELLABLE",
  "ORDER_ALLOCATED",
  "SALES_RESTRICTED",
  "DELIVERING",
  "TRACKING_EXCEPTION",
  "FINAL_DELIVERY",
  "CLAIM_LOCATION_UNKNOWN"
);

const statusQuantitySchema =
  objectSchema<InventoryStatisticsStatusQuantity>({
    status: inventoryStatusSchema,
    quantity: nullableNumberSchema,
  });

const currentGroupSchema = objectSchema<InventoryStatisticsCurrentGroup>({
  key: statusGroupSchema,
  quantity: nullableNumberSchema,
  statuses: arraySchema(statusQuantitySchema),
});

const purchaseCostMetricSchema =
  objectSchema<InventoryStatisticsPurchaseCostMetric>({
    amount: nullableNumberSchema,
    pricedQuantity: nullableNumberSchema,
    totalQuantity: nullableNumberSchema,
    missingPriceQuantity: nullableNumberSchema,
    coveragePercent: nullableNumberSchema,
  });

const ageBucketSchema = objectSchema<InventoryStatisticsAgeBucket>({
  key: oneOfSchema(
    "DAYS_0_29",
    "DAYS_30_59",
    "DAYS_60_89",
    "DAYS_90_PLUS"
  ),
  fromDays: finiteNumberSchema,
  toDays: nullableNumberSchema,
  quantity: nullableNumberSchema,
  purchaseCost: purchaseCostMetricSchema,
});

const skuBurdenRowSchema =
  objectSchema<InventoryStatisticsSkuBurdenRow>({
    skuCode: stringSchema,
    model: stringSchema,
    storage: stringSchema,
    color: stringSchema,
    saleGrade: stringSchema,
    quantity: nullableNumberSchema,
    longTermQuantity: nullableNumberSchema,
    ageBuckets: arraySchema(ageBucketSchema),
    purchaseCost: purchaseCostMetricSchema,
  });

const agingIssueSchema = objectSchema<InventoryStatisticsAgingIssue>({
  code: oneOfSchema(
    "MISSING_PG_MOVEMENT_HISTORY",
    "INVALID_PG_MOVEMENT_GROUP",
    "INVALID_MOVEMENT_TIMESTAMP",
    "CURRENT_STATUS_HISTORY_MISMATCH",
    "FUTURE_HOLDING_CYCLE_START"
  ),
  count: finiteNumberSchema,
});

const periodIssueSchema = objectSchema<InventoryStatisticsPeriodIssue>({
  code: oneOfSchema(
    "CURRENT_LEDGER_NOT_READY",
    "INVALID_MOVEMENT_GROUP",
    "INVALID_MOVEMENT_TIMESTAMP",
    "INVALID_MOVEMENT_QUANTITY",
    "BALANCE_MOVEMENT_CHAIN_MISMATCH",
    "CURRENT_BALANCE_TAIL_MISMATCH",
    "PG_STATUS_HISTORY_MISMATCH",
    "FUTURE_MOVEMENT",
    "INVALID_SALE_TIMESTAMP",
    "FUTURE_SALE_TIMESTAMP",
    "SALE_WITHOUT_WAREHOUSE_DENOMINATOR"
  ),
  count: finiteNumberSchema,
});

const turnoverMetricSchema =
  objectSchema<InventoryStatisticsTurnoverMetric>({
    value: nullableNumberSchema,
    soldQuantity: finiteNumberSchema,
    averageWarehouseQuantity: nullableNumberSchema,
    unavailableReason: optionalSchema(stringSchema),
    unavailableReasonCode: optionalSchema(oneOfSchema(...STATISTICS_UNAVAILABLE_REASON_CODES)),
    unavailableReasonDays: optionalSchema(finiteNumberSchema),
  });

const periodSourceCoverageSchema =
  objectSchema<InventoryStatisticsPeriodSourceCoverage>({
    movementRowCount: finiteNumberSchema,
    operationCount: finiteNumberSchema,
    skuReclassificationOperationCount: finiteNumberSchema,
    saleRecordCount: finiteNumberSchema,
    classifiedSaleRecordCount: finiteNumberSchema,
    unclassifiedSaleRecordCount: finiteNumberSchema,
    returnedSaleRecordCount: finiteNumberSchema,
    invalidSaleTimestampCount: finiteNumberSchema,
  });

const periodDailyPointSchema =
  objectSchema<InventoryStatisticsPeriodDailyPoint>({
    date: stringSchema,
    closingWarehouseQuantity: nullableNumberSchema,
    newInventoryQuantity: nullableNumberSchema,
    warehouseReentryQuantity: nullableNumberSchema,
    customerReturnReentryQuantity: nullableNumberSchema,
    otherWarehouseReentryQuantity: nullableNumberSchema,
    warehouseExitQuantity: nullableNumberSchema,
    removedQuantity: nullableNumberSchema,
    salesCompletedQuantity: finiteNumberSchema,
  });

const nullableStatusGroupSchema = nullableSchema(statusGroupSchema);

const periodTransitionRowSchema =
  objectSchema<InventoryStatisticsPeriodTransitionRow>({
    fromGroup: nullableStatusGroupSchema,
    toGroup: nullableStatusGroupSchema,
    quantity: finiteNumberSchema,
  });

const periodSkuRowSchema =
  objectSchema<InventoryStatisticsPeriodSkuRow>({
    skuCode: stringSchema,
    model: stringSchema,
    storage: stringSchema,
    color: stringSchema,
    saleGrade: stringSchema,
    averageWarehouseQuantity: nullableNumberSchema,
    salesCompletedQuantity: finiteNumberSchema,
    turnover: turnoverMetricSchema,
  });

const periodDataSchema = objectSchema<InventoryStatisticsPeriodData>({
  preset: oneOfSchema("30d", "90d", "1y", "all", "custom"),
  fromDate: stringSchema,
  toDate: stringSchema,
  dayCount: finiteNumberSchema,
  integrity: objectSchema<InventoryStatisticsPeriodData["integrity"]>({
    availability: ledgerAvailabilitySchema,
    issues: arraySchema(periodIssueSchema),
  }),
  source: periodSourceCoverageSchema,
  summary: objectSchema<InventoryStatisticsPeriodData["summary"]>({
    newInventoryQuantity: nullableNumberSchema,
    warehouseReentryQuantity: nullableNumberSchema,
    customerReturnReentryQuantity: nullableNumberSchema,
    otherWarehouseReentryQuantity: nullableNumberSchema,
    warehouseExitQuantity: nullableNumberSchema,
    removedQuantity: nullableNumberSchema,
    salesCompletedQuantity: finiteNumberSchema,
    averageWarehouseQuantity: nullableNumberSchema,
    turnover: turnoverMetricSchema,
  }),
  daily: arraySchema(periodDailyPointSchema),
  transitions: arraySchema(periodTransitionRowSchema),
  skuRows: arraySchema(periodSkuRowSchema),
});

const integrityIssueSchema =
  objectSchema<InventoryStatisticsIntegrityIssue>({
    code: oneOfSchema(
      "LEDGER_MISSING",
      "LEDGER_ONE_SIDED",
      "AS_OF_RECONSTRUCTION_FAILED",
      "UNCLASSIFIED_INVENTORY",
      "UNKNOWN_INVENTORY_STATUS",
      "UNKNOWN_BALANCE_STATUS",
      "NEGATIVE_BALANCE",
      "SKU_STATUS_MISMATCH"
    ),
    count: finiteNumberSchema,
  });

const sourceCoverageSchema =
  objectSchema<InventoryStatisticsSourceCoverage>({
    inventoryRowCount: finiteNumberSchema,
    classifiedInventoryRowCount: finiteNumberSchema,
    unclassifiedInventoryRowCount: finiteNumberSchema,
    balanceRowCount: finiteNumberSchema,
    balanceQuantity: finiteNumberSchema,
    movementCount: finiteNumberSchema,
    unknownInventoryStatusCount: finiteNumberSchema,
    unknownBalanceStatusCount: finiteNumberSchema,
    negativeBalanceCount: finiteNumberSchema,
    skuStatusMismatchCount: finiteNumberSchema,
    cutoffExcludedMovementCount: finiteNumberSchema,
    cutoffExcludedSaleRecordCount: finiteNumberSchema,
    asOfPriceExcludedCount: finiteNumberSchema,
    asOfReconstructionIssueCount: finiteNumberSchema,
  });

export const inventoryStatisticsDataSchema =
  objectSchema<InventoryStatisticsData>({
    generatedAt: stringSchema,
    calculation: statisticsCalculationMetadataSchema,
    source: sourceCoverageSchema,
    integrity: objectSchema<InventoryStatisticsData["integrity"]>({
      availability: ledgerAvailabilitySchema,
      issues: arraySchema(integrityIssueSchema),
    }),
    asOf: objectSchema<InventoryStatisticsData["asOf"]>({
      date: stringSchema,
      totalQuantity: nullableNumberSchema,
      groups: arraySchema(currentGroupSchema),
    }),
    aging: objectSchema<InventoryStatisticsData["aging"]>({
      integrity: objectSchema<
        InventoryStatisticsData["aging"]["integrity"]
      >({
        availability: ledgerAvailabilitySchema,
        issues: arraySchema(agingIssueSchema),
      }),
      warehouseQuantity: nullableNumberSchema,
      resolvedCycleQuantity: finiteNumberSchema,
      missingCycleQuantity: finiteNumberSchema,
      longTermQuantity: nullableNumberSchema,
      longTermPurchaseCost: purchaseCostMetricSchema,
      buckets: arraySchema(ageBucketSchema),
      skuRows: arraySchema(skuBurdenRowSchema),
    }),
    period: periodDataSchema,
  });
