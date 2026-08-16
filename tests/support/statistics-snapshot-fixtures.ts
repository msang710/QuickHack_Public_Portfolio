import type {
  InventoryStatisticsData,
  PurchaseStatisticsData,
  ReturnStatisticsData,
  SalesAmountMetric,
  SalesGrossProfitMetric,
  SalesLeadTimeMetric,
  SalesRateMetric,
  SalesStatisticsData,
  StatisticsCalculationMetadata,
} from "@/quickhack_shared/statistics/statistics";
import {
  previousEqualStatisticsDateRange,
  statisticsDateRangeDayCount,
} from "@/quickhack_shared/statistics/statistics-period";
import type {
  StatisticsSnapshotBatchContract,
  StatisticsSnapshotDataByDomain,
  StatisticsSnapshotDomain,
} from "@/quickhack_shared/statistics/statistics-snapshot";

function calculation(
  batch: StatisticsSnapshotBatchContract
): StatisticsCalculationMetadata {
  const comparisonPeriod = previousEqualStatisticsDateRange({
    fromDate: batch.periodFrom,
    toDate: batch.periodTo,
  });

  return {
    mode: "LIVE",
    period: {
      fromDate: batch.periodFrom,
      toDate: batch.periodTo,
      dayCount: batch.dayCount,
    },
    comparisonPeriod: {
      ...comparisonPeriod,
      dayCount: statisticsDateRangeDayCount(comparisonPeriod),
    },
    dataCutoffDate: batch.dataCutoffDate,
    isDefaultPeriod: true,
  };
}

function generatedAt(marker: number) {
  return new Date(Date.UTC(2026, 6, 30, 0, 0, 0, marker)).toISOString();
}

function rateMetric(): SalesRateMetric {
  return {
    value: null,
    numerator: 0,
    denominator: 0,
    unavailableReason: "NO_SAMPLE",
  };
}

function amountMetric(): SalesAmountMetric {
  return {
    amount: null,
    pricedCount: 0,
    totalCount: 0,
    coveragePercent: 0,
  };
}

function grossProfitMetric(): SalesGrossProfitMetric {
  return {
    amount: null,
    salesAmount: null,
    purchaseCostAmount: null,
    comparableCount: 0,
    totalCount: 0,
    coveragePercent: 0,
    marginPercent: null,
  };
}

function leadTimeMetric(): SalesLeadTimeMetric {
  return {
    averageDays: null,
    sampleCount: 0,
    totalCount: 0,
    coveragePercent: 0,
    excludedAnomalyCount: 0,
    buckets: [],
  };
}

function durationMetric() {
  return {
    sampleCount: 0,
    medianHours: null,
    p90Hours: null,
    excludedAnomalyCount: 0,
  };
}

function purchaseCostMetric() {
  return {
    amount: null,
    pricedQuantity: null,
    totalQuantity: null,
    missingPriceQuantity: null,
    coveragePercent: null,
  };
}

function turnoverMetric() {
  return {
    value: null,
    soldQuantity: 0,
    averageWarehouseQuantity: null,
    unavailableReason: "NO_SAMPLE",
  };
}

function purchaseFixture(
  batch: StatisticsSnapshotBatchContract,
  marker: number
): PurchaseStatisticsData {
  return {
    generatedAt: generatedAt(marker),
    calculation: calculation(batch),
    source: {
      loadedTerminalInboundCount: marker,
      periodEligibleInboundCount: 0,
      outsidePeriodInboundCount: 0,
      terminalInboundCount: 0,
      purchaseCount: 0,
      supplierReturnCount: 0,
      pricedPurchaseCount: 0,
      missingPurchasePriceCount: 0,
      namedSupplierOutcomeCount: 0,
      missingSupplierOutcomeCount: 0,
      datedPurchaseCount: 0,
      datedSupplierReturnCount: 0,
      linkedInspectionOutcomeCount: 0,
      missingInspectionOutcomeCount: 0,
      inspectionLinkCoveragePercent: 0,
      knownPurchaseGradeOutcomeCount: 0,
      missingPurchaseGradeOutcomeCount: 0,
      pricePolicyEvidenceCount: 0,
      priceReferenceEvidenceCount: 0,
      pricePolicyCoveragePercent: 0,
      salesRecordCount: 0,
      purchaseInboundLinkedSaleCount: 0,
      missingPurchaseInboundSaleCount: 0,
      salesLinkCoveragePercent: 0,
      supplierSnapshotSaleCount: 0,
      missingSupplierSnapshotSaleCount: 0,
      supplierSnapshotCoveragePercent: 0,
      returnedSaleCount: 0,
      invalidTimestampCount: 0,
      negativeDurationCount: 0,
    },
    summary: {
      purchaseCount: 0,
      purchaseAmount: amountMetric(),
      averagePurchasePrice: null,
      supplierCount: 0,
      missingPurchasePriceCount: 0,
      supplierReturnRate: rateMetric(),
    },
    monthlyTrend: [],
    productRows: [],
    supplierRows: [],
    pricePolicyRows: [],
    inspectionQuality: {
      inspectedOutcomeCount: 0,
      defectOutcomeCount: 0,
      defectRate: rateMetric(),
      appearanceDefects: [],
      functionDefects: [],
    },
    leadTimes: {
      receivedToLastInspection: durationMetric(),
      lastInspectionToTerminalOutcome: durationMetric(),
      receivedToTerminalOutcome: durationMetric(),
    },
  };
}

function inventoryFixture(
  batch: StatisticsSnapshotBatchContract,
  marker: number
): InventoryStatisticsData {
  return {
    generatedAt: generatedAt(marker),
    calculation: calculation(batch),
    source: {
      inventoryRowCount: marker,
      classifiedInventoryRowCount: 0,
      unclassifiedInventoryRowCount: 0,
      balanceRowCount: 0,
      balanceQuantity: 0,
      movementCount: 0,
      unknownInventoryStatusCount: 0,
      unknownBalanceStatusCount: 0,
      negativeBalanceCount: 0,
      skuStatusMismatchCount: 0,
      cutoffExcludedMovementCount: 0,
      cutoffExcludedSaleRecordCount: 0,
      asOfPriceExcludedCount: 0,
      asOfReconstructionIssueCount: 0,
    },
    integrity: {
      availability: "EMPTY",
      issues: [],
    },
    asOf: {
      date: batch.dataCutoffDate,
      totalQuantity: null,
      groups: [],
    },
    aging: {
      integrity: {
        availability: "EMPTY",
        issues: [],
      },
      warehouseQuantity: null,
      resolvedCycleQuantity: 0,
      missingCycleQuantity: 0,
      longTermQuantity: null,
      longTermPurchaseCost: purchaseCostMetric(),
      buckets: [],
      skuRows: [],
    },
    period: {
      preset: "90d",
      fromDate: batch.periodFrom,
      toDate: batch.periodTo,
      dayCount: batch.dayCount,
      integrity: {
        availability: "EMPTY",
        issues: [],
      },
      source: {
        movementRowCount: 0,
        operationCount: 0,
        skuReclassificationOperationCount: 0,
        saleRecordCount: 0,
        classifiedSaleRecordCount: 0,
        unclassifiedSaleRecordCount: 0,
        returnedSaleRecordCount: 0,
        invalidSaleTimestampCount: 0,
      },
      summary: {
        newInventoryQuantity: null,
        warehouseReentryQuantity: null,
        customerReturnReentryQuantity: null,
        otherWarehouseReentryQuantity: null,
        warehouseExitQuantity: null,
        removedQuantity: null,
        salesCompletedQuantity: 0,
        averageWarehouseQuantity: null,
        turnover: turnoverMetric(),
      },
      daily: [],
      transitions: [],
      skuRows: [],
    },
  };
}

function salesFixture(
  batch: StatisticsSnapshotBatchContract,
  marker: number
): SalesStatisticsData {
  return {
    generatedAt: generatedAt(marker),
    calculation: calculation(batch),
    source: {
      loadedSaleRecordCount: marker,
      periodEligibleSaleRecordCount: 0,
      outsidePeriodSaleRecordCount: 0,
      cutoffExcludedSaleRecordCount: 0,
      eligibleSaleRecordCount: 0,
      soldSaleRecordCount: 0,
      returnedSaleRecordCount: 0,
      excludedStatusCount: 0,
      invalidSoldAtCount: 0,
      futureSoldAtCount: 0,
      pricedSaleCount: 0,
      salesPriceCoveragePercent: 0,
      purchasePricedSaleCount: 0,
      purchasePriceCoveragePercent: 0,
      comparableProfitCount: 0,
      profitCoveragePercent: 0,
      leadTimeSampleCount: 0,
      missingPurchaseAgreedAtCount: 0,
      invalidLeadTimeCount: 0,
    },
    summary: {
      saleCount: 0,
      salesAmount: amountMetric(),
      averageSalesPrice: null,
      purchaseCost: amountMetric(),
      grossProfit: grossProfitMetric(),
      leadTime: leadTimeMetric(),
    },
    monthlyTrend: [],
    productRows: [],
    dimensionRows: [],
    priceGradeColumns: [],
    priceGradeRows: [],
    channelRows: [],
  };
}

function returnFixture(
  batch: StatisticsSnapshotBatchContract,
  marker: number
): ReturnStatisticsData {
  return {
    generatedAt: generatedAt(marker),
    calculation: calculation(batch),
    source: {
      eventRecordingStartedAt: null,
      lastClaimEventAt: null,
      claimEventCount: marker,
      observedReturnReceiptCount: 0,
      observedCancellationReceiptCount: 0,
      observedExchangeCount: 0,
      confirmedAllocationLinkCount: 0,
      uniqueExternalKeyLinkCount: 0,
      linkedSaleRecordCount: 0,
      unlinkedReceiptCount: 0,
      ambiguousReceiptCount: 0,
      cohortSalesCount: 0,
      salesPriceAvailableCount: 0,
      salesPriceCoveragePercent: 0,
      purchasePriceAvailableCount: 0,
      purchasePriceCoveragePercent: 0,
      confirmedInspectionPgCount: 0,
      unmatchedWithdrawalCount: 0,
      missingOrInvalidExternalTimestampCount: 0,
      claimBeforeSaleCount: 0,
      claimAfterThirtyDaysCount: 0,
      negativeDurationCount: 0,
    },
    summary: {
      requestRate30Day: rateMetric(),
      previousRequestRate30Day: rateMetric(),
      previousCohortDeltaPercentagePoints: null,
      associatedSalesAmount: amountMetric(),
      vendorFaultShare: rateMetric(),
      resaleRecoveryRate: rateMetric(),
    },
    overview: {
      receiptCount: 0,
      returnQuantity: 0,
      linkedReceiptCount: 0,
      linkedSaleRecordCount: 0,
      completedReceiptCount: 0,
      withdrawnReceiptCount: 0,
      receiptLinkRate: rateMetric(),
      withdrawalShare: rateMetric(),
    },
    cohortTrend: [],
    occurrenceTrend: [],
    productRows: [],
    reasons: [],
    faults: [],
    reasonInspectionMatrix: [],
    inspectionOutcome: {
      linkedReturnPgCount: 0,
      confirmedInspectionPgCount: 0,
      recoveredCount: 0,
      nonSellableCount: 0,
      holdCount: 0,
      recoveryRate: rateMetric(),
    },
    economicImpact: {
      associatedSalesAmount: amountMetric(),
      associatedPurchaseCost: amountMetric(),
      recoveredAssetCost: amountMetric(),
      nonSellableOrHoldAssetCost: amountMetric(),
    },
    leadTimes: {
      externalReceiptToObservation: durationMetric(),
      observationToApprovalRequest: durationMetric(),
      observationToLocalFinalization: durationMetric(),
    },
    preShipmentCancellations: {
      receiptCount: 0,
      cancellationQuantity: 0,
      occurrenceTrend: [],
      reasons: [],
      products: [],
    },
    exchanges: {
      receiptCount: 0,
      occurrenceTrend: [],
      reasons: [],
      faults: [],
      results: [],
      terminalLeadTime: durationMetric(),
    },
  };
}

export function createStatisticsSnapshotFixture<
  Domain extends StatisticsSnapshotDomain,
>(
  domain: Domain,
  batch: StatisticsSnapshotBatchContract,
  marker = 0
): StatisticsSnapshotDataByDomain[Domain] {
  const dataByDomain = {
    PURCHASE: purchaseFixture(batch, marker),
    INVENTORY: inventoryFixture(batch, marker),
    SALES: salesFixture(batch, marker),
    RETURNS: returnFixture(batch, marker),
  } satisfies StatisticsSnapshotDataByDomain;

  return dataByDomain[domain];
}

export function statisticsSnapshotFixtureMarker<
  Domain extends StatisticsSnapshotDomain,
>(
  domain: Domain,
  data: StatisticsSnapshotDataByDomain[Domain]
) {
  switch (domain) {
    case "PURCHASE":
      return (data as PurchaseStatisticsData).source
        .loadedTerminalInboundCount;
    case "INVENTORY":
      return (data as InventoryStatisticsData).source.inventoryRowCount;
    case "SALES":
      return (data as SalesStatisticsData).source.loadedSaleRecordCount;
    case "RETURNS":
      return (data as ReturnStatisticsData).source.claimEventCount;
  }
}
