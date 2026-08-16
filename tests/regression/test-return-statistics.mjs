import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  aggregateReturnStatistics,
  createReturnStatisticsAsOfContext,
} from "../../quickhack_server/statistics/return-statistics-service.ts";
import { resolveClosedStatisticsPeriod } from "../../quickhack_shared/statistics/statistics-period.ts";

const NOW = new Date("2026-07-27T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORICAL_LINK_CREATED_AT = "2026-04-01T00:00:00.000Z";
let nextEventId = 1;

function dateFromNow(days, hours = 0) {
  return new Date(
    NOW.getTime() + days * DAY_MS + hours * 60 * 60 * 1000
  ).toISOString();
}

function sale({
  id,
  daysAgo,
  orderId,
  shipmentId,
  vendorItemId,
  pgNo = `PG-${id}`,
  model = "Galaxy S24",
  storage = "256GB",
  saleGrade = "A",
  salesPrice = 1_000,
  purchasePrice = 700,
  soldAt,
}) {
  return {
    saleRecordId: id,
    allocationId: id,
    pgNo,
    channel: "COUPANG",
    externalOrderId: orderId,
    externalShipmentId: shipmentId,
    externalVendorItemId: vendorItemId,
    soldAt: soldAt ?? dateFromNow(-daysAgo),
    saleStatus: "SOLD",
    salesPrice,
    purchasePrice,
    model,
    storage,
    saleGrade,
    productNames: [`${model} ${storage}`],
  };
}

function fields(values) {
  return Object.entries(values).map(([fieldName, afterValue]) => ({
    fieldName,
    afterValue: afterValue == null ? null : String(afterValue),
  }));
}

function returnEvent({
  receiptId,
  orderId,
  shipmentId,
  eventType = "COUPANG_RETURN_OBSERVED",
  detectedAt,
  createdAt,
  receiptType = "RETURN",
  receiptStatus = "RETURNS_UNCHECKED",
  faultType = "CUSTOMER",
  reasonLabel = "단순 변심",
  cancelCount = 1,
  completedAt = null,
  items = [],
}) {
  return {
    eventId: nextEventId++,
    sourcePk: receiptId,
    externalOrderId: orderId,
    externalShipmentId: shipmentId,
    externalReceiptId: receiptId,
    externalExchangeId: null,
    eventType,
    detectedAt,
    fields: fields({
      external_created_at: createdAt,
      external_modified_at: createdAt,
      external_completed_at: completedAt,
      external_completion_type: null,
      receipt_type: receiptType,
      receipt_status: receiptStatus,
      release_status: null,
      fault_by_type: faultType,
      reason_code: reasonLabel,
      reason_label: reasonLabel,
      reason_category: reasonLabel,
      reason_detail: reasonLabel,
      cancel_count: cancelCount,
      items_json: JSON.stringify(items),
    }),
  };
}

function semanticResultHash(result) {
  const semanticResult = { ...result };
  delete semanticResult.generatedAt;
  return createHash("sha256")
    .update(JSON.stringify(semanticResult))
    .digest("hex");
}

function withdrawalEvent({
  receiptId,
  orderId,
  detectedAt,
  vendorItemIds = [],
}) {
  return {
    eventId: nextEventId++,
    sourcePk: receiptId,
    externalOrderId: orderId,
    externalShipmentId: null,
    externalReceiptId: receiptId,
    externalExchangeId: null,
    eventType: "COUPANG_RETURN_WITHDRAWN",
    detectedAt,
    fields: fields({
      external_withdrawn_at: detectedAt,
      refund_delivery_duty: "CUSTOMER",
      vendor_item_ids: JSON.stringify(vendorItemIds),
    }),
  };
}

function exchangeEvent({
  exchangeId,
  eventType,
  status,
  createdAt,
  modifiedAt,
  detectedAt,
}) {
  return {
    eventId: nextEventId++,
    sourcePk: exchangeId,
    externalOrderId: `ORDER-${exchangeId}`,
    externalShipmentId: `SHIP-${exchangeId}`,
    externalReceiptId: null,
    externalExchangeId: exchangeId,
    eventType,
    detectedAt,
    fields: fields({
      external_created_at: createdAt,
      external_modified_at: modifiedAt,
      exchange_status: status,
      fault_by_type: "VENDOR",
      reason_code: "불량",
      reason_label: "상품 불량",
      reason_detail: "전원이 켜지지 않음",
    }),
  };
}

function raw({
  id,
  receiptId,
  orderId,
  shipmentId,
  receiptType = "RETURN",
  vendorItemId,
  productName,
  cancelCount = 1,
  withItems = true,
}) {
  return {
    returnRawId: id,
    externalReceiptId: receiptId,
    externalOrderId: orderId,
    externalShipmentId: shipmentId,
    cancelType: receiptType,
    cancelCount,
    items: withItems
      ? [
          {
            externalVendorItemId: vendorItemId,
            sellerProductItemId: null,
            vendorItemName: productName ?? vendorItemId,
            cancelCount,
          },
        ]
      : [],
  };
}

const sales = [
  sale({
    id: 1,
    daysAgo: 30,
    orderId: "ORDER-1",
    shipmentId: "SHIP-1",
    vendorItemId: "ITEM-1",
  }),
  sale({
    id: 2,
    daysAgo: 45,
    orderId: "ORDER-2",
    shipmentId: "SHIP-2",
    vendorItemId: "ITEM-2",
    salesPrice: null,
  }),
  sale({
    id: 3,
    daysAgo: 75,
    orderId: "ORDER-3",
    shipmentId: "SHIP-3",
    vendorItemId: "ITEM-3",
    salesPrice: 900,
  }),
  sale({
    id: 4,
    daysAgo: 29,
    orderId: "ORDER-4",
    shipmentId: "SHIP-4",
    vendorItemId: "ITEM-4",
  }),
  sale({
    id: 5,
    daysAgo: 40,
    orderId: "ORDER-AUTO",
    shipmentId: "SHIP-AUTO",
    vendorItemId: "ITEM-AUTO",
    model: "Auto Model",
    salesPrice: 1_500,
  }),
  sale({
    id: 6,
    daysAgo: 35,
    orderId: "ORDER-AMB",
    shipmentId: "SHIP-AMB",
    vendorItemId: "ITEM-AMB",
  }),
  sale({
    id: 7,
    daysAgo: 35,
    orderId: "ORDER-AMB",
    shipmentId: "SHIP-AMB",
    vendorItemId: "ITEM-AMB",
  }),
  sale({
    id: 8,
    daysAgo: 70,
    orderId: "ORDER-REUSE",
    shipmentId: "SHIP-REUSE-1",
    vendorItemId: "ITEM-REUSE",
    pgNo: "PG-REUSED",
  }),
  sale({
    id: 9,
    daysAgo: 20,
    orderId: "ORDER-REUSE-2",
    shipmentId: "SHIP-REUSE-2",
    vendorItemId: "ITEM-REUSE",
    pgNo: "PG-REUSED",
  }),
];

const events = [
  returnEvent({
    receiptId: "R-1",
    orderId: "ORDER-1",
    shipmentId: "SHIP-1",
    detectedAt: dateFromNow(-24, 1),
    createdAt: dateFromNow(-25),
  }),
  withdrawalEvent({
    receiptId: "R-1",
    orderId: "ORDER-1",
    detectedAt: dateFromNow(-23),
  }),
  withdrawalEvent({
    receiptId: "W-AUTO",
    orderId: "ORDER-AUTO",
    detectedAt: dateFromNow(-4),
    vendorItemIds: ["ITEM-AUTO"],
  }),
  withdrawalEvent({
    receiptId: "W-NO",
    orderId: "ORDER-WITHDRAWAL-NO-MATCH",
    detectedAt: dateFromNow(-3),
    vendorItemIds: ["ITEM-NO-MATCH"],
  }),
  returnEvent({
    receiptId: "R-2",
    orderId: "ORDER-2",
    shipmentId: "SHIP-2",
    detectedAt: dateFromNow(-34, 1),
    createdAt: dateFromNow(-35),
    faultType: "VENDOR",
    reasonLabel: "상품 불량",
  }),
  returnEvent({
    receiptId: "R-2",
    orderId: "ORDER-2",
    shipmentId: "SHIP-2",
    eventType: "COUPANG_RETURN_CHANGED",
    detectedAt: dateFromNow(-33),
    createdAt: dateFromNow(-35),
    receiptStatus: "RETURNS_COMPLETED",
    faultType: "VENDOR",
    reasonLabel: "전원 불량",
    completedAt: dateFromNow(-33),
  }),
  returnEvent({
    receiptId: "R-2B",
    orderId: "ORDER-2",
    shipmentId: "SHIP-2",
    detectedAt: dateFromNow(-32),
    createdAt: dateFromNow(-34),
  }),
  returnEvent({
    receiptId: "R-AUTO",
    orderId: "ORDER-AUTO",
    shipmentId: "SHIP-AUTO",
    detectedAt: dateFromNow(-29),
    createdAt: dateFromNow(-30),
    items: [
      {
        externalVendorItemId: "ITEM-AUTO",
        sellerProductItemId: null,
        vendorItemName: "Auto Model 256GB",
        cancelCount: 1,
      },
    ],
  }),
  returnEvent({
    receiptId: "R-AMB",
    orderId: "ORDER-AMB",
    shipmentId: "SHIP-AMB",
    detectedAt: dateFromNow(-29),
    createdAt: dateFromNow(-30),
    items: [
      {
        externalVendorItemId: "ITEM-AMB",
        sellerProductItemId: null,
        vendorItemName: "ITEM-AMB",
        cancelCount: 1,
      },
    ],
  }),
  returnEvent({
    receiptId: "R-NO",
    orderId: "ORDER-NO",
    shipmentId: "SHIP-NO",
    detectedAt: dateFromNow(-10),
    createdAt: dateFromNow(-11),
    faultType: "UNKNOWN:NEW_FAULT",
  }),
  returnEvent({
    receiptId: "R-AFTER-30",
    orderId: "ORDER-2",
    shipmentId: "SHIP-2",
    detectedAt: dateFromNow(-13),
    createdAt: dateFromNow(-14),
  }),
  returnEvent({
    receiptId: "R-BEFORE",
    orderId: "ORDER-3",
    shipmentId: "SHIP-3",
    detectedAt: dateFromNow(-78),
    createdAt: dateFromNow(-80),
  }),
  returnEvent({
    receiptId: "C-1",
    orderId: "ORDER-C",
    shipmentId: "SHIP-C",
    detectedAt: dateFromNow(-5),
    createdAt: dateFromNow(-6),
    receiptType: "CANCEL",
    reasonLabel: "배송 전 취소",
    cancelCount: 2,
    items: [
      {
        externalVendorItemId: "ITEM-C",
        sellerProductItemId: null,
        vendorItemName: "취소 상품",
        cancelCount: 2,
      },
    ],
  }),
  exchangeEvent({
    exchangeId: "E-1",
    eventType: "COUPANG_EXCHANGE_OBSERVED",
    status: "RECEIPT",
    createdAt: dateFromNow(-8),
    modifiedAt: dateFromNow(-8),
    detectedAt: dateFromNow(-7, 1),
  }),
  exchangeEvent({
    exchangeId: "E-1",
    eventType: "COUPANG_EXCHANGE_CHANGED",
    status: "SUCCESS",
    createdAt: dateFromNow(-8),
    modifiedAt: dateFromNow(-6),
    detectedAt: dateFromNow(-6),
  }),
];

const input = {
  sales,
  events,
  allocationLinks: [
    {
      returnAllocationId: 1,
      returnRawId: 1,
      allocationId: 1,
      externalReceiptId: "R-1",
      pgNo: "PG-1",
      actionType: "approve",
      createdAt: HISTORICAL_LINK_CREATED_AT,
    },
    {
      returnAllocationId: 2,
      returnRawId: 2,
      allocationId: 2,
      externalReceiptId: "R-2",
      pgNo: "PG-2",
      actionType: "approve",
      createdAt: HISTORICAL_LINK_CREATED_AT,
    },
    {
      returnAllocationId: 3,
      returnRawId: 3,
      allocationId: 2,
      externalReceiptId: "R-2B",
      pgNo: "PG-2",
      actionType: "approve",
      createdAt: HISTORICAL_LINK_CREATED_AT,
    },
    {
      returnAllocationId: 4,
      returnRawId: 7,
      allocationId: 2,
      externalReceiptId: "R-AFTER-30",
      pgNo: "PG-2",
      actionType: "approve",
      createdAt: HISTORICAL_LINK_CREATED_AT,
    },
    {
      returnAllocationId: 5,
      returnRawId: 8,
      allocationId: 3,
      externalReceiptId: "R-BEFORE",
      pgNo: "PG-3",
      actionType: "approve",
      createdAt: HISTORICAL_LINK_CREATED_AT,
    },
  ],
  inspections: [
    {
      inspectionId: 1,
      returnAllocationId: 1,
      pgNo: "PG-1",
      inspectionResult: "RETURN_TO_SUPPLIER",
      checkedAt: dateFromNow(-22),
      appearanceDefect: "찍힘",
      functionDefect: null,
    },
    {
      inspectionId: 2,
      returnAllocationId: 2,
      pgNo: "PG-2",
      inspectionResult: "PASSED",
      checkedAt: dateFromNow(-32),
      appearanceDefect: null,
      functionDefect: "전원",
    },
    {
      inspectionId: 3,
      returnAllocationId: 5,
      pgNo: "PG-3",
      inspectionResult: "RETURN_TO_SUPPLIER",
      checkedAt: dateFromNow(-77),
      appearanceDefect: "파손",
      functionDefect: null,
    },
  ],
  approvals: [
    {
      requestId: 1,
      externalReceiptId: "R-2",
      requestedAt: dateFromNow(-33, 11),
      localFinalizedAt: dateFromNow(-33, 21),
    },
    {
      requestId: 2,
      externalReceiptId: "R-2B",
      requestedAt: dateFromNow(-31),
      localFinalizedAt: dateFromNow(-30, 6),
    },
    {
      requestId: 3,
      externalReceiptId: "R-NO",
      requestedAt: dateFromNow(-12),
      localFinalizedAt: null,
    },
  ],
};

const result = aggregateReturnStatistics(input, { now: NOW });

assert.equal(
  result.summary.requestRate30Day.denominator,
  6,
  "29일 판매는 빠지고 30일 경계 판매는 현재 성숙 cohort에 포함돼야 합니다."
);
assert.equal(result.summary.requestRate30Day.numerator, 2);
assert.equal(result.summary.requestRate30Day.value, 33.33);
assert.equal(result.summary.previousRequestRate30Day.denominator, 0);
assert.equal(result.summary.previousRequestRate30Day.numerator, 0);
assert.equal(result.summary.previousCohortDeltaPercentagePoints, null);
assert.deepEqual(result.calculation.period, {
  fromDate: "2026-04-28",
  toDate: "2026-07-26",
  dayCount: 90,
});
assert.equal(result.calculation.mode, "LIVE");
assert.equal(result.calculation.dataCutoffDate, "2026-07-26");
assert.equal(
  result.source.linkedSaleRecordCount,
  4,
  "다중 receipt와 같은 PG 재판매가 sale allocation 단위로 구분돼야 합니다."
);
assert.deepEqual(result.overview, {
  receiptCount: 8,
  returnQuantity: 8,
  linkedReceiptCount: 6,
  linkedSaleRecordCount: 4,
  completedReceiptCount: 1,
  withdrawnReceiptCount: 1,
  receiptLinkRate: {
    value: 75,
    numerator: 6,
    denominator: 8,
  },
  withdrawalShare: {
    value: 12.5,
    numerator: 1,
    denominator: 8,
  },
});
assert.equal(
  result.source.uniqueExternalKeyLinkCount,
  2,
  "원 접수 없는 철회도 order/vendor item이 유일할 때만 보조 연결해야 합니다."
);
assert.equal(result.source.unmatchedWithdrawalCount, 1);
assert.equal(result.source.ambiguousReceiptCount, 1);
assert.equal(result.source.unlinkedReceiptCount, 1);
assert.equal(result.source.claimBeforeSaleCount, 1);
assert.equal(result.source.claimAfterThirtyDaysCount, 1);
assert.equal(
  result.summary.associatedSalesAmount.amount,
  3_400,
  "가격이 없는 판매는 0원으로 합산되면 안 됩니다."
);
assert.equal(result.summary.associatedSalesAmount.pricedCount, 3);
assert.equal(result.summary.associatedSalesAmount.totalCount, 4);
assert.equal(
  result.inspectionOutcome.confirmedInspectionPgCount,
  2,
  "철회된 receipt의 검수 결과는 회복 지표에서 제외돼야 합니다."
);
assert.equal(result.inspectionOutcome.recoveredCount, 1);
assert.equal(result.inspectionOutcome.nonSellableCount, 1);
assert.equal(result.inspectionOutcome.holdCount, 0);
assert.equal(result.inspectionOutcome.recoveryRate.value, 50);
assert.equal(result.summary.vendorFaultShare.numerator, 1);
assert.equal(result.preShipmentCancellations.receiptCount, 1);
assert.equal(result.preShipmentCancellations.cancellationQuantity, 2);
assert.equal(result.exchanges.receiptCount, 1);
assert.equal(result.exchanges.results[0]?.label, "SUCCESS");
assert.equal(result.exchanges.terminalLeadTime.medianHours, 48);
assert.equal(
  result.leadTimes.observationToApprovalRequest.medianHours,
  29,
  "최초 관측부터 승인 요청까지의 시간을 사용해야 합니다."
);
assert.equal(result.leadTimes.observationToApprovalRequest.p90Hours, 34);
assert.equal(
  result.leadTimes.observationToApprovalRequest.excludedAnomalyCount,
  1
);
assert.equal(
  result.leadTimes.observationToLocalFinalization.medianHours,
  49
);
assert.equal(result.leadTimes.observationToLocalFinalization.p90Hours, 54);
assert.equal(
  result.reasons.some((row) => row.label === "전원 불량"),
  true,
  "최신 CHANGED full snapshot의 사유를 사용해야 합니다."
);

const junePeriod = resolveClosedStatisticsPeriod({
  now: NOW,
  fromDate: "2026-06-01",
  toDate: "2026-06-30",
});
const splitPopulationInput = {
  sales: [
    {
      ...sale({
        id: 301,
        daysAgo: 47,
        orderId: "ORDER-COHORT",
        shipmentId: "SHIP-COHORT",
        vendorItemId: "ITEM-COHORT",
      }),
      soldAt: "2026-06-10T03:00:00.000Z",
    },
    {
      ...sale({
        id: 302,
        daysAgo: 73,
        orderId: "ORDER-OCCURRENCE",
        shipmentId: "SHIP-OCCURRENCE",
        vendorItemId: "ITEM-OCCURRENCE",
      }),
      soldAt: "2026-05-15T03:00:00.000Z",
    },
  ],
  events: [
    returnEvent({
      receiptId: "R-COHORT-LATER",
      orderId: "ORDER-COHORT",
      shipmentId: "SHIP-COHORT",
      detectedAt: "2026-07-06T03:00:00.000Z",
      createdAt: "2026-07-05T03:00:00.000Z",
    }),
    returnEvent({
      receiptId: "R-OCCURRENCE",
      orderId: "ORDER-OCCURRENCE",
      shipmentId: "SHIP-OCCURRENCE",
      detectedAt: "2026-06-15T03:00:00.000Z",
      createdAt: "2026-06-14T03:00:00.000Z",
    }),
    returnEvent({
      receiptId: "R-OCCURRENCE",
      orderId: "ORDER-OCCURRENCE",
      shipmentId: "SHIP-OCCURRENCE",
      eventType: "COUPANG_RETURN_CHANGED",
      detectedAt: "2026-07-27T00:00:00.000Z",
      createdAt: "2026-06-14T03:00:00.000Z",
      receiptStatus: "RETURNS_COMPLETED",
    }),
  ],
  allocationLinks: [
    {
      returnAllocationId: 301,
      returnRawId: 301,
      allocationId: 301,
      externalReceiptId: "R-COHORT-LATER",
      pgNo: "PG-301",
      actionType: "approve",
      createdAt: HISTORICAL_LINK_CREATED_AT,
    },
    {
      returnAllocationId: 302,
      returnRawId: 302,
      allocationId: 302,
      externalReceiptId: "R-OCCURRENCE",
      pgNo: "PG-302",
      actionType: "approve",
      createdAt: HISTORICAL_LINK_CREATED_AT,
    },
  ],
  inspections: [
    {
      inspectionId: 301,
      returnAllocationId: 302,
      pgNo: "PG-302",
      inspectionResult: "PASSED",
      checkedAt: "2026-07-27T00:00:00.000Z",
      appearanceDefect: null,
      functionDefect: null,
    },
  ],
  approvals: [
    {
      requestId: 301,
      externalReceiptId: "R-OCCURRENCE",
      requestedAt: "2026-07-27T00:00:00.000Z",
      localFinalizedAt: "2026-07-27T01:00:00.000Z",
    },
  ],
};
const splitPopulation = aggregateReturnStatistics(
  splitPopulationInput,
  { now: NOW, period: junePeriod }
);
assert.equal(splitPopulation.source.cohortSalesCount, 1);
assert.equal(splitPopulation.summary.requestRate30Day.denominator, 1);
assert.equal(splitPopulation.summary.requestRate30Day.numerator, 1);
assert.equal(
  splitPopulation.summary.previousRequestRate30Day.denominator,
  1
);
assert.equal(
  splitPopulation.summary.previousRequestRate30Day.numerator,
  1
);
assert.equal(splitPopulation.overview.receiptCount, 1);
assert.equal(splitPopulation.overview.completedReceiptCount, 0);
assert.equal(splitPopulation.inspectionOutcome.confirmedInspectionPgCount, 0);
assert.equal(
  splitPopulation.leadTimes.observationToApprovalRequest.sampleCount,
  0
);

const cutoffBoundaryInput = {
  sales: [
    sale({
      id: 401,
      daysAgo: 40,
      orderId: "ORDER-ASOF-BEFORE",
      shipmentId: "SHIP-ASOF-BEFORE",
      vendorItemId: "ITEM-ASOF-BEFORE",
    }),
    sale({
      id: 402,
      daysAgo: 40,
      orderId: "ORDER-ASOF-EXACT",
      shipmentId: "SHIP-ASOF-EXACT",
      vendorItemId: "ITEM-ASOF-EXACT",
    }),
    sale({
      id: 403,
      daysAgo: 40,
      orderId: "ORDER-ASOF-AFTER",
      shipmentId: "SHIP-ASOF-AFTER",
      vendorItemId: "ITEM-ASOF-AFTER",
    }),
    sale({
      id: 410,
      daysAgo: 0,
      orderId: "ORDER-SALE-BEFORE",
      shipmentId: "SHIP-SALE-BEFORE",
      vendorItemId: "ITEM-SALE-BEFORE",
      soldAt: "2026-07-26T14:59:59.999Z",
    }),
    sale({
      id: 411,
      daysAgo: 0,
      orderId: "ORDER-SALE-EXACT",
      shipmentId: "SHIP-SALE-EXACT",
      vendorItemId: "ITEM-SALE-EXACT",
      soldAt: "2026-07-26T15:00:00.000Z",
    }),
    sale({
      id: 412,
      daysAgo: 0,
      orderId: "ORDER-SALE-AFTER",
      shipmentId: "SHIP-SALE-AFTER",
      vendorItemId: "ITEM-SALE-AFTER",
      soldAt: "2026-07-26T18:29:00.000Z",
    }),
  ],
  events: [
    returnEvent({
      receiptId: "R-ASOF-BEFORE",
      orderId: "ORDER-ASOF-BEFORE",
      shipmentId: "SHIP-ASOF-BEFORE",
      detectedAt: "2026-07-26T14:00:00.000Z",
      createdAt: "2026-07-26T13:00:00.000Z",
    }),
    returnEvent({
      receiptId: "R-ASOF-EXACT",
      orderId: "ORDER-ASOF-EXACT",
      shipmentId: "SHIP-ASOF-EXACT",
      detectedAt: "2026-07-26T14:00:00.000Z",
      createdAt: "2026-07-26T13:00:00.000Z",
    }),
    returnEvent({
      receiptId: "R-ASOF-AFTER",
      orderId: "ORDER-ASOF-AFTER",
      shipmentId: "SHIP-ASOF-AFTER",
      detectedAt: "2026-07-26T14:00:00.000Z",
      createdAt: "2026-07-26T13:00:00.000Z",
    }),
    returnEvent({
      receiptId: "C-EVENT-BEFORE",
      orderId: "ORDER-EVENT-BEFORE",
      shipmentId: "SHIP-EVENT-BEFORE",
      receiptType: "CANCEL",
      detectedAt: "2026-07-26T14:59:59.999Z",
      createdAt: "2026-07-26T13:00:00.000Z",
    }),
    returnEvent({
      receiptId: "C-EVENT-EXACT",
      orderId: "ORDER-EVENT-EXACT",
      shipmentId: "SHIP-EVENT-EXACT",
      receiptType: "CANCEL",
      detectedAt: "2026-07-26T15:00:00.000Z",
      createdAt: "2026-07-26T13:00:00.000Z",
    }),
    returnEvent({
      receiptId: "C-EVENT-AFTER",
      orderId: "ORDER-EVENT-AFTER",
      shipmentId: "SHIP-EVENT-AFTER",
      receiptType: "CANCEL",
      detectedAt: "2026-07-26T18:29:00.000Z",
      createdAt: "2026-07-26T13:00:00.000Z",
    }),
  ],
  // Deliberately outside ReturnStatisticsAggregateInput: mutable raw data
  // must not participate in historical reconstruction.
  returnRaws: [
    raw({
      id: 401,
      receiptId: "R-ASOF-BEFORE",
      orderId: "ORDER-ASOF-BEFORE",
      shipmentId: "SHIP-ASOF-BEFORE",
      vendorItemId: "ITEM-ASOF-BEFORE",
    }),
    raw({
      id: 402,
      receiptId: "R-ASOF-EXACT",
      orderId: "ORDER-ASOF-EXACT",
      shipmentId: "SHIP-ASOF-EXACT",
      vendorItemId: "ITEM-ASOF-EXACT",
    }),
    raw({
      id: 403,
      receiptId: "R-ASOF-AFTER",
      orderId: "ORDER-ASOF-AFTER",
      shipmentId: "SHIP-ASOF-AFTER",
      vendorItemId: "ITEM-ASOF-AFTER",
    }),
  ],
  allocationLinks: [
    {
      returnAllocationId: 401,
      returnRawId: 401,
      allocationId: 401,
      externalReceiptId: "R-ASOF-BEFORE",
      pgNo: "PG-401",
      actionType: "approve",
      createdAt: "2026-07-26T14:59:59.999Z",
    },
    {
      returnAllocationId: 402,
      returnRawId: 402,
      allocationId: 402,
      externalReceiptId: "R-ASOF-EXACT",
      pgNo: "PG-402",
      actionType: "approve",
      createdAt: "2026-07-26T15:00:00.000Z",
    },
    {
      returnAllocationId: 403,
      returnRawId: 403,
      allocationId: 403,
      externalReceiptId: "R-ASOF-AFTER",
      pgNo: "PG-403",
      actionType: "approve",
      createdAt: "2026-07-26T18:29:00.000Z",
    },
  ],
  inspections: [],
  approvals: [],
};
const earlyAsOfNow = new Date("2026-07-26T15:01:00.000Z");
const scheduledAsOfNow = new Date("2026-07-26T18:30:00.000Z");
const asOfPeriod = resolveClosedStatisticsPeriod({ now: earlyAsOfNow });
const immutableAsOf = createReturnStatisticsAsOfContext(asOfPeriod);
immutableAsOf.cutoffExclusive.setTime(0);
const earlyAsOfResult = aggregateReturnStatistics(cutoffBoundaryInput, {
  now: earlyAsOfNow,
  period: asOfPeriod,
  asOf: immutableAsOf,
});
const scheduledAsOfResult = aggregateReturnStatistics(cutoffBoundaryInput, {
  now: scheduledAsOfNow,
  period: asOfPeriod,
});
assert.equal(earlyAsOfResult.source.confirmedAllocationLinkCount, 1);
assert.equal(earlyAsOfResult.source.uniqueExternalKeyLinkCount, 0);
assert.equal(earlyAsOfResult.source.cohortSalesCount, 4);
assert.equal(earlyAsOfResult.source.observedCancellationReceiptCount, 1);
assert.equal(earlyAsOfResult.overview.linkedReceiptCount, 1);
assert.equal(earlyAsOfResult.source.unlinkedReceiptCount, 2);
assert.equal(
  semanticResultHash(earlyAsOfResult),
  semanticResultHash(scheduledAsOfResult),
  "The same closed-day cutoff changed when recalculated later."
);

const empty = aggregateReturnStatistics(
  {
    sales: [],
    events: [],
    allocationLinks: [],
    inspections: [],
    approvals: [],
  },
  { now: NOW }
);
assert.equal(empty.summary.requestRate30Day.value, null);
assert.deepEqual(empty.overview, {
  receiptCount: 0,
  returnQuantity: 0,
  linkedReceiptCount: 0,
  linkedSaleRecordCount: 0,
  completedReceiptCount: 0,
  withdrawnReceiptCount: 0,
  receiptLinkRate: {
    value: null,
    numerator: 0,
    denominator: 0,
    unavailableReason: "조회 조건에 해당하는 고객 반품 접수가 없습니다.",
  },
  withdrawalShare: {
    value: null,
    numerator: 0,
    denominator: 0,
    unavailableReason: "조회 조건에 해당하는 고객 반품 접수가 없습니다.",
  },
});
assert.deepEqual(empty.cohortTrend, []);
assert.deepEqual(empty.productRows, []);
assert.equal(empty.summary.associatedSalesAmount.amount, null);

const performanceSales = Array.from({ length: 10_000 }, (_, index) =>
  sale({
    id: 100_000 + index,
    daysAgo: 31 + (index % 180),
    orderId: `PERF-ORDER-${index}`,
    shipmentId: `PERF-SHIP-${index}`,
    vendorItemId: `PERF-ITEM-${index}`,
    model: `PERF-MODEL-${index % 20}`,
  })
);
const performanceEvents = Array.from({ length: 5_000 }, (_, index) =>
  returnEvent({
    receiptId: `PERF-RETURN-${index}`,
    orderId: `PERF-UNKNOWN-${index}`,
    shipmentId: `PERF-UNKNOWN-SHIP-${index}`,
    detectedAt: dateFromNow(-(1 + (index % 120))),
    createdAt: dateFromNow(-(1 + (index % 120)), -1),
  })
);
const performanceStartedAt = performance.now();
const performanceResult = aggregateReturnStatistics(
  {
    sales: performanceSales,
    events: performanceEvents,
    allocationLinks: [],
    inspections: [],
    approvals: [],
  },
  {
    now: NOW,
    period: resolveClosedStatisticsPeriod({
      now: NOW,
      fromDate: "2025-12-01",
      toDate: "2026-07-26",
    }),
  }
);
const performanceElapsedMs = Math.round(
  performance.now() - performanceStartedAt
);
assert.equal(performanceResult.source.cohortSalesCount, 10_000);
assert.equal(performanceResult.source.observedReturnReceiptCount, 5_000);
assert.equal(performanceResult.source.unlinkedReceiptCount, 5_000);

console.log(
  `Return statistics aggregation verified. 10k sales / 5k events baseline: ${performanceElapsedMs}ms.`
);
