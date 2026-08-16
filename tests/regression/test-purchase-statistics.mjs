import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  aggregatePurchaseStatistics,
  loadPurchaseStatisticsInput,
} from "../../quickhack_server/statistics/purchase-statistics-service.ts";
import { resolveClosedStatisticsPeriod } from "../../quickhack_shared/statistics/statistics-period.ts";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_FIXTURE_PERIOD = resolveClosedStatisticsPeriod({
  now: NOW,
  fromDate: "2026-01-01",
  toDate: "2026-07-27",
});

function isoDaysAgo(daysAgo, hours = 0) {
  return new Date(
    NOW.getTime() - daysAgo * DAY_MS + hours * 60 * 60 * 1000
  ).toISOString();
}

function inspection({
  id,
  checkedAt,
  grade = "A",
  appearanceDefect = "하자 없음",
  functionDefect = "하자 없음",
  type = "APPEARANCE",
}) {
  return {
    inspectionId: id,
    inspectionType: type,
    checkedAt,
    appearanceCheckedAt: type === "APPEARANCE" ? checkedAt : null,
    functionCheckedAt: type === "FUNCTION" ? checkedAt : null,
    appearanceGrade: type === "APPEARANCE" ? grade : null,
    appearanceDefect:
      type === "APPEARANCE" ? appearanceDefect : null,
    functionDefect: type === "FUNCTION" ? functionDefect : null,
    returnYn: "N",
  };
}

function inbound({
  id,
  pgNo,
  status = "PURCHASED",
  supplier = "공급처 A",
  price = 300_000,
  referenceAmount = 300_000,
  entryMode = "RATE",
  outcomeDaysAgo = 120,
  model = "Galaxy S24",
  storage = "256GB",
  color = "Black",
  inspections = [],
}) {
  return {
    inboundId: id,
    pgNo,
    inboundStatus: status,
    supplierName: supplier,
    purchasePrice: price,
    purchasePriceReferenceAmount: referenceAmount,
    purchasePriceEntryMode: entryMode,
    receivedAt: isoDaysAgo(outcomeDaysAgo + 2),
    priceAgreedAt:
      status === "PURCHASED" ? isoDaysAgo(outcomeDaysAgo) : null,
    supplierReturnedAt:
      status === "SUPPLIER_RETURN" ? isoDaysAgo(outcomeDaysAgo) : null,
    batchDate: "2026-07-01",
    batchNo: id,
    imei: `IMEI-${id}`,
    model,
    storage,
    color,
    inspections,
  };
}

function sale({
  id,
  inboundId,
  pgNo,
  supplier,
  soldDaysAgo,
  status = "SOLD",
  soldAt,
  purchaseAgreedAt = null,
}) {
  return {
    saleRecordId: id,
    allocationId: id,
    pgNo,
    purchaseInboundId: inboundId,
    supplierName: supplier,
    purchaseAgreedAt,
    purchasePrice: 300_000,
    soldAt: soldAt ?? isoDaysAgo(soldDaysAgo),
    saleStatus: status,
    model: "Galaxy S24",
    storage: "256GB",
    color: "Black",
    saleGrade: "A",
  };
}

const input = {
  inbounds: [
    inbound({
      id: 1,
      pgNo: "CYCLE-PG",
      outcomeDaysAgo: 120,
      inspections: [
        inspection({
          id: 1,
          checkedAt: isoDaysAgo(121),
          grade: "A",
        }),
      ],
    }),
    inbound({
      id: 2,
      pgNo: "CYCLE-PG",
      supplier: "공급처 B",
      price: 320_000,
      referenceAmount: 300_000,
      entryMode: "OVERRIDE",
      outcomeDaysAgo: 100,
      inspections: [
        inspection({
          id: 2,
          checkedAt: isoDaysAgo(101),
          grade: "A",
        }),
        inspection({
          id: 3,
          checkedAt: isoDaysAgo(100, -1),
          grade: "A",
          type: "FUNCTION",
          functionDefect: "카메라: 초점불량",
        }),
      ],
    }),
    inbound({
      id: 3,
      pgNo: "SUPPLIER-RETURN-PG",
      status: "SUPPLIER_RETURN",
      outcomeDaysAgo: 40,
      price: null,
      referenceAmount: null,
      entryMode: null,
      inspections: [
        inspection({
          id: 4,
          checkedAt: isoDaysAgo(41),
          grade: "B",
          appearanceDefect: "액정: 찍힘",
        }),
      ],
    }),
    inbound({
      id: 4,
      pgNo: "RECENT-PG",
      price: 250_000,
      referenceAmount: null,
      entryMode: "MANUAL",
      outcomeDaysAgo: 20,
      inspections: [],
    }),
    inbound({
      id: 5,
      pgNo: "MISSING-PRICE-PG",
      price: null,
      referenceAmount: null,
      entryMode: null,
      outcomeDaysAgo: 70,
      inspections: [],
    }),
  ],
  sales: [
    sale({
      id: 1,
      inboundId: 1,
      pgNo: "CYCLE-PG",
      supplier: "공급처 A",
      soldDaysAgo: 110,
    }),
    sale({
      id: 2,
      inboundId: 2,
      pgNo: "CYCLE-PG",
      supplier: "공급처 B",
      soldDaysAgo: 80,
      status: "RETURNED",
    }),
    sale({
      id: 3,
      inboundId: 2,
      pgNo: "CYCLE-PG",
      supplier: "공급처 B",
      soldDaysAgo: 75,
    }),
    sale({
      id: 4,
      inboundId: null,
      pgNo: "LEGACY-SALE-PG",
      supplier: "공급처 A",
      soldDaysAgo: 50,
      status: "RETURNED",
      purchaseAgreedAt: isoDaysAgo(60),
    }),
    sale({
      id: 5,
      inboundId: 5,
      pgNo: "MISSING-PRICE-PG",
      supplier: "공급처 A",
      soldDaysAgo: 71,
    }),
    sale({
      id: 6,
      inboundId: null,
      pgNo: "INVALID-SALE-PG",
      supplier: null,
      soldDaysAgo: 1,
      soldAt: "not-a-date",
      purchaseAgreedAt: isoDaysAgo(2),
    }),
  ],
};

const result = aggregatePurchaseStatistics(input, {
  now: NOW,
  period: FULL_FIXTURE_PERIOD,
});

assert.equal(result.source.loadedTerminalInboundCount, 5);
assert.equal(result.source.periodEligibleInboundCount, 5);
assert.equal(result.source.outsidePeriodInboundCount, 0);
assert.equal(result.source.terminalInboundCount, 5);
assert.equal(result.calculation.mode, "LIVE");
assert.deepEqual(result.calculation.period, {
  fromDate: "2026-01-01",
  toDate: "2026-07-27",
  dayCount: 208,
});
assert.equal(result.calculation.dataCutoffDate, "2026-07-27");
assert.equal(result.calculation.isDefaultPeriod, false);
assert.equal(result.source.purchaseCount, 4);
assert.equal(result.source.supplierReturnCount, 1);
assert.equal(result.summary.purchaseCount, 4);
assert.equal(result.summary.purchaseAmount.amount, 870_000);
assert.equal(result.summary.purchaseAmount.pricedCount, 3);
assert.equal(result.summary.purchaseAmount.totalCount, 4);
assert.equal(result.summary.purchaseAmount.coveragePercent, 75);
assert.equal(result.summary.averagePurchasePrice, 290_000);
assert.equal(result.summary.supplierCount, 2);
assert.equal(result.summary.missingPurchasePriceCount, 1);
assert.deepEqual(result.summary.supplierReturnRate, {
  value: 20,
  numerator: 1,
  denominator: 5,
});

assert.equal(
  result.source.linkedInspectionOutcomeCount,
  3,
  "Only exact inbound-linked inspection evidence must be counted."
);
assert.equal(result.source.inspectionLinkCoveragePercent, 60);
assert.equal(result.inspectionQuality.inspectedOutcomeCount, 3);
assert.equal(result.inspectionQuality.defectOutcomeCount, 2);
assert.equal(result.inspectionQuality.defectRate.value, 66.67);
assert.deepEqual(result.inspectionQuality.appearanceDefects, [
  { label: "액정: 찍힘", count: 1 },
]);
assert.deepEqual(result.inspectionQuality.functionDefects, [
  { label: "카메라: 초점불량", count: 1 },
]);

assert.equal(result.source.pricePolicyEvidenceCount, 3);
assert.equal(result.source.pricePolicyCoveragePercent, 75);
assert.equal(result.source.priceReferenceEvidenceCount, 2);
const ratePolicy = result.pricePolicyRows.find(
  (row) => row.entryMode === "RATE"
);
const overridePolicy = result.pricePolicyRows.find(
  (row) => row.entryMode === "OVERRIDE"
);
const unknownPolicy = result.pricePolicyRows.find(
  (row) => row.entryMode === "UNKNOWN"
);
assert.equal(ratePolicy.purchaseCount, 1);
assert.equal(ratePolicy.unchangedCount, 1);
assert.equal(overridePolicy.averageAdjustmentAmount, 20_000);
assert.equal(overridePolicy.averageAdjustmentPercent, 6.67);
assert.equal(overridePolicy.increasedCount, 1);
assert.equal(unknownPolicy.purchaseCount, 1);
assert.equal(unknownPolicy.referenceCoveragePercent, 0);

assert.equal(result.source.salesRecordCount, 5);
assert.equal(result.source.purchaseInboundLinkedSaleCount, 4);
assert.equal(result.source.missingPurchaseInboundSaleCount, 1);
assert.equal(result.source.salesLinkCoveragePercent, 80);
assert.equal(result.source.supplierSnapshotSaleCount, 5);
assert.equal(result.source.returnedSaleCount, 2);
assert.equal(result.source.invalidTimestampCount, 1);
assert.equal(result.source.negativeDurationCount, 1);

const product = result.productRows.find(
  (row) =>
    row.model === "Galaxy S24" &&
    row.storage === "256GB" &&
    row.purchaseGrade === "A"
);
assert.equal(
  product.purchaseCount,
  2,
  "Two inbound cycles for the same PG must remain separate purchases."
);
assert.equal(product.saleConversion30Day.denominator, 2);
assert.equal(product.saleConversion30Day.numerator, 2);
assert.equal(product.saleConversion90Day.denominator, 2);
assert.equal(product.saleConversion90Day.numerator, 2);

const unknownGradeProduct = result.productRows.find(
  (row) => row.purchaseGrade === "미기록 등급"
);
assert.equal(unknownGradeProduct.purchaseCount, 2);
assert.equal(unknownGradeProduct.saleConversion30Day.denominator, 1);
assert.equal(unknownGradeProduct.saleConversion30Day.numerator, 0);
assert.equal(unknownGradeProduct.saleConversion60Day.denominator, 1);
assert.equal(unknownGradeProduct.saleConversion90Day.denominator, 0);
assert.equal(unknownGradeProduct.saleConversion90Day.value, null);

const supplierA = result.supplierRows.find(
  (row) => row.supplierName === "공급처 A"
);
const supplierB = result.supplierRows.find(
  (row) => row.supplierName === "공급처 B"
);
assert.equal(supplierA.customerReturnConfirmationRate.value, 33.33);
assert.equal(supplierA.customerReturnConfirmationRate.numerator, 1);
assert.equal(supplierA.customerReturnConfirmationRate.denominator, 3);
assert.equal(supplierB.customerReturnConfirmationRate.value, 50);
assert.equal(supplierB.customerReturnConfirmationRate.numerator, 1);
assert.equal(supplierB.customerReturnConfirmationRate.denominator, 2);

assert.equal(result.leadTimes.receivedToLastInspection.sampleCount, 3);
assert.equal(
  result.leadTimes.lastInspectionToTerminalOutcome.sampleCount,
  3
);
assert.equal(result.leadTimes.receivedToTerminalOutcome.sampleCount, 5);
assert.ok(result.monthlyTrend.length > 0);

const julyPeriod = resolveClosedStatisticsPeriod({
  now: NOW,
  fromDate: "2026-07-01",
  toDate: "2026-07-10",
});
const periodBoundaryInput = {
  inbounds: [
    inbound({ id: 201, pgNo: "IN-RANGE-START", outcomeDaysAgo: 27 }),
    inbound({
      id: 202,
      pgNo: "IN-RANGE-END",
      status: "SUPPLIER_RETURN",
      outcomeDaysAgo: 18,
    }),
    inbound({ id: 203, pgNo: "OUTSIDE-BEFORE", outcomeDaysAgo: 28 }),
    inbound({ id: 204, pgNo: "OUTSIDE-AFTER", outcomeDaysAgo: 17 }),
    inbound({ id: 205, pgNo: "OPEN-DAY", outcomeDaysAgo: 0 }),
  ],
  sales: [
    sale({
      id: 201,
      inboundId: 201,
      pgNo: "IN-RANGE-START",
      supplier: "BOUNDARY",
      soldDaysAgo: 5,
    }),
    sale({
      id: 202,
      inboundId: 203,
      pgNo: "OUTSIDE-BEFORE",
      supplier: "BOUNDARY",
      soldDaysAgo: 5,
    }),
  ],
};
const periodBoundaryResult = aggregatePurchaseStatistics(
  periodBoundaryInput,
  { now: NOW, period: julyPeriod }
);
assert.equal(periodBoundaryResult.source.loadedTerminalInboundCount, 5);
assert.equal(periodBoundaryResult.source.periodEligibleInboundCount, 2);
assert.equal(periodBoundaryResult.source.outsidePeriodInboundCount, 2);
assert.equal(periodBoundaryResult.source.terminalInboundCount, 2);
assert.equal(periodBoundaryResult.source.salesRecordCount, 1);
const empty = aggregatePurchaseStatistics(
  { inbounds: [], sales: [] },
  { now: NOW, period: FULL_FIXTURE_PERIOD }
);
assert.equal(empty.summary.purchaseCount, 0);
assert.equal(empty.summary.purchaseAmount.amount, null);
assert.equal(empty.summary.averagePurchasePrice, null);
assert.equal(empty.summary.supplierReturnRate.value, null);
assert.deepEqual(empty.monthlyTrend, []);
assert.deepEqual(empty.productRows, []);
assert.deepEqual(empty.supplierRows, []);
assert.equal(empty.pricePolicyRows.length, 4);

const pagedInboundRows = Array.from({ length: 401 }, (_, index) => ({
  inbound_id: index + 1,
  pg_no: `PAGED-PG-${index + 1}`,
  inbound_status: "PURCHASED",
  supplier_name: "묶음 조회 공급처",
  purchase_price: 100_000,
  purchase_price_reference_amount: 100_000,
  purchase_price_entry_mode: "RATE",
  received_at: "2026-07-01 09:00:00",
  price_agreed_at: "2026-07-01 10:00:00",
  supplier_returned_at: null,
  inbound_batch: null,
  devices: {
    imei: null,
    model: "묶음 조회 기종",
    storage: "256GB",
    color: "Black",
  },
  inspections: [],
}));
let inboundPageReadCount = 0;
const pagedInput = await loadPurchaseStatisticsInput({
  inbounds: {
    async findMany(args) {
      inboundPageReadCount += 1;
      assert.equal(args.take, 400);

      if (inboundPageReadCount === 1) {
        assert.equal(args.cursor, undefined);
        assert.equal(args.skip, undefined);
        return pagedInboundRows.slice(0, 400);
      }

      assert.deepEqual(args.cursor, { inbound_id: 400 });
      assert.equal(args.skip, 1);
      return pagedInboundRows.slice(400);
    },
  },
  sales_records: {
    async findMany() {
      return [];
    },
  },
});
assert.equal(inboundPageReadCount, 2);
assert.equal(pagedInput.inbounds.length, 401);
assert.equal(pagedInput.inbounds[400].inboundId, 401);

const performanceInbounds = Array.from({ length: 10_000 }, (_, index) =>
  inbound({
    id: 100_000 + index,
    pgNo: `PERF-PG-${index}`,
    supplier: `PERF-SUPPLIER-${index % 25}`,
    price: 100_000 + (index % 100),
    outcomeDaysAgo: 100 + (index % 100),
    inspections: [
      inspection({
        id: 200_000 + index * 2,
        checkedAt: isoDaysAgo(101 + (index % 100)),
        grade: index % 2 === 0 ? "A" : "B",
      }),
      inspection({
        id: 200_001 + index * 2,
        checkedAt: isoDaysAgo(100 + (index % 100), -1),
        grade: index % 2 === 0 ? "A" : "B",
        type: "FUNCTION",
      }),
    ],
  })
);
const performanceSales = Array.from({ length: 10_000 }, (_, index) =>
  sale({
    id: 100_000 + index,
    inboundId: 100_000 + index,
    pgNo: `PERF-PG-${index}`,
    supplier: `PERF-SUPPLIER-${index % 25}`,
    soldDaysAgo: 80 + (index % 100),
  })
);
const performanceStartedAt = performance.now();
const performanceResult = aggregatePurchaseStatistics(
  {
    inbounds: performanceInbounds,
    sales: performanceSales,
  },
  { now: NOW, period: FULL_FIXTURE_PERIOD }
);
const performanceElapsedMs = Math.round(
  performance.now() - performanceStartedAt
);
assert.equal(performanceResult.source.terminalInboundCount, 10_000);
assert.equal(performanceResult.source.salesRecordCount, 10_000);
assert.equal(performanceResult.source.linkedInspectionOutcomeCount, 10_000);

console.log(
  `Purchase statistics aggregation verified. 10k inbounds / 10k sales / 20k inspections baseline: ${performanceElapsedMs}ms.`
);
