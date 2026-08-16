import type {
  PurchaseInspectionQuality,
  PurchaseLeadTimeSummary,
  PurchaseMonthlyTrendRow,
  PurchasePricePolicyRow,
  PurchaseProductPerformanceRow,
  PurchaseStatisticsData,
  PurchaseStatisticsSourceCoverage,
  PurchaseStatisticsSummary,
  PurchaseSupplierPerformanceRow,
} from "@/quickhack_shared/statistics/statistics";
import {
  amountMetricSchema,
  durationMetricSchema,
  nullableNumberSchema,
  rateMetricSchema,
  statisticsCalculationMetadataSchema,
  statisticsGroupSchema,
} from "@/quickhack_shared/statistics/statistics-snapshot-payload-schema-common";
import {
  arraySchema,
  finiteNumberSchema,
  objectSchema,
  oneOfSchema,
  stringSchema,
} from "@/quickhack_shared/statistics/statistics-runtime-schema";

const sourceCoverageSchema =
  objectSchema<PurchaseStatisticsSourceCoverage>({
    loadedTerminalInboundCount: finiteNumberSchema,
    periodEligibleInboundCount: finiteNumberSchema,
    outsidePeriodInboundCount: finiteNumberSchema,
    terminalInboundCount: finiteNumberSchema,
    purchaseCount: finiteNumberSchema,
    supplierReturnCount: finiteNumberSchema,
    pricedPurchaseCount: finiteNumberSchema,
    missingPurchasePriceCount: finiteNumberSchema,
    namedSupplierOutcomeCount: finiteNumberSchema,
    missingSupplierOutcomeCount: finiteNumberSchema,
    datedPurchaseCount: finiteNumberSchema,
    datedSupplierReturnCount: finiteNumberSchema,
    linkedInspectionOutcomeCount: finiteNumberSchema,
    missingInspectionOutcomeCount: finiteNumberSchema,
    inspectionLinkCoveragePercent: finiteNumberSchema,
    knownPurchaseGradeOutcomeCount: finiteNumberSchema,
    missingPurchaseGradeOutcomeCount: finiteNumberSchema,
    pricePolicyEvidenceCount: finiteNumberSchema,
    priceReferenceEvidenceCount: finiteNumberSchema,
    pricePolicyCoveragePercent: finiteNumberSchema,
    salesRecordCount: finiteNumberSchema,
    purchaseInboundLinkedSaleCount: finiteNumberSchema,
    missingPurchaseInboundSaleCount: finiteNumberSchema,
    salesLinkCoveragePercent: finiteNumberSchema,
    supplierSnapshotSaleCount: finiteNumberSchema,
    missingSupplierSnapshotSaleCount: finiteNumberSchema,
    supplierSnapshotCoveragePercent: finiteNumberSchema,
    returnedSaleCount: finiteNumberSchema,
    invalidTimestampCount: finiteNumberSchema,
    negativeDurationCount: finiteNumberSchema,
  });

const summarySchema = objectSchema<PurchaseStatisticsSummary>({
  purchaseCount: finiteNumberSchema,
  purchaseAmount: amountMetricSchema,
  averagePurchasePrice: nullableNumberSchema,
  supplierCount: finiteNumberSchema,
  missingPurchasePriceCount: finiteNumberSchema,
  supplierReturnRate: rateMetricSchema,
});

const monthlyTrendRowSchema = objectSchema<PurchaseMonthlyTrendRow>({
  month: stringSchema,
  purchaseCount: finiteNumberSchema,
  purchaseAmount: nullableNumberSchema,
  pricedPurchaseCount: finiteNumberSchema,
  missingPurchasePriceCount: finiteNumberSchema,
  supplierReturnCount: finiteNumberSchema,
  inspectionDefectOutcomeCount: finiteNumberSchema,
});

const productPerformanceRowSchema =
  objectSchema<PurchaseProductPerformanceRow>({
    key: stringSchema,
    model: stringSchema,
    storage: stringSchema,
    purchaseGrade: stringSchema,
    terminalOutcomeCount: finiteNumberSchema,
    purchaseCount: finiteNumberSchema,
    purchaseAmount: amountMetricSchema,
    averagePurchasePrice: nullableNumberSchema,
    supplierReturnRate: rateMetricSchema,
    inspectionDefectRate: rateMetricSchema,
    saleConversion30Day: rateMetricSchema,
    saleConversion60Day: rateMetricSchema,
    saleConversion90Day: rateMetricSchema,
  });

const supplierPerformanceRowSchema =
  objectSchema<PurchaseSupplierPerformanceRow>({
    supplierName: stringSchema,
    terminalOutcomeCount: finiteNumberSchema,
    purchaseCount: finiteNumberSchema,
    purchaseAmount: amountMetricSchema,
    averagePurchasePrice: nullableNumberSchema,
    supplierReturnRate: rateMetricSchema,
    inspectionDefectRate: rateMetricSchema,
    customerReturnConfirmationRate: rateMetricSchema,
  });

const pricePolicyRowSchema = objectSchema<PurchasePricePolicyRow>({
  entryMode: oneOfSchema("RATE", "OVERRIDE", "MANUAL", "UNKNOWN"),
  purchaseCount: finiteNumberSchema,
  purchaseAmount: amountMetricSchema,
  averagePurchasePrice: nullableNumberSchema,
  referenceAvailableCount: finiteNumberSchema,
  referenceCoveragePercent: finiteNumberSchema,
  averageAdjustmentAmount: nullableNumberSchema,
  averageAdjustmentPercent: nullableNumberSchema,
  increasedCount: finiteNumberSchema,
  unchangedCount: finiteNumberSchema,
  decreasedCount: finiteNumberSchema,
});

const inspectionQualitySchema = objectSchema<PurchaseInspectionQuality>({
  inspectedOutcomeCount: finiteNumberSchema,
  defectOutcomeCount: finiteNumberSchema,
  defectRate: rateMetricSchema,
  appearanceDefects: arraySchema(statisticsGroupSchema),
  functionDefects: arraySchema(statisticsGroupSchema),
});

const leadTimeSummarySchema = objectSchema<PurchaseLeadTimeSummary>({
  receivedToLastInspection: durationMetricSchema,
  lastInspectionToTerminalOutcome: durationMetricSchema,
  receivedToTerminalOutcome: durationMetricSchema,
});

export const purchaseStatisticsDataSchema =
  objectSchema<PurchaseStatisticsData>({
    generatedAt: stringSchema,
    calculation: statisticsCalculationMetadataSchema,
    source: sourceCoverageSchema,
    summary: summarySchema,
    monthlyTrend: arraySchema(monthlyTrendRowSchema),
    productRows: arraySchema(productPerformanceRowSchema),
    supplierRows: arraySchema(supplierPerformanceRowSchema),
    pricePolicyRows: arraySchema(pricePolicyRowSchema),
    inspectionQuality: inspectionQualitySchema,
    leadTimes: leadTimeSummarySchema,
  });
