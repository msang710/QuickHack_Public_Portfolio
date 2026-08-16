import type {
  ExchangeStatistics,
  PreShipmentCancellationStatistics,
  PreShipmentCancellationTrendRow,
  ReturnCohortTrendRow,
  ReturnCustomerOverview,
  ReturnEconomicImpact,
  ReturnInspectionOutcome,
  ReturnLeadTimeSummary,
  ReturnOccurrenceTrendRow,
  ReturnProductComparisonRow,
  ReturnReasonInspectionRow,
  ReturnStatisticsData,
  ReturnStatisticsSourceCoverage,
  ReturnStatisticsSummary,
} from "@/quickhack_shared/statistics/statistics";
import {
  amountMetricSchema,
  durationMetricSchema,
  nullableNumberSchema,
  nullableStringSchema,
  rateMetricSchema,
  statisticsCalculationMetadataSchema,
  statisticsGroupSchema,
  statisticsPointSchema,
} from "@/quickhack_shared/statistics/statistics-snapshot-payload-schema-common";
import {
  arraySchema,
  finiteNumberSchema,
  objectSchema,
  stringSchema,
} from "@/quickhack_shared/statistics/statistics-runtime-schema";

const sourceCoverageSchema =
  objectSchema<ReturnStatisticsSourceCoverage>({
    eventRecordingStartedAt: nullableStringSchema,
    lastClaimEventAt: nullableStringSchema,
    claimEventCount: finiteNumberSchema,
    observedReturnReceiptCount: finiteNumberSchema,
    observedCancellationReceiptCount: finiteNumberSchema,
    observedExchangeCount: finiteNumberSchema,
    confirmedAllocationLinkCount: finiteNumberSchema,
    uniqueExternalKeyLinkCount: finiteNumberSchema,
    linkedSaleRecordCount: finiteNumberSchema,
    unlinkedReceiptCount: finiteNumberSchema,
    ambiguousReceiptCount: finiteNumberSchema,
    cohortSalesCount: finiteNumberSchema,
    salesPriceAvailableCount: finiteNumberSchema,
    salesPriceCoveragePercent: finiteNumberSchema,
    purchasePriceAvailableCount: finiteNumberSchema,
    purchasePriceCoveragePercent: finiteNumberSchema,
    confirmedInspectionPgCount: finiteNumberSchema,
    unmatchedWithdrawalCount: finiteNumberSchema,
    missingOrInvalidExternalTimestampCount: finiteNumberSchema,
    claimBeforeSaleCount: finiteNumberSchema,
    claimAfterThirtyDaysCount: finiteNumberSchema,
    negativeDurationCount: finiteNumberSchema,
  });

const summarySchema = objectSchema<ReturnStatisticsSummary>({
  requestRate30Day: rateMetricSchema,
  previousRequestRate30Day: rateMetricSchema,
  previousCohortDeltaPercentagePoints: nullableNumberSchema,
  associatedSalesAmount: amountMetricSchema,
  vendorFaultShare: rateMetricSchema,
  resaleRecoveryRate: rateMetricSchema,
});

const customerOverviewSchema = objectSchema<ReturnCustomerOverview>({
  receiptCount: finiteNumberSchema,
  returnQuantity: finiteNumberSchema,
  linkedReceiptCount: finiteNumberSchema,
  linkedSaleRecordCount: finiteNumberSchema,
  completedReceiptCount: finiteNumberSchema,
  withdrawnReceiptCount: finiteNumberSchema,
  receiptLinkRate: rateMetricSchema,
  withdrawalShare: rateMetricSchema,
});

const cohortTrendRowSchema = objectSchema<ReturnCohortTrendRow>({
  saleMonth: stringSchema,
  saleCount: finiteNumberSchema,
  day7: rateMetricSchema,
  day14: rateMetricSchema,
  day30: rateMetricSchema,
});

const occurrenceTrendRowSchema =
  objectSchema<ReturnOccurrenceTrendRow>({
    receiptMonth: stringSchema,
    receiptCount: finiteNumberSchema,
    returnQuantity: finiteNumberSchema,
    linkedSaleRecordCount: finiteNumberSchema,
    completedReceiptCount: finiteNumberSchema,
    withdrawnReceiptCount: finiteNumberSchema,
    associatedSalesAmount: amountMetricSchema,
  });

const productComparisonRowSchema =
  objectSchema<ReturnProductComparisonRow>({
    key: stringSchema,
    model: stringSchema,
    storage: stringSchema,
    saleGrade: stringSchema,
    matureSalesCount: finiteNumberSchema,
    returnSaleRecordCount: finiteNumberSchema,
    requestRate30Day: rateMetricSchema,
    previousCohortDeltaPercentagePoints: nullableNumberSchema,
    associatedSalesAmount: amountMetricSchema,
    vendorFaultShare: rateMetricSchema,
    resaleRecoveryRate: rateMetricSchema,
  });

const reasonInspectionRowSchema =
  objectSchema<ReturnReasonInspectionRow>({
    reason: stringSchema,
    receiptCount: finiteNumberSchema,
    confirmedInspectionPgCount: finiteNumberSchema,
    recoveredCount: finiteNumberSchema,
    nonSellableCount: finiteNumberSchema,
    holdCount: finiteNumberSchema,
    appearanceDefects: arraySchema(statisticsGroupSchema),
    functionDefects: arraySchema(statisticsGroupSchema),
  });

const inspectionOutcomeSchema = objectSchema<ReturnInspectionOutcome>({
  linkedReturnPgCount: finiteNumberSchema,
  confirmedInspectionPgCount: finiteNumberSchema,
  recoveredCount: finiteNumberSchema,
  nonSellableCount: finiteNumberSchema,
  holdCount: finiteNumberSchema,
  recoveryRate: rateMetricSchema,
});

const economicImpactSchema = objectSchema<ReturnEconomicImpact>({
  associatedSalesAmount: amountMetricSchema,
  associatedPurchaseCost: amountMetricSchema,
  recoveredAssetCost: amountMetricSchema,
  nonSellableOrHoldAssetCost: amountMetricSchema,
});

const leadTimeSummarySchema = objectSchema<ReturnLeadTimeSummary>({
  externalReceiptToObservation: durationMetricSchema,
  observationToApprovalRequest: durationMetricSchema,
  observationToLocalFinalization: durationMetricSchema,
});

const preShipmentCancellationTrendRowSchema =
  objectSchema<PreShipmentCancellationTrendRow>({
    receiptMonth: stringSchema,
    receiptCount: finiteNumberSchema,
    cancellationQuantity: finiteNumberSchema,
  });

const preShipmentCancellationSchema =
  objectSchema<PreShipmentCancellationStatistics>({
    receiptCount: finiteNumberSchema,
    cancellationQuantity: finiteNumberSchema,
    occurrenceTrend: arraySchema(
      preShipmentCancellationTrendRowSchema
    ),
    reasons: arraySchema(statisticsGroupSchema),
    products: arraySchema(statisticsGroupSchema),
  });

const exchangeStatisticsSchema = objectSchema<ExchangeStatistics>({
  receiptCount: finiteNumberSchema,
  occurrenceTrend: arraySchema(statisticsPointSchema),
  reasons: arraySchema(statisticsGroupSchema),
  faults: arraySchema(statisticsGroupSchema),
  results: arraySchema(statisticsGroupSchema),
  terminalLeadTime: durationMetricSchema,
});

export const returnStatisticsDataSchema =
  objectSchema<ReturnStatisticsData>({
    generatedAt: stringSchema,
    calculation: statisticsCalculationMetadataSchema,
    source: sourceCoverageSchema,
    summary: summarySchema,
    overview: customerOverviewSchema,
    cohortTrend: arraySchema(cohortTrendRowSchema),
    occurrenceTrend: arraySchema(occurrenceTrendRowSchema),
    productRows: arraySchema(productComparisonRowSchema),
    reasons: arraySchema(statisticsGroupSchema),
    faults: arraySchema(statisticsGroupSchema),
    reasonInspectionMatrix: arraySchema(reasonInspectionRowSchema),
    inspectionOutcome: inspectionOutcomeSchema,
    economicImpact: economicImpactSchema,
    leadTimes: leadTimeSummarySchema,
    preShipmentCancellations: preShipmentCancellationSchema,
    exchanges: exchangeStatisticsSchema,
  });
