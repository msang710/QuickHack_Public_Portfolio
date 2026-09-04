// QuickHack note: 통계 API와 화면이 함께 사용하는 집계 응답 타입입니다.
import type { InventoryStatusCode } from "@/quickhack_shared/inventory/inventory-status";
import type { InventoryLedgerAvailability } from "@/quickhack_shared/inventory/inventory-quantity";
import type { StatisticsDateRange } from "@/quickhack_shared/statistics/statistics-period";

export type StatisticsCalculationMode = "LIVE" | "SNAPSHOT";

export type StatisticsSnapshotFallbackReason =
  | "NOT_FOUND"
  | "TOO_OLD"
  | "INVALID";

export type StatisticsCalculationDelivery =
  | {
      status: "SNAPSHOT_CURRENT" | "SNAPSHOT_DELAYED";
      snapshotCutoffDate: string;
      snapshotCutoffLagDays: number;
    }
  | {
      status: "LIVE_CUSTOM_PERIOD";
    }
  | {
      status: "LIVE_FALLBACK";
      fallbackReason: StatisticsSnapshotFallbackReason;
    };

export type StatisticsCalculationMetadata = {
  mode: StatisticsCalculationMode;
  period: StatisticsDateRange & { dayCount: number };
  comparisonPeriod: StatisticsDateRange & { dayCount: number };
  dataCutoffDate: string;
  isDefaultPeriod: boolean;
  /**
   * API 제공 시 dispatcher가 덧붙이는 상태입니다.
   * 저장된 v2 snapshot은 이 요청 시점 정보를 포함하지 않을 수 있습니다.
   */
  delivery?: StatisticsCalculationDelivery;
};

export type StatisticsGroup = {
  label: string;
  count: number;
  meta?: string;
};

export type StatisticsPoint = {
  label: string;
  value: number;
};

export const STATISTICS_UNAVAILABLE_REASON_CODES = [
  "NO_DENOMINATOR", "NO_MATURE_SALES", "NO_CONFIRMED_RETURN_FAULT_SAMPLE",
  "NO_CONFIRMED_RETURN_INSPECTION_SAMPLE", "NO_CURRENT_MATURE_COHORT",
  "NO_PREVIOUS_MATURE_COHORT", "NO_CURRENT_30_DAY_MATURE_COHORT",
  "NO_PREVIOUS_30_DAY_MATURE_COHORT", "NO_RETURN_RECEIPTS",
  "NO_MATURE_PURCHASE_BATCHES", "NO_LINKED_INBOUND_INSPECTION_SAMPLE",
  "NO_TERMINAL_INBOUND_BATCHES", "NO_ORIGINAL_SUPPLIER_SALES_SAMPLE",
  "INVENTORY_LEDGER_UNAVAILABLE", "NO_INVENTORY_OR_SALES",
  "SALES_WITHOUT_INVENTORY_DENOMINATOR", "SALE_LEDGER_TIMESTAMP_UNVERIFIED",
] as const;

export type StatisticsUnavailableReasonCode =
  (typeof STATISTICS_UNAVAILABLE_REASON_CODES)[number];

export type StatisticsUnavailableReason = {
  unavailableReasonCode?: StatisticsUnavailableReasonCode;
  unavailableReasonDays?: number;
  /** Legacy snapshots keep their original authored text verbatim. */
  unavailableReason?: string;
};

export type SalesRateMetric = StatisticsUnavailableReason & {
  value: number | null;
  numerator: number;
  denominator: number;
};

export type SalesAmountMetric = {
  amount: number | null;
  pricedCount: number;
  totalCount: number;
  coveragePercent: number;
};

export type SalesGrossProfitMetric = {
  amount: number | null;
  salesAmount: number | null;
  purchaseCostAmount: number | null;
  comparableCount: number;
  totalCount: number;
  coveragePercent: number;
  marginPercent: number | null;
};

export type SalesLeadTimeBucketKey =
  | "DAYS_0_29"
  | "DAYS_30_59"
  | "DAYS_60_89"
  | "DAYS_90_PLUS";

export type SalesLeadTimeBucket = {
  key: SalesLeadTimeBucketKey;
  count: number;
};

export type SalesLeadTimeMetric = {
  averageDays: number | null;
  sampleCount: number;
  totalCount: number;
  coveragePercent: number;
  excludedAnomalyCount: number;
  buckets: SalesLeadTimeBucket[];
};

export type SalesStatisticsSourceCoverage = {
  loadedSaleRecordCount: number;
  periodEligibleSaleRecordCount: number;
  outsidePeriodSaleRecordCount: number;
  cutoffExcludedSaleRecordCount: number;
  eligibleSaleRecordCount: number;
  soldSaleRecordCount: number;
  returnedSaleRecordCount: number;
  excludedStatusCount: number;
  invalidSoldAtCount: number;
  futureSoldAtCount: number;
  pricedSaleCount: number;
  salesPriceCoveragePercent: number;
  purchasePricedSaleCount: number;
  purchasePriceCoveragePercent: number;
  comparableProfitCount: number;
  profitCoveragePercent: number;
  leadTimeSampleCount: number;
  missingPurchaseAgreedAtCount: number;
  invalidLeadTimeCount: number;
};

export type SalesMonthlyTrendRow = {
  month: string;
  saleCount: number;
  salesAmount: SalesAmountMetric;
  averageSalesPrice: number | null;
  grossProfit: SalesGrossProfitMetric;
};

export type SalesProductPerformanceRow = {
  key: string;
  skuCode: string;
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
  warrantyGroup: string;
  saleCount: number;
  saleShare: SalesRateMetric;
  salesAmount: SalesAmountMetric;
  averageSalesPrice: number | null;
  grossProfit: SalesGrossProfitMetric;
  leadTime: SalesLeadTimeMetric;
  longTermSaleCount: number;
};

export type SalesDimensionKey =
  | "MODEL"
  | "STORAGE"
  | "COLOR"
  | "SALE_GRADE"
  | "WARRANTY_GROUP"
  | "CHANNEL";

export type SalesDimensionPerformanceRow = {
  dimension: SalesDimensionKey;
  label: string;
  saleCount: number;
  saleShare: SalesRateMetric;
  salesAmount: SalesAmountMetric;
  averageSalesPrice: number | null;
  grossProfit: SalesGrossProfitMetric;
};

export type SalesPriceGradeRow = {
  priceBand: string;
  totalCount: number;
  gradeCounts: Record<string, number>;
};

export type SalesChannelPerformanceRow = {
  channel: string;
  saleCount: number;
  saleShare: SalesRateMetric;
  salesAmount: SalesAmountMetric;
  averageSalesPrice: number | null;
  grossProfit: SalesGrossProfitMetric;
  leadTime: SalesLeadTimeMetric;
};

export type SalesStatisticsData = {
  generatedAt: string;
  calculation: StatisticsCalculationMetadata;
  source: SalesStatisticsSourceCoverage;
  summary: {
    saleCount: number;
    salesAmount: SalesAmountMetric;
    averageSalesPrice: number | null;
    purchaseCost: SalesAmountMetric;
    grossProfit: SalesGrossProfitMetric;
    leadTime: SalesLeadTimeMetric;
  };
  monthlyTrend: SalesMonthlyTrendRow[];
  productRows: SalesProductPerformanceRow[];
  dimensionRows: SalesDimensionPerformanceRow[];
  priceGradeColumns: string[];
  priceGradeRows: SalesPriceGradeRow[];
  channelRows: SalesChannelPerformanceRow[];
};

export type SalesStatisticsApiResponse = {
  ok: boolean;
  message?: string;
  data?: SalesStatisticsData;
};

export type DashboardBatchProgress = {
  inboundBatchId: number;
  batchDate: string;
  batchNo: number;
  expectedQuantity: number;
  linkedQuantity: number;
  inspectedToday: number;
  normalInboundTargetQuantity: number;
  supplierReturnQuantity: number;
  arrivalDifference: number;
  shortageQuantity: number;
  excessQuantity: number;
  appearanceCompletedCount: number;
  functionCompletedCount: number;
  purchasePendingCount: number;
  appearancePercent: number;
  functionPercent: number;
  purchasePendingPercent: number;
};

export type DashboardStatisticsData = {
  generatedAt: string;
  today: string;
  summary: {
    batchCount: number;
    expectedQuantity: number;
    linkedQuantity: number;
    inspectedToday: number;
    normalInboundTargetQuantity: number;
    supplierReturnQuantity: number;
    arrivalDifference: number;
    shortageQuantity: number;
    excessQuantity: number;
  };
  batches: DashboardBatchProgress[];
};

export type DashboardStatisticsApiResponse = {
  ok: boolean;
  message?: string;
  data?: DashboardStatisticsData;
};

export type InventoryStatisticsStatusGroupKey =
  | "SELLABLE"
  | "ORDER_ALLOCATED"
  | "SALES_RESTRICTED"
  | "DELIVERING"
  | "TRACKING_EXCEPTION"
  | "FINAL_DELIVERY"
  | "CLAIM_LOCATION_UNKNOWN";

export type InventoryStatisticsStatusQuantity = {
  status: InventoryStatusCode;
  quantity: number | null;
};

export type InventoryStatisticsCurrentGroup = {
  key: InventoryStatisticsStatusGroupKey;
  quantity: number | null;
  statuses: InventoryStatisticsStatusQuantity[];
};

export type InventoryStatisticsAgeBucketKey =
  | "DAYS_0_29"
  | "DAYS_30_59"
  | "DAYS_60_89"
  | "DAYS_90_PLUS";

export type InventoryStatisticsPurchaseCostMetric = {
  amount: number | null;
  pricedQuantity: number | null;
  totalQuantity: number | null;
  missingPriceQuantity: number | null;
  coveragePercent: number | null;
};

export type InventoryStatisticsAgeBucket = {
  key: InventoryStatisticsAgeBucketKey;
  fromDays: number;
  toDays: number | null;
  quantity: number | null;
  purchaseCost: InventoryStatisticsPurchaseCostMetric;
};

export type InventoryStatisticsSkuBurdenRow = {
  skuCode: string;
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
  quantity: number | null;
  longTermQuantity: number | null;
  ageBuckets: InventoryStatisticsAgeBucket[];
  purchaseCost: InventoryStatisticsPurchaseCostMetric;
};

export type InventoryStatisticsAgingIssueCode =
  | "MISSING_PG_MOVEMENT_HISTORY"
  | "INVALID_PG_MOVEMENT_GROUP"
  | "INVALID_MOVEMENT_TIMESTAMP"
  | "CURRENT_STATUS_HISTORY_MISMATCH"
  | "FUTURE_HOLDING_CYCLE_START";

export type InventoryStatisticsAgingIssue = {
  code: InventoryStatisticsAgingIssueCode;
  count: number;
};

export type InventoryStatisticsPeriodPreset =
  | "30d"
  | "90d"
  | "1y"
  | "all";

export type InventoryStatisticsPeriodIssueCode =
  | "CURRENT_LEDGER_NOT_READY"
  | "INVALID_MOVEMENT_GROUP"
  | "INVALID_MOVEMENT_TIMESTAMP"
  | "INVALID_MOVEMENT_QUANTITY"
  | "BALANCE_MOVEMENT_CHAIN_MISMATCH"
  | "CURRENT_BALANCE_TAIL_MISMATCH"
  | "PG_STATUS_HISTORY_MISMATCH"
  | "FUTURE_MOVEMENT"
  | "INVALID_SALE_TIMESTAMP"
  | "FUTURE_SALE_TIMESTAMP"
  | "SALE_WITHOUT_WAREHOUSE_DENOMINATOR";

export type InventoryStatisticsPeriodIssue = {
  code: InventoryStatisticsPeriodIssueCode;
  count: number;
};

export type InventoryStatisticsTurnoverMetric = StatisticsUnavailableReason & {
  value: number | null;
  soldQuantity: number;
  averageWarehouseQuantity: number | null;
};

export type InventoryStatisticsPeriodSourceCoverage = {
  movementRowCount: number;
  operationCount: number;
  skuReclassificationOperationCount: number;
  saleRecordCount: number;
  classifiedSaleRecordCount: number;
  unclassifiedSaleRecordCount: number;
  returnedSaleRecordCount: number;
  invalidSaleTimestampCount: number;
};

export type InventoryStatisticsPeriodDailyPoint = {
  date: string;
  closingWarehouseQuantity: number | null;
  newInventoryQuantity: number | null;
  warehouseReentryQuantity: number | null;
  customerReturnReentryQuantity: number | null;
  otherWarehouseReentryQuantity: number | null;
  warehouseExitQuantity: number | null;
  removedQuantity: number | null;
  salesCompletedQuantity: number;
};

export type InventoryStatisticsPeriodTransitionRow = {
  fromGroup: InventoryStatisticsStatusGroupKey | null;
  toGroup: InventoryStatisticsStatusGroupKey | null;
  quantity: number;
};

export type InventoryStatisticsPeriodSkuRow = {
  skuCode: string;
  model: string;
  storage: string;
  color: string;
  saleGrade: string;
  averageWarehouseQuantity: number | null;
  salesCompletedQuantity: number;
  turnover: InventoryStatisticsTurnoverMetric;
};

export type InventoryStatisticsPeriodData = {
  preset: InventoryStatisticsPeriodPreset | "custom";
  fromDate: string;
  toDate: string;
  dayCount: number;
  integrity: {
    availability: InventoryLedgerAvailability;
    issues: InventoryStatisticsPeriodIssue[];
  };
  source: InventoryStatisticsPeriodSourceCoverage;
  summary: {
    newInventoryQuantity: number | null;
    warehouseReentryQuantity: number | null;
    customerReturnReentryQuantity: number | null;
    otherWarehouseReentryQuantity: number | null;
    warehouseExitQuantity: number | null;
    removedQuantity: number | null;
    salesCompletedQuantity: number;
    averageWarehouseQuantity: number | null;
    turnover: InventoryStatisticsTurnoverMetric;
  };
  daily: InventoryStatisticsPeriodDailyPoint[];
  transitions: InventoryStatisticsPeriodTransitionRow[];
  skuRows: InventoryStatisticsPeriodSkuRow[];
};

export type InventoryStatisticsIntegrityIssueCode =
  | "LEDGER_MISSING"
  | "LEDGER_ONE_SIDED"
  | "AS_OF_RECONSTRUCTION_FAILED"
  | "UNCLASSIFIED_INVENTORY"
  | "UNKNOWN_INVENTORY_STATUS"
  | "UNKNOWN_BALANCE_STATUS"
  | "NEGATIVE_BALANCE"
  | "SKU_STATUS_MISMATCH";

export type InventoryStatisticsIntegrityIssue = {
  code: InventoryStatisticsIntegrityIssueCode;
  count: number;
};

export type InventoryStatisticsSourceCoverage = {
  inventoryRowCount: number;
  classifiedInventoryRowCount: number;
  unclassifiedInventoryRowCount: number;
  balanceRowCount: number;
  balanceQuantity: number;
  movementCount: number;
  unknownInventoryStatusCount: number;
  unknownBalanceStatusCount: number;
  negativeBalanceCount: number;
  skuStatusMismatchCount: number;
  cutoffExcludedMovementCount: number;
  cutoffExcludedSaleRecordCount: number;
  asOfPriceExcludedCount: number;
  asOfReconstructionIssueCount: number;
};

export type InventoryStatisticsData = {
  generatedAt: string;
  calculation: StatisticsCalculationMetadata;
  source: InventoryStatisticsSourceCoverage;
  integrity: {
    availability: InventoryLedgerAvailability;
    issues: InventoryStatisticsIntegrityIssue[];
  };
  asOf: {
    date: string;
    totalQuantity: number | null;
    groups: InventoryStatisticsCurrentGroup[];
  };
  aging: {
    integrity: {
      availability: InventoryLedgerAvailability;
      issues: InventoryStatisticsAgingIssue[];
    };
    warehouseQuantity: number | null;
    resolvedCycleQuantity: number;
    missingCycleQuantity: number;
    longTermQuantity: number | null;
    longTermPurchaseCost: InventoryStatisticsPurchaseCostMetric;
    buckets: InventoryStatisticsAgeBucket[];
    skuRows: InventoryStatisticsSkuBurdenRow[];
  };
  period: InventoryStatisticsPeriodData;
};

export type InventoryStatisticsApiResponse = {
  ok: boolean;
  message?: string;
  data?: InventoryStatisticsData;
};

export type ReturnRateMetric = StatisticsUnavailableReason & {
  value: number | null;
  numerator: number;
  denominator: number;
};

export type ReturnAmountMetric = {
  amount: number | null;
  pricedCount: number;
  totalCount: number;
  coveragePercent: number;
};

export type ReturnDurationMetric = {
  sampleCount: number;
  medianHours: number | null;
  p90Hours: number | null;
  excludedAnomalyCount: number;
};

export type ReturnStatisticsSourceCoverage = {
  eventRecordingStartedAt: string | null;
  lastClaimEventAt: string | null;
  claimEventCount: number;
  observedReturnReceiptCount: number;
  observedCancellationReceiptCount: number;
  observedExchangeCount: number;
  confirmedAllocationLinkCount: number;
  uniqueExternalKeyLinkCount: number;
  linkedSaleRecordCount: number;
  unlinkedReceiptCount: number;
  ambiguousReceiptCount: number;
  cohortSalesCount: number;
  salesPriceAvailableCount: number;
  salesPriceCoveragePercent: number;
  purchasePriceAvailableCount: number;
  purchasePriceCoveragePercent: number;
  confirmedInspectionPgCount: number;
  unmatchedWithdrawalCount: number;
  missingOrInvalidExternalTimestampCount: number;
  claimBeforeSaleCount: number;
  claimAfterThirtyDaysCount: number;
  negativeDurationCount: number;
};

export type ReturnStatisticsSummary = {
  requestRate30Day: ReturnRateMetric;
  previousRequestRate30Day: ReturnRateMetric;
  previousCohortDeltaPercentagePoints: number | null;
  associatedSalesAmount: ReturnAmountMetric;
  vendorFaultShare: ReturnRateMetric;
  resaleRecoveryRate: ReturnRateMetric;
};

export type ReturnCustomerOverview = {
  receiptCount: number;
  returnQuantity: number;
  linkedReceiptCount: number;
  linkedSaleRecordCount: number;
  completedReceiptCount: number;
  withdrawnReceiptCount: number;
  receiptLinkRate: ReturnRateMetric;
  withdrawalShare: ReturnRateMetric;
};

export type ReturnCohortTrendRow = {
  saleMonth: string;
  saleCount: number;
  day7: ReturnRateMetric;
  day14: ReturnRateMetric;
  day30: ReturnRateMetric;
};

export type ReturnOccurrenceTrendRow = {
  receiptMonth: string;
  receiptCount: number;
  returnQuantity: number;
  linkedSaleRecordCount: number;
  completedReceiptCount: number;
  withdrawnReceiptCount: number;
  associatedSalesAmount: ReturnAmountMetric;
};

export type ReturnProductComparisonRow = {
  key: string;
  model: string;
  storage: string;
  saleGrade: string;
  matureSalesCount: number;
  returnSaleRecordCount: number;
  requestRate30Day: ReturnRateMetric;
  previousCohortDeltaPercentagePoints: number | null;
  associatedSalesAmount: ReturnAmountMetric;
  vendorFaultShare: ReturnRateMetric;
  resaleRecoveryRate: ReturnRateMetric;
};

export type ReturnReasonInspectionRow = {
  reason: string;
  receiptCount: number;
  confirmedInspectionPgCount: number;
  recoveredCount: number;
  nonSellableCount: number;
  holdCount: number;
  appearanceDefects: StatisticsGroup[];
  functionDefects: StatisticsGroup[];
};

export type ReturnInspectionOutcome = {
  linkedReturnPgCount: number;
  confirmedInspectionPgCount: number;
  recoveredCount: number;
  nonSellableCount: number;
  holdCount: number;
  recoveryRate: ReturnRateMetric;
};

export type ReturnEconomicImpact = {
  associatedSalesAmount: ReturnAmountMetric;
  associatedPurchaseCost: ReturnAmountMetric;
  recoveredAssetCost: ReturnAmountMetric;
  nonSellableOrHoldAssetCost: ReturnAmountMetric;
};

export type ReturnLeadTimeSummary = {
  externalReceiptToObservation: ReturnDurationMetric;
  observationToApprovalRequest: ReturnDurationMetric;
  observationToLocalFinalization: ReturnDurationMetric;
};

export type PreShipmentCancellationTrendRow = {
  receiptMonth: string;
  receiptCount: number;
  cancellationQuantity: number;
};

export type PreShipmentCancellationStatistics = {
  receiptCount: number;
  cancellationQuantity: number;
  occurrenceTrend: PreShipmentCancellationTrendRow[];
  reasons: StatisticsGroup[];
  products: StatisticsGroup[];
};

export type ExchangeStatistics = {
  receiptCount: number;
  occurrenceTrend: StatisticsPoint[];
  reasons: StatisticsGroup[];
  faults: StatisticsGroup[];
  results: StatisticsGroup[];
  terminalLeadTime: ReturnDurationMetric;
};

export type ReturnStatisticsData = {
  generatedAt: string;
  calculation: StatisticsCalculationMetadata;
  source: ReturnStatisticsSourceCoverage;
  summary: ReturnStatisticsSummary;
  overview: ReturnCustomerOverview;
  cohortTrend: ReturnCohortTrendRow[];
  occurrenceTrend: ReturnOccurrenceTrendRow[];
  productRows: ReturnProductComparisonRow[];
  reasons: StatisticsGroup[];
  faults: StatisticsGroup[];
  reasonInspectionMatrix: ReturnReasonInspectionRow[];
  inspectionOutcome: ReturnInspectionOutcome;
  economicImpact: ReturnEconomicImpact;
  leadTimes: ReturnLeadTimeSummary;
  preShipmentCancellations: PreShipmentCancellationStatistics;
  exchanges: ExchangeStatistics;
};

export type ReturnStatisticsApiResponse = {
  ok: boolean;
  message?: string;
  data?: ReturnStatisticsData;
};

export type PurchaseRateMetric = StatisticsUnavailableReason & {
  value: number | null;
  numerator: number;
  denominator: number;
};

export type PurchaseAmountMetric = {
  amount: number | null;
  pricedCount: number;
  totalCount: number;
  coveragePercent: number;
};

export type PurchaseDurationMetric = {
  sampleCount: number;
  medianHours: number | null;
  p90Hours: number | null;
  excludedAnomalyCount: number;
};

export type PurchaseStatisticsSourceCoverage = {
  loadedTerminalInboundCount: number;
  periodEligibleInboundCount: number;
  outsidePeriodInboundCount: number;
  terminalInboundCount: number;
  purchaseCount: number;
  supplierReturnCount: number;
  pricedPurchaseCount: number;
  missingPurchasePriceCount: number;
  namedSupplierOutcomeCount: number;
  missingSupplierOutcomeCount: number;
  datedPurchaseCount: number;
  datedSupplierReturnCount: number;
  linkedInspectionOutcomeCount: number;
  missingInspectionOutcomeCount: number;
  inspectionLinkCoveragePercent: number;
  knownPurchaseGradeOutcomeCount: number;
  missingPurchaseGradeOutcomeCount: number;
  pricePolicyEvidenceCount: number;
  priceReferenceEvidenceCount: number;
  pricePolicyCoveragePercent: number;
  salesRecordCount: number;
  purchaseInboundLinkedSaleCount: number;
  missingPurchaseInboundSaleCount: number;
  salesLinkCoveragePercent: number;
  supplierSnapshotSaleCount: number;
  missingSupplierSnapshotSaleCount: number;
  supplierSnapshotCoveragePercent: number;
  returnedSaleCount: number;
  invalidTimestampCount: number;
  negativeDurationCount: number;
};

export type PurchaseStatisticsSummary = {
  purchaseCount: number;
  purchaseAmount: PurchaseAmountMetric;
  averagePurchasePrice: number | null;
  supplierCount: number;
  missingPurchasePriceCount: number;
  supplierReturnRate: PurchaseRateMetric;
};

export type PurchaseMonthlyTrendRow = {
  month: string;
  purchaseCount: number;
  purchaseAmount: number | null;
  pricedPurchaseCount: number;
  missingPurchasePriceCount: number;
  supplierReturnCount: number;
  inspectionDefectOutcomeCount: number;
};

export type PurchaseProductPerformanceRow = {
  key: string;
  model: string;
  storage: string;
  purchaseGrade: string;
  terminalOutcomeCount: number;
  purchaseCount: number;
  purchaseAmount: PurchaseAmountMetric;
  averagePurchasePrice: number | null;
  supplierReturnRate: PurchaseRateMetric;
  inspectionDefectRate: PurchaseRateMetric;
  saleConversion30Day: PurchaseRateMetric;
  saleConversion60Day: PurchaseRateMetric;
  saleConversion90Day: PurchaseRateMetric;
};

export type PurchaseSupplierPerformanceRow = {
  supplierName: string;
  terminalOutcomeCount: number;
  purchaseCount: number;
  purchaseAmount: PurchaseAmountMetric;
  averagePurchasePrice: number | null;
  supplierReturnRate: PurchaseRateMetric;
  inspectionDefectRate: PurchaseRateMetric;
  customerReturnConfirmationRate: PurchaseRateMetric;
};

export type PurchasePricePolicyRow = {
  entryMode: "RATE" | "OVERRIDE" | "MANUAL" | "UNKNOWN";
  purchaseCount: number;
  purchaseAmount: PurchaseAmountMetric;
  averagePurchasePrice: number | null;
  referenceAvailableCount: number;
  referenceCoveragePercent: number;
  averageAdjustmentAmount: number | null;
  averageAdjustmentPercent: number | null;
  increasedCount: number;
  unchangedCount: number;
  decreasedCount: number;
};

export type PurchaseInspectionQuality = {
  inspectedOutcomeCount: number;
  defectOutcomeCount: number;
  defectRate: PurchaseRateMetric;
  appearanceDefects: StatisticsGroup[];
  functionDefects: StatisticsGroup[];
};

export type PurchaseLeadTimeSummary = {
  receivedToLastInspection: PurchaseDurationMetric;
  lastInspectionToTerminalOutcome: PurchaseDurationMetric;
  receivedToTerminalOutcome: PurchaseDurationMetric;
};

export type PurchaseStatisticsData = {
  generatedAt: string;
  calculation: StatisticsCalculationMetadata;
  source: PurchaseStatisticsSourceCoverage;
  summary: PurchaseStatisticsSummary;
  monthlyTrend: PurchaseMonthlyTrendRow[];
  productRows: PurchaseProductPerformanceRow[];
  supplierRows: PurchaseSupplierPerformanceRow[];
  pricePolicyRows: PurchasePricePolicyRow[];
  inspectionQuality: PurchaseInspectionQuality;
  leadTimes: PurchaseLeadTimeSummary;
};

export type PurchaseStatisticsApiResponse = {
  ok: boolean;
  message?: string;
  data?: PurchaseStatisticsData;
};
export const SALES_STATISTICS_UNKNOWN = {
  sku: "__UNKNOWN_SKU__", model: "__UNKNOWN_MODEL__", storage: "__UNKNOWN_STORAGE__",
  color: "__UNKNOWN_COLOR__", grade: "__UNKNOWN_GRADE__", warranty: "__UNKNOWN_WARRANTY__",
  channel: "__UNKNOWN_CHANNEL__",
} as const;

export const SALES_STATISTICS_PRICE_BANDS = [
  "PRICE_LT_100K", "PRICE_100K_199K", "PRICE_200K_299K", "PRICE_300K_399K",
  "PRICE_400K_499K", "PRICE_500K_599K", "PRICE_600K_PLUS", "PRICE_UNKNOWN",
] as const;
