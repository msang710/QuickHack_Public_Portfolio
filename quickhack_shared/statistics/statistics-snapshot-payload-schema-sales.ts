import type {
  SalesChannelPerformanceRow,
  SalesDimensionPerformanceRow,
  SalesGrossProfitMetric,
  SalesLeadTimeBucket,
  SalesLeadTimeMetric,
  SalesMonthlyTrendRow,
  SalesPriceGradeRow,
  SalesProductPerformanceRow,
  SalesStatisticsData,
  SalesStatisticsSourceCoverage,
} from "@/quickhack_shared/statistics/statistics";
import {
  amountMetricSchema,
  nullableNumberSchema,
  rateMetricSchema,
  statisticsCalculationMetadataSchema,
} from "@/quickhack_shared/statistics/statistics-snapshot-payload-schema-common";
import {
  arraySchema,
  finiteNumberSchema,
  objectSchema,
  oneOfSchema,
  recordSchema,
  stringSchema,
} from "@/quickhack_shared/statistics/statistics-runtime-schema";

const grossProfitMetricSchema = objectSchema<SalesGrossProfitMetric>({
  amount: nullableNumberSchema,
  salesAmount: nullableNumberSchema,
  purchaseCostAmount: nullableNumberSchema,
  comparableCount: finiteNumberSchema,
  totalCount: finiteNumberSchema,
  coveragePercent: finiteNumberSchema,
  marginPercent: nullableNumberSchema,
});

const leadTimeBucketSchema = objectSchema<SalesLeadTimeBucket>({
  key: oneOfSchema(
    "DAYS_0_29",
    "DAYS_30_59",
    "DAYS_60_89",
    "DAYS_90_PLUS"
  ),
  label: stringSchema,
  count: finiteNumberSchema,
});

const leadTimeMetricSchema = objectSchema<SalesLeadTimeMetric>({
  averageDays: nullableNumberSchema,
  sampleCount: finiteNumberSchema,
  totalCount: finiteNumberSchema,
  coveragePercent: finiteNumberSchema,
  excludedAnomalyCount: finiteNumberSchema,
  buckets: arraySchema(leadTimeBucketSchema),
});

const sourceCoverageSchema = objectSchema<SalesStatisticsSourceCoverage>({
  loadedSaleRecordCount: finiteNumberSchema,
  periodEligibleSaleRecordCount: finiteNumberSchema,
  outsidePeriodSaleRecordCount: finiteNumberSchema,
  cutoffExcludedSaleRecordCount: finiteNumberSchema,
  eligibleSaleRecordCount: finiteNumberSchema,
  soldSaleRecordCount: finiteNumberSchema,
  returnedSaleRecordCount: finiteNumberSchema,
  excludedStatusCount: finiteNumberSchema,
  invalidSoldAtCount: finiteNumberSchema,
  futureSoldAtCount: finiteNumberSchema,
  pricedSaleCount: finiteNumberSchema,
  salesPriceCoveragePercent: finiteNumberSchema,
  purchasePricedSaleCount: finiteNumberSchema,
  purchasePriceCoveragePercent: finiteNumberSchema,
  comparableProfitCount: finiteNumberSchema,
  profitCoveragePercent: finiteNumberSchema,
  leadTimeSampleCount: finiteNumberSchema,
  missingPurchaseAgreedAtCount: finiteNumberSchema,
  invalidLeadTimeCount: finiteNumberSchema,
});

const monthlyTrendRowSchema = objectSchema<SalesMonthlyTrendRow>({
  month: stringSchema,
  saleCount: finiteNumberSchema,
  salesAmount: amountMetricSchema,
  averageSalesPrice: nullableNumberSchema,
  grossProfit: grossProfitMetricSchema,
});

const productPerformanceRowSchema =
  objectSchema<SalesProductPerformanceRow>({
    key: stringSchema,
    skuCode: stringSchema,
    model: stringSchema,
    storage: stringSchema,
    color: stringSchema,
    saleGrade: stringSchema,
    warrantyGroup: stringSchema,
    saleCount: finiteNumberSchema,
    saleShare: rateMetricSchema,
    salesAmount: amountMetricSchema,
    averageSalesPrice: nullableNumberSchema,
    grossProfit: grossProfitMetricSchema,
    leadTime: leadTimeMetricSchema,
    longTermSaleCount: finiteNumberSchema,
  });

const dimensionPerformanceRowSchema =
  objectSchema<SalesDimensionPerformanceRow>({
    dimension: oneOfSchema(
      "MODEL",
      "STORAGE",
      "COLOR",
      "SALE_GRADE",
      "WARRANTY_GROUP",
      "CHANNEL"
    ),
    label: stringSchema,
    saleCount: finiteNumberSchema,
    saleShare: rateMetricSchema,
    salesAmount: amountMetricSchema,
    averageSalesPrice: nullableNumberSchema,
    grossProfit: grossProfitMetricSchema,
  });

const priceGradeRowSchema = objectSchema<SalesPriceGradeRow>({
  priceBand: stringSchema,
  totalCount: finiteNumberSchema,
  gradeCounts: recordSchema(finiteNumberSchema),
});

const channelPerformanceRowSchema =
  objectSchema<SalesChannelPerformanceRow>({
    channel: stringSchema,
    saleCount: finiteNumberSchema,
    saleShare: rateMetricSchema,
    salesAmount: amountMetricSchema,
    averageSalesPrice: nullableNumberSchema,
    grossProfit: grossProfitMetricSchema,
    leadTime: leadTimeMetricSchema,
  });

export const salesStatisticsDataSchema =
  objectSchema<SalesStatisticsData>({
    generatedAt: stringSchema,
    calculation: statisticsCalculationMetadataSchema,
    source: sourceCoverageSchema,
    summary: objectSchema<SalesStatisticsData["summary"]>({
      saleCount: finiteNumberSchema,
      salesAmount: amountMetricSchema,
      averageSalesPrice: nullableNumberSchema,
      purchaseCost: amountMetricSchema,
      grossProfit: grossProfitMetricSchema,
      leadTime: leadTimeMetricSchema,
    }),
    monthlyTrend: arraySchema(monthlyTrendRowSchema),
    productRows: arraySchema(productPerformanceRowSchema),
    dimensionRows: arraySchema(dimensionPerformanceRowSchema),
    priceGradeColumns: arraySchema(stringSchema),
    priceGradeRows: arraySchema(priceGradeRowSchema),
    channelRows: arraySchema(channelPerformanceRowSchema),
  });
