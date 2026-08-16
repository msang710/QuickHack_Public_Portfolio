// QuickHack service: PII-minimized read model and deterministic aggregation for
// post-shipment returns, pre-shipment cancellations, and exchanges.
import type { PrismaClient } from "@/generated/prisma/client";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import {
  COUPANG_CLAIM_EVENT_TYPE,
} from "@/quickhack_shared/sales-channel/coupang/claim-history";
import {
  isTerminalCoupangExchangeStatus,
  isTerminalCoupangReturnStatus,
} from "@/quickhack_shared/sales-channel/coupang/claim-lifecycle";
import {
  INSPECTION_RESULT,
  INSPECTION_SOURCE_TYPE,
  INSPECTION_TYPE,
} from "@/quickhack_shared/inspection/inspection-types";
import {
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
} from "@/quickhack_shared/sales-channel/write-requests";
import {
  formatKstDate,
  parseKstSqlDateTime,
  quickHackClock,
} from "@/quickhack_shared/core/time";
import type {
  ExchangeStatistics,
  PreShipmentCancellationStatistics,
  ReturnAmountMetric,
  ReturnCohortTrendRow,
  ReturnDurationMetric,
  ReturnOccurrenceTrendRow,
  ReturnProductComparisonRow,
  ReturnRateMetric,
  ReturnReasonInspectionRow,
  ReturnStatisticsData,
  StatisticsGroup,
} from "@/quickhack_shared/statistics/statistics";
import {
  resolveClosedStatisticsPeriod,
  statisticsDateTimeBounds,
  type StatisticsDateTimeBounds,
  type StatisticsPeriodContext,
} from "@/quickhack_shared/statistics/statistics-period";
import { loadStatisticsCursorPages } from "@/quickhack_server/statistics/statistics-loader";
import { liveStatisticsCalculationMetadata } from "@/quickhack_server/statistics/statistics-period-request";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETURN_EVENT_TYPES = [
  COUPANG_CLAIM_EVENT_TYPE.returnObserved,
  COUPANG_CLAIM_EVENT_TYPE.returnChanged,
  COUPANG_CLAIM_EVENT_TYPE.returnWithdrawn,
] as const;
const EXCHANGE_EVENT_TYPES = [
  COUPANG_CLAIM_EVENT_TYPE.exchangeObserved,
  COUPANG_CLAIM_EVENT_TYPE.exchangeChanged,
] as const;
const CLAIM_EVENT_TYPES = [...RETURN_EVENT_TYPES, ...EXCHANGE_EVENT_TYPES];
const KNOWN_FAULT_TYPES = new Set([
  "VENDOR",
  "CUSTOMER",
  "COUPANG",
  "WMS",
  "GENERAL",
]);

export type ReturnStatisticsSaleInput = {
  saleRecordId: number;
  allocationId: number;
  pgNo: string;
  channel: string;
  externalOrderId: string;
  externalShipmentId: string | null;
  externalVendorItemId: string | null;
  soldAt: string;
  saleStatus: string;
  salesPrice: number | null;
  purchasePrice: number | null;
  model: string | null;
  storage: string | null;
  saleGrade: string | null;
  productNames: string[];
};

export type ReturnStatisticsEventInput = {
  eventId: number;
  sourcePk: string;
  externalOrderId: string | null;
  externalShipmentId: string | null;
  externalReceiptId: string | null;
  externalExchangeId: string | null;
  eventType: string;
  detectedAt: string;
  fields: Array<{
    fieldName: string;
    afterValue: string | null;
  }>;
};

export type ReturnStatisticsRawItemInput = {
  externalVendorItemId: string | null;
  sellerProductItemId: string | null;
  vendorItemName: string | null;
  cancelCount: number;
};

export type ReturnStatisticsRawInput = {
  returnRawId: number;
  externalReceiptId: string;
  externalOrderId: string;
  externalShipmentId: string | null;
  cancelType: string | null;
  cancelCount: number;
  items: ReturnStatisticsRawItemInput[];
};

export type ReturnStatisticsAllocationLinkInput = {
  returnAllocationId: number;
  returnRawId: number;
  allocationId: number;
  externalReceiptId: string;
  pgNo: string;
  actionType: string;
};

export type ReturnStatisticsInspectionInput = {
  inspectionId: number;
  returnAllocationId: number;
  pgNo: string;
  inspectionResult: string | null;
  checkedAt: string | null;
  appearanceDefect: string | null;
  functionDefect: string | null;
};

export type ReturnStatisticsApprovalInput = {
  requestId: number;
  externalReceiptId: string;
  requestedAt: string;
  localFinalizedAt: string | null;
};

export type ReturnStatisticsAggregateInput = {
  sales: ReturnStatisticsSaleInput[];
  events: ReturnStatisticsEventInput[];
  returnRaws: ReturnStatisticsRawInput[];
  allocationLinks: ReturnStatisticsAllocationLinkInput[];
  inspections: ReturnStatisticsInspectionInput[];
  approvals: ReturnStatisticsApprovalInput[];
};

type ClaimSnapshot = Record<string, string | null>;

type PreparedReturnClaim = {
  receiptId: string;
  externalOrderId: string | null;
  externalShipmentId: string | null;
  receiptType: string | null;
  receiptStatus: string | null;
  faultType: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  reasonCategory: string | null;
  reasonDetail: string | null;
  quantity: number;
  observedAt: Date;
  externalCreatedAt: Date | null;
  externalCompletedAt: Date | null;
  withdrawnAt: Date | null;
  withdrawn: boolean;
  raw: ReturnStatisticsRawInput | null;
};

type PreparedExchangeClaim = {
  exchangeId: string;
  externalOrderId: string | null;
  externalShipmentId: string | null;
  status: string | null;
  faultType: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  reasonDetail: string | null;
  observedAt: Date;
  externalCreatedAt: Date | null;
  externalModifiedAt: Date | null;
};

type PreparedSale = ReturnStatisticsSaleInput & {
  soldDate: Date;
};

type ClaimLink = {
  saleRecordId: number;
  method: "CONFIRMED" | "UNIQUE_EXTERNAL_KEY";
  returnAllocationId: number | null;
};

type ClaimLinkResult = {
  byReceipt: Map<string, ClaimLink[]>;
  confirmedAllocationLinkCount: number;
  uniqueExternalKeyLinkCount: number;
  unlinkedReceiptIds: Set<string>;
  ambiguousReceiptIds: Set<string>;
};

type InspectionResultRow = {
  sale: PreparedSale;
  claim: PreparedReturnClaim;
  inspection: ReturnStatisticsInspectionInput;
};

type WithdrawalOnlyMatch = {
  event: ReturnStatisticsEventInput;
  saleRecordIds: number[];
};

function nullableText(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizedCode(value: unknown) {
  return nullableText(value)?.toUpperCase() ?? null;
}

function parseDate(value: string | null | undefined) {
  const text = nullableText(value);

  if (!text) {
    return null;
  }

  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    const parsed = new Date(text);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) {
    return parseKstSqlDateTime(text);
  }

  const localIso = /^\d{4}-\d{2}-\d{2}T/.test(text)
    ? `${text}+09:00`
    : text;
  const parsed = new Date(localIso);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function round(value: number, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function percentage(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : round((numerator / denominator) * 100);
}

function rateMetric(
  numerator: number,
  denominator: number,
  unavailableReason = "집계 가능한 분모가 없습니다."
): ReturnRateMetric {
  if (denominator === 0) {
    return {
      value: null,
      numerator,
      denominator,
      unavailableReason,
    };
  }

  return {
    value: percentage(numerator, denominator),
    numerator,
    denominator,
  };
}

function amountMetric<T>(
  rows: T[],
  price: (row: T) => number | null
): ReturnAmountMetric {
  const prices = rows
    .map(price)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  return {
    amount:
      prices.length === 0
        ? null
        : prices.reduce((sum, value) => sum + Math.trunc(value), 0),
    pricedCount: prices.length,
    totalCount: rows.length,
    coveragePercent: percentage(prices.length, rows.length),
  };
}

function percentileNearestRank(sorted: number[], percentile: number) {
  if (sorted.length === 0) {
    return null;
  }

  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? null;
}

function durationMetric(
  values: number[],
  excludedAnomalyCount: number
): ReturnDurationMetric {
  const sorted = values.slice().sort((left, right) => left - right);
  let median: number | null = null;

  if (sorted.length > 0) {
    const middle = Math.floor(sorted.length / 2);
    median =
      sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
  }

  return {
    sampleCount: sorted.length,
    medianHours: median === null ? null : round(median),
    p90Hours:
      sorted.length === 0
        ? null
        : round(percentileNearestRank(sorted, 0.9) ?? 0),
    excludedAnomalyCount,
  };
}

function monthKey(date: Date) {
  return formatKstDate(date).slice(0, 7);
}

function countGroups(
  values: Array<string | null>,
  fallback = "미확인"
): StatisticsGroup[] {
  const counts = new Map<string, number>();

  for (const value of values) {
    const label = nullableText(value) ?? fallback;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return Array.from(counts, ([label, count]) => ({ label, count })).sort(
    (left, right) =>
      right.count - left.count ||
      left.label.localeCompare(right.label, "ko-KR")
  );
}

function weightedGroups(values: Array<{ label: string | null; count: number }>) {
  const counts = new Map<string, number>();

  for (const value of values) {
    const label = nullableText(value.label) ?? "미확인";
    counts.set(label, (counts.get(label) ?? 0) + Math.max(0, value.count));
  }

  return Array.from(counts, ([label, count]) => ({ label, count })).sort(
    (left, right) =>
      right.count - left.count ||
      left.label.localeCompare(right.label, "ko-KR")
  );
}

function snapshotFromFields(event: ReturnStatisticsEventInput) {
  return Object.fromEntries(
    event.fields.map((field) => [field.fieldName, field.afterValue])
  ) as ClaimSnapshot;
}

function rawQuantity(raw: ReturnStatisticsRawInput | null, snapshot: ClaimSnapshot) {
  if (raw && raw.items.length > 0) {
    return raw.items.reduce(
      (sum, item) => sum + Math.max(0, Math.trunc(item.cancelCount)),
      0
    );
  }

  const fallback = Number.parseInt(
    snapshot.cancel_count ?? String(raw?.cancelCount ?? 0),
    10
  );
  return Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
}

function prepareSales(input: ReturnStatisticsAggregateInput) {
  return input.sales.flatMap((sale): PreparedSale[] => {
    const soldDate = parseDate(sale.soldAt);

    if (!soldDate) {
      return [];
    }

    return [
      {
        ...sale,
        soldDate,
      },
    ];
  });
}

function prepareClaims(input: ReturnStatisticsAggregateInput) {
  const rawByReceipt = new Map(
    input.returnRaws.map((raw) => [raw.externalReceiptId, raw])
  );
  const returnEventsByReceipt = new Map<
    string,
    ReturnStatisticsEventInput[]
  >();
  const exchangeEventsById = new Map<
    string,
    ReturnStatisticsEventInput[]
  >();

  for (const event of input.events) {
    if (
      RETURN_EVENT_TYPES.includes(
        event.eventType as (typeof RETURN_EVENT_TYPES)[number]
      )
    ) {
      const receiptId = event.externalReceiptId ?? event.sourcePk;
      const current = returnEventsByReceipt.get(receiptId) ?? [];
      current.push(event);
      returnEventsByReceipt.set(receiptId, current);
    } else if (
      EXCHANGE_EVENT_TYPES.includes(
        event.eventType as (typeof EXCHANGE_EVENT_TYPES)[number]
      )
    ) {
      const exchangeId = event.externalExchangeId ?? event.sourcePk;
      const current = exchangeEventsById.get(exchangeId) ?? [];
      current.push(event);
      exchangeEventsById.set(exchangeId, current);
    }
  }

  const returns: PreparedReturnClaim[] = [];
  const withdrawalOnlyEvents: ReturnStatisticsEventInput[] = [];

  for (const [receiptId, unsortedEvents] of returnEventsByReceipt) {
    const events = unsortedEvents
      .slice()
      .sort((left, right) => left.eventId - right.eventId);
    const observationEvents = events.filter(
      (event) =>
        event.eventType === COUPANG_CLAIM_EVENT_TYPE.returnObserved ||
        event.eventType === COUPANG_CLAIM_EVENT_TYPE.returnChanged
    );
    const observed = observationEvents.find(
      (event) =>
        event.eventType === COUPANG_CLAIM_EVENT_TYPE.returnObserved
    );
    const latest = observationEvents.at(-1);
    const withdrawals = events.filter(
      (event) =>
        event.eventType === COUPANG_CLAIM_EVENT_TYPE.returnWithdrawn
    );

    if (!observed || !latest) {
      withdrawalOnlyEvents.push(...withdrawals);
      continue;
    }

    const snapshot = snapshotFromFields(latest);
    const raw = rawByReceipt.get(receiptId) ?? null;
    const withdrawal = withdrawals.at(-1) ?? null;
    const withdrawalSnapshot = withdrawal
      ? snapshotFromFields(withdrawal)
      : {};
    const observedAt = parseDate(observed.detectedAt);

    if (!observedAt) {
      continue;
    }

    const externalOrderId =
      latest.externalOrderId ?? raw?.externalOrderId ?? null;
    const externalShipmentId =
      latest.externalShipmentId ?? raw?.externalShipmentId ?? null;

    returns.push({
      receiptId,
      externalOrderId,
      externalShipmentId,
      receiptType:
        normalizedCode(snapshot.receipt_type) ??
        normalizedCode(raw?.cancelType),
      receiptStatus: normalizedCode(snapshot.receipt_status),
      faultType: normalizedCode(snapshot.fault_by_type),
      reasonCode: nullableText(snapshot.reason_code),
      reasonLabel: nullableText(snapshot.reason_label),
      reasonCategory: nullableText(snapshot.reason_category),
      reasonDetail: nullableText(snapshot.reason_detail),
      quantity: rawQuantity(raw, snapshot),
      observedAt,
      externalCreatedAt: parseDate(snapshot.external_created_at),
      externalCompletedAt: parseDate(snapshot.external_completed_at),
      withdrawnAt: parseDate(withdrawalSnapshot.external_withdrawn_at),
      withdrawn: withdrawal !== null,
      raw,
    });
  }

  const exchanges: PreparedExchangeClaim[] = [];

  for (const [exchangeId, unsortedEvents] of exchangeEventsById) {
    const events = unsortedEvents
      .slice()
      .sort((left, right) => left.eventId - right.eventId);
    const observed = events.find(
      (event) =>
        event.eventType === COUPANG_CLAIM_EVENT_TYPE.exchangeObserved
    );
    const latest = events.at(-1);
    const observedAt = parseDate(observed?.detectedAt);

    if (!observed || !latest || !observedAt) {
      continue;
    }

    const snapshot = snapshotFromFields(latest);

    exchanges.push({
      exchangeId,
      externalOrderId: latest.externalOrderId,
      externalShipmentId: latest.externalShipmentId,
      status: normalizedCode(snapshot.exchange_status),
      faultType: normalizedCode(snapshot.fault_by_type),
      reasonCode: nullableText(snapshot.reason_code),
      reasonLabel: nullableText(snapshot.reason_label),
      reasonDetail: nullableText(snapshot.reason_detail),
      observedAt,
      externalCreatedAt: parseDate(snapshot.external_created_at),
      externalModifiedAt: parseDate(snapshot.external_modified_at),
    });
  }

  return {
    returns,
    exchanges,
    withdrawalOnlyEvents,
  };
}

function claimReason(claim: PreparedReturnClaim) {
  return (
    claim.reasonLabel ??
    claim.reasonCategory ??
    claim.reasonCode ??
    "미확인"
  );
}

function claimItemVendorId(item: ReturnStatisticsRawItemInput) {
  return item.externalVendorItemId ?? item.sellerProductItemId;
}

function buildClaimLinks(
  claims: PreparedReturnClaim[],
  sales: PreparedSale[],
  input: ReturnStatisticsAggregateInput
): ClaimLinkResult {
  const salesByAllocation = new Map(
    sales.map((sale) => [sale.allocationId, sale])
  );
  const storedByReceipt = new Map<
    string,
    ReturnStatisticsAllocationLinkInput[]
  >();
  const salesByExactExternalKey = new Map<string, PreparedSale[]>();
  const salesByOrderVendorKey = new Map<string, PreparedSale[]>();

  for (const sale of sales) {
    if (!sale.externalVendorItemId) {
      continue;
    }

    const orderVendorKey = [
      sale.externalOrderId,
      sale.externalVendorItemId,
    ].join("\u0000");
    const exactKey = [
      sale.externalOrderId,
      sale.externalShipmentId ?? "",
      sale.externalVendorItemId,
    ].join("\u0000");
    const orderVendorRows = salesByOrderVendorKey.get(orderVendorKey) ?? [];
    const exactRows = salesByExactExternalKey.get(exactKey) ?? [];
    orderVendorRows.push(sale);
    exactRows.push(sale);
    salesByOrderVendorKey.set(orderVendorKey, orderVendorRows);
    salesByExactExternalKey.set(exactKey, exactRows);
  }

  for (const link of input.allocationLinks) {
    const current = storedByReceipt.get(link.externalReceiptId) ?? [];
    current.push(link);
    storedByReceipt.set(link.externalReceiptId, current);
  }

  const byReceipt = new Map<string, ClaimLink[]>();
  const unlinkedReceiptIds = new Set<string>();
  const ambiguousReceiptIds = new Set<string>();
  let confirmedAllocationLinkCount = 0;
  let uniqueExternalKeyLinkCount = 0;

  for (const claim of claims.filter(
    (candidate) => candidate.receiptType === "RETURN"
  )) {
    const stored = storedByReceipt.get(claim.receiptId) ?? [];
    const confirmed = stored.flatMap((link): ClaimLink[] => {
      const sale = salesByAllocation.get(link.allocationId);
      return sale
        ? [
            {
              saleRecordId: sale.saleRecordId,
              method: "CONFIRMED",
              returnAllocationId: link.returnAllocationId,
            },
          ]
        : [];
    });

    if (confirmed.length > 0) {
      const unique = Array.from(
        new Map(confirmed.map((link) => [link.saleRecordId, link])).values()
      );
      byReceipt.set(claim.receiptId, unique);
      confirmedAllocationLinkCount += unique.length;
      continue;
    }

    if (!claim.externalCreatedAt || !claim.raw || claim.raw.items.length === 0) {
      unlinkedReceiptIds.add(claim.receiptId);
      continue;
    }

    const selected: ClaimLink[] = [];
    const consumedSaleIds = new Set<number>();
    let ambiguous = false;

    for (const item of claim.raw.items) {
      const vendorItemId = claimItemVendorId(item);
      const desiredCount = Math.max(0, Math.trunc(item.cancelCount));

      if (!vendorItemId || desiredCount === 0) {
        ambiguous = true;
        continue;
      }

      const candidateKey = claim.externalShipmentId
        ? [
            claim.externalOrderId ?? "",
            claim.externalShipmentId,
            vendorItemId,
          ].join("\u0000")
        : [claim.externalOrderId ?? "", vendorItemId].join("\u0000");
      const candidatePool = claim.externalShipmentId
        ? salesByExactExternalKey.get(candidateKey) ?? []
        : salesByOrderVendorKey.get(candidateKey) ?? [];
      const candidates = candidatePool.filter((sale) => {
        if (consumedSaleIds.has(sale.saleRecordId)) {
          return false;
        }

        const elapsed = claim.externalCreatedAt!.getTime() - sale.soldDate.getTime();
        return elapsed >= 0 && elapsed <= 30 * DAY_MS;
      });

      if (candidates.length !== desiredCount) {
        ambiguous = true;
        continue;
      }

      for (const candidate of candidates) {
        consumedSaleIds.add(candidate.saleRecordId);
        selected.push({
          saleRecordId: candidate.saleRecordId,
          method: "UNIQUE_EXTERNAL_KEY",
          returnAllocationId: null,
        });
      }
    }

    if (ambiguous) {
      ambiguousReceiptIds.add(claim.receiptId);
    }

    if (selected.length > 0) {
      byReceipt.set(claim.receiptId, selected);
      uniqueExternalKeyLinkCount += selected.length;
    } else if (!ambiguous) {
      unlinkedReceiptIds.add(claim.receiptId);
    }
  }

  return {
    byReceipt,
    confirmedAllocationLinkCount,
    uniqueExternalKeyLinkCount,
    unlinkedReceiptIds,
    ambiguousReceiptIds,
  };
}

function withdrawalVendorItemIds(event: ReturnStatisticsEventInput) {
  const snapshot = snapshotFromFields(event);
  const serialized = snapshot.vendor_item_ids;

  if (!serialized) {
    return [];
  }

  try {
    const parsed = JSON.parse(serialized);
    return Array.isArray(parsed)
      ? Array.from(
          new Set(
            parsed
              .map(nullableText)
              .filter((value): value is string => value !== null)
          )
        )
      : [];
  } catch {
    return [];
  }
}

function matchWithdrawalOnlyEvents(
  events: ReturnStatisticsEventInput[],
  sales: PreparedSale[]
): WithdrawalOnlyMatch[] {
  const salesByOrderVendor = new Map<string, PreparedSale[]>();

  for (const sale of sales) {
    if (!sale.externalVendorItemId) {
      continue;
    }
    const key = [
      sale.externalOrderId,
      sale.externalVendorItemId,
    ].join("\u0000");
    const current = salesByOrderVendor.get(key) ?? [];
    current.push(sale);
    salesByOrderVendor.set(key, current);
  }

  return events.map((event) => {
    const vendorItemIds = withdrawalVendorItemIds(event);
    const selectedSaleIds = new Set<number>();
    let unique = Boolean(event.externalOrderId) && vendorItemIds.length > 0;

    for (const vendorItemId of vendorItemIds) {
      const key = [
        event.externalOrderId ?? "",
        vendorItemId,
      ].join("\u0000");
      const candidates = salesByOrderVendor.get(key) ?? [];

      if (
        candidates.length !== 1 ||
        selectedSaleIds.has(candidates[0].saleRecordId)
      ) {
        unique = false;
        break;
      }
      selectedSaleIds.add(candidates[0].saleRecordId);
    }

    return {
      event,
      saleRecordIds: unique ? Array.from(selectedSaleIds) : [],
    };
  });
}

function uniqueSales(
  saleIds: Iterable<number>,
  salesById: Map<number, PreparedSale>
) {
  return Array.from(new Set(saleIds)).flatMap((saleId): PreparedSale[] => {
    const sale = salesById.get(saleId);
    return sale ? [sale] : [];
  });
}

function dateInBounds(
  date: Date | null,
  bounds: StatisticsDateTimeBounds
) {
  return (
    date !== null &&
    date.getTime() >= bounds.fromInclusive.getTime() &&
    date.getTime() < bounds.toExclusive.getTime()
  );
}

function salesInRange(
  sales: PreparedSale[],
  bounds: StatisticsDateTimeBounds
) {
  return sales.filter((sale) => {
    const soldAt = sale.soldDate.getTime();
    return (
      soldAt >= bounds.fromInclusive.getTime() &&
      soldAt < bounds.toExclusive.getTime()
    );
  });
}

function qualifyingSaleIds(
  sales: PreparedSale[],
  claimsBySale: Map<number, PreparedReturnClaim[]>,
  days: number
) {
  const result = new Set<number>();

  for (const sale of sales) {
    const hasRequest = (claimsBySale.get(sale.saleRecordId) ?? []).some(
      (claim) => {
        if (!claim.externalCreatedAt) {
          return false;
        }

        const elapsed =
          claim.externalCreatedAt.getTime() - sale.soldDate.getTime();
        return elapsed >= 0 && elapsed <= days * DAY_MS;
      }
    );

    if (hasRequest) {
      result.add(sale.saleRecordId);
    }
  }

  return result;
}

function matureSales(
  sales: PreparedSale[],
  cutoffExclusive: Date,
  days: number
) {
  const cutoff = cutoffExclusive.getTime() - days * DAY_MS;
  return sales.filter((sale) => sale.soldDate.getTime() <= cutoff);
}

function cohortMetric(
  sales: PreparedSale[],
  claimsBySale: Map<number, PreparedReturnClaim[]>,
  cutoffExclusive: Date,
  days: number
) {
  const mature = matureSales(sales, cutoffExclusive, days);
  const qualifying = qualifyingSaleIds(mature, claimsBySale, days);
  return rateMetric(qualifying.size, mature.length, "아직 성숙한 판매가 없습니다.");
}

function latestInspectionByReturnAllocation(
  inspections: ReturnStatisticsInspectionInput[]
) {
  const result = new Map<number, ReturnStatisticsInspectionInput>();

  for (const inspection of inspections) {
    const previous = result.get(inspection.returnAllocationId);
    const previousAt = parseDate(previous?.checkedAt)?.getTime() ?? -1;
    const currentAt = parseDate(inspection.checkedAt)?.getTime() ?? -1;

    if (
      !previous ||
      currentAt > previousAt ||
      (currentAt === previousAt &&
        inspection.inspectionId > previous.inspectionId)
    ) {
      result.set(inspection.returnAllocationId, inspection);
    }
  }

  return result;
}

function approvalByReceipt(approvals: ReturnStatisticsApprovalInput[]) {
  const result = new Map<string, ReturnStatisticsApprovalInput>();

  for (const approval of approvals) {
    const previous = result.get(approval.externalReceiptId);
    const previousAt = parseDate(previous?.requestedAt)?.getTime() ?? Infinity;
    const currentAt = parseDate(approval.requestedAt)?.getTime() ?? Infinity;

    if (
      !previous ||
      currentAt < previousAt ||
      (currentAt === previousAt && approval.requestId < previous.requestId)
    ) {
      result.set(approval.externalReceiptId, approval);
    }
  }

  return result;
}

function inspectionRows(
  claims: PreparedReturnClaim[],
  links: Map<string, ClaimLink[]>,
  inspections: ReturnStatisticsInspectionInput[],
  salesById: Map<number, PreparedSale>
) {
  const latestInspections = latestInspectionByReturnAllocation(inspections);
  const bySale = new Map<number, InspectionResultRow>();

  for (const claim of claims) {
    if (claim.withdrawn) {
      continue;
    }

    for (const link of links.get(claim.receiptId) ?? []) {
      if (link.returnAllocationId === null) {
        continue;
      }

      const inspection = latestInspections.get(link.returnAllocationId);
      const sale = salesById.get(link.saleRecordId);

      if (!inspection || !sale || !inspection.inspectionResult) {
        continue;
      }

      const previous = bySale.get(sale.saleRecordId);
      const previousAt = parseDate(previous?.inspection.checkedAt)?.getTime() ?? -1;
      const currentAt = parseDate(inspection.checkedAt)?.getTime() ?? -1;

      if (!previous || currentAt >= previousAt) {
        bySale.set(sale.saleRecordId, { sale, claim, inspection });
      }
    }
  }

  return Array.from(bySale.values());
}

function inspectionCategory(result: string | null) {
  if (result === INSPECTION_RESULT.passed) {
    return "RECOVERED" as const;
  }
  if (result === INSPECTION_RESULT.hold) {
    return "HOLD" as const;
  }
  return "NON_SELLABLE" as const;
}

function reasonInspectionRows(
  claims: PreparedReturnClaim[],
  rows: InspectionResultRow[]
): ReturnReasonInspectionRow[] {
  const receiptIdsByReason = new Map<string, Set<string>>();
  const rowsByReason = new Map<string, InspectionResultRow[]>();

  for (const claim of claims) {
    const reason = claimReason(claim);
    const receiptIds = receiptIdsByReason.get(reason) ?? new Set<string>();
    receiptIds.add(claim.receiptId);
    receiptIdsByReason.set(reason, receiptIds);
  }

  for (const row of rows) {
    const reason = claimReason(row.claim);
    const current = rowsByReason.get(reason) ?? [];
    current.push(row);
    rowsByReason.set(reason, current);
  }

  return Array.from(receiptIdsByReason.keys())
    .map((reason) => {
      const inspectionRowsForReason = rowsByReason.get(reason) ?? [];
      const categories = inspectionRowsForReason.map((row) =>
        inspectionCategory(row.inspection.inspectionResult)
      );

      return {
        reason,
        receiptCount: receiptIdsByReason.get(reason)?.size ?? 0,
        confirmedInspectionPgCount: inspectionRowsForReason.length,
        recoveredCount: categories.filter((value) => value === "RECOVERED").length,
        nonSellableCount: categories.filter(
          (value) => value === "NON_SELLABLE"
        ).length,
        holdCount: categories.filter((value) => value === "HOLD").length,
        appearanceDefects: countGroups(
          inspectionRowsForReason
            .map((row) => nullableText(row.inspection.appearanceDefect))
            .filter((value): value is string => value !== null)
        ),
        functionDefects: countGroups(
          inspectionRowsForReason
            .map((row) => nullableText(row.inspection.functionDefect))
            .filter((value): value is string => value !== null)
        ),
      };
    })
    .sort(
      (left, right) =>
        right.receiptCount - left.receiptCount ||
        left.reason.localeCompare(right.reason, "ko-KR")
    );
}

function occurrenceTrend(
  claims: PreparedReturnClaim[],
  links: Map<string, ClaimLink[]>,
  salesById: Map<number, PreparedSale>
): ReturnOccurrenceTrendRow[] {
  const byMonth = new Map<string, PreparedReturnClaim[]>();

  for (const claim of claims) {
    if (!claim.externalCreatedAt) {
      continue;
    }
    const key = monthKey(claim.externalCreatedAt);
    const current = byMonth.get(key) ?? [];
    current.push(claim);
    byMonth.set(key, current);
  }

  return Array.from(byMonth)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([receiptMonth, rows]) => {
      const linkedSales = uniqueSales(
        rows.flatMap((claim) =>
          (links.get(claim.receiptId) ?? []).map((link) => link.saleRecordId)
        ),
        salesById
      );

      return {
        receiptMonth,
        receiptCount: rows.length,
        returnQuantity: rows.reduce((sum, row) => sum + row.quantity, 0),
        linkedSaleRecordCount: linkedSales.length,
        completedReceiptCount: rows.filter(
          (row) =>
            isTerminalCoupangReturnStatus(row.receiptStatus) &&
            !row.withdrawn
        ).length,
        withdrawnReceiptCount: rows.filter((row) => row.withdrawn).length,
        associatedSalesAmount: amountMetric(
          linkedSales,
          (sale) => sale.salesPrice
        ),
      };
    });
}

function cohortTrend(
  sales: PreparedSale[],
  claimsBySale: Map<number, PreparedReturnClaim[]>,
  cutoffExclusive: Date
): ReturnCohortTrendRow[] {
  const byMonth = new Map<string, PreparedSale[]>();

  for (const sale of sales) {
    const key = monthKey(sale.soldDate);
    const current = byMonth.get(key) ?? [];
    current.push(sale);
    byMonth.set(key, current);
  }

  return Array.from(byMonth)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([saleMonth, rows]) => ({
      saleMonth,
      saleCount: rows.length,
      day7: cohortMetric(rows, claimsBySale, cutoffExclusive, 7),
      day14: cohortMetric(rows, claimsBySale, cutoffExclusive, 14),
      day30: cohortMetric(rows, claimsBySale, cutoffExclusive, 30),
    }));
}

function faultShare(claims: PreparedReturnClaim[]) {
  const known = claims.filter(
    (claim) => claim.faultType && KNOWN_FAULT_TYPES.has(claim.faultType)
  );
  return rateMetric(
    known.filter((claim) => claim.faultType === "VENDOR").length,
    known.length,
    "귀책이 확인된 반품 접수가 없습니다."
  );
}

function recoveryRate(rows: InspectionResultRow[]) {
  return rateMetric(
    rows.filter(
      (row) =>
        inspectionCategory(row.inspection.inspectionResult) === "RECOVERED"
    ).length,
    rows.length,
    "확정된 반품 검수 표본이 없습니다."
  );
}

function productKey(sale: PreparedSale) {
  return [sale.model ?? "", sale.storage ?? "", sale.saleGrade ?? ""].join(
    "\u0000"
  );
}

function productRows(input: {
  currentSales: PreparedSale[];
  previousSales: PreparedSale[];
  claimsBySale: Map<number, PreparedReturnClaim[]>;
  links: Map<string, ClaimLink[]>;
  inspections: InspectionResultRow[];
  salesById: Map<number, PreparedSale>;
}) {
  const keys = new Set(
    [...input.currentSales, ...input.previousSales].map(productKey)
  );
  const inspectionsBySale = new Map(
    input.inspections.map((row) => [row.sale.saleRecordId, row])
  );

  return Array.from(keys).map((key): ReturnProductComparisonRow => {
    const current = input.currentSales.filter((sale) => productKey(sale) === key);
    const previous = input.previousSales.filter(
      (sale) => productKey(sale) === key
    );
    const currentReturned = qualifyingSaleIds(current, input.claimsBySale, 30);
    const previousReturned = qualifyingSaleIds(previous, input.claimsBySale, 30);
    const currentRate = rateMetric(
      currentReturned.size,
      current.length,
      "현재 성숙 cohort 판매가 없습니다."
    );
    const previousRate = rateMetric(
      previousReturned.size,
      previous.length,
      "직전 성숙 cohort 판매가 없습니다."
    );
    const returnedSales = uniqueSales(currentReturned, input.salesById);
    const returnedClaims = Array.from(currentReturned).flatMap(
      (saleId) => input.claimsBySale.get(saleId) ?? []
    );
    const confirmedInspections = Array.from(currentReturned).flatMap(
      (saleId): InspectionResultRow[] => {
        const row = inspectionsBySale.get(saleId);
        return row ? [row] : [];
      }
    );
    const sample = current[0] ?? previous[0];

    return {
      key,
      model: sample?.model ?? "미확인",
      storage: sample?.storage ?? "미확인",
      saleGrade: sample?.saleGrade ?? "미확인",
      matureSalesCount: current.length,
      returnSaleRecordCount: currentReturned.size,
      requestRate30Day: currentRate,
      previousCohortDeltaPercentagePoints:
        currentRate.value === null || previousRate.value === null
          ? null
          : round(currentRate.value - previousRate.value),
      associatedSalesAmount: amountMetric(
        returnedSales,
        (sale) => sale.salesPrice
      ),
      vendorFaultShare: faultShare(
        Array.from(
          new Map(
            returnedClaims.map((claim) => [claim.receiptId, claim])
          ).values()
        )
      ),
      resaleRecoveryRate: recoveryRate(confirmedInspections),
    };
  }).sort(
    (left, right) =>
      right.matureSalesCount - left.matureSalesCount ||
      left.model.localeCompare(right.model, "ko-KR") ||
      left.storage.localeCompare(right.storage, "ko-KR") ||
      left.saleGrade.localeCompare(right.saleGrade, "ko-KR")
  );
}

function cancellationStatistics(
  claims: PreparedReturnClaim[]
): PreShipmentCancellationStatistics {
  const trend = new Map<string, { receipts: number; quantity: number }>();
  const productValues: Array<{ label: string | null; count: number }> = [];

  for (const claim of claims) {
    if (claim.externalCreatedAt) {
      const key = monthKey(claim.externalCreatedAt);
      const current = trend.get(key) ?? { receipts: 0, quantity: 0 };
      current.receipts += 1;
      current.quantity += claim.quantity;
      trend.set(key, current);
    }

    if (claim.raw?.items.length) {
      for (const item of claim.raw.items) {
        productValues.push({
          label:
            item.vendorItemName ??
            item.externalVendorItemId ??
            item.sellerProductItemId,
          count: Math.max(0, item.cancelCount),
        });
      }
    } else {
      productValues.push({ label: null, count: claim.quantity });
    }
  }

  return {
    receiptCount: claims.length,
    cancellationQuantity: claims.reduce(
      (sum, claim) => sum + claim.quantity,
      0
    ),
    occurrenceTrend: Array.from(trend)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([receiptMonth, value]) => ({
        receiptMonth,
        receiptCount: value.receipts,
        cancellationQuantity: value.quantity,
      })),
    reasons: countGroups(claims.map(claimReason)),
    products: weightedGroups(productValues),
  };
}

function exchangeStatistics(
  exchanges: PreparedExchangeClaim[],
  cutoffExclusive?: Date
): ExchangeStatistics {
  const trend = new Map<string, number>();
  const terminalHours: number[] = [];
  let negativeDurationCount = 0;

  for (const exchange of exchanges) {
    if (exchange.externalCreatedAt) {
      const key = monthKey(exchange.externalCreatedAt);
      trend.set(key, (trend.get(key) ?? 0) + 1);
    }

    if (
      exchange.status &&
      isTerminalCoupangExchangeStatus(exchange.status) &&
      exchange.externalCreatedAt &&
      exchange.externalModifiedAt &&
      (!cutoffExclusive ||
        exchange.externalModifiedAt.getTime() <
          cutoffExclusive.getTime())
    ) {
      const hours =
        (exchange.externalModifiedAt.getTime() -
          exchange.externalCreatedAt.getTime()) /
        (60 * 60 * 1000);

      if (hours < 0) {
        negativeDurationCount += 1;
      } else {
        terminalHours.push(hours);
      }
    }
  }

  return {
    receiptCount: exchanges.length,
    occurrenceTrend: Array.from(trend)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, value]) => ({ label, value })),
    reasons: countGroups(
      exchanges.map(
        (exchange) =>
          exchange.reasonLabel ??
          exchange.reasonCode ??
          "미확인"
      )
    ),
    faults: countGroups(exchanges.map((exchange) => exchange.faultType)),
    results: countGroups(
      exchanges.map((exchange) =>
        exchange.status && isTerminalCoupangExchangeStatus(exchange.status)
          ? exchange.status
          : "OTHER"
      )
    ),
    terminalLeadTime: durationMetric(terminalHours, negativeDurationCount),
  };
}

export function aggregateReturnStatistics(
  input: ReturnStatisticsAggregateInput,
  options: {
    now?: Date;
    period?: StatisticsPeriodContext;
  } = {}
): ReturnStatisticsData {
  const now = options.now ?? quickHackClock.nowDate();
  const period =
    options.period ?? resolveClosedStatisticsPeriod({ now });
  const periodBounds = statisticsDateTimeBounds(period.range);
  const previousPeriodBounds = statisticsDateTimeBounds(
    period.previousRange
  );
  const cutoffExclusive = statisticsDateTimeBounds({
    fromDate: period.dataCutoffDate,
    toDate: period.dataCutoffDate,
  }).toExclusive;
  const cutoffEvents = input.events.filter((event) => {
    const detectedAt = parseDate(event.detectedAt);
    return (
      detectedAt !== null &&
      detectedAt.getTime() < cutoffExclusive.getTime()
    );
  });
  const cutoffInput = {
    ...input,
    events: cutoffEvents,
  };
  const sales = prepareSales(input).filter(
    (sale) => sale.soldDate.getTime() < cutoffExclusive.getTime()
  );
  const { returns: allClaims, exchanges: allExchanges, withdrawalOnlyEvents } =
    prepareClaims(cutoffInput);
  const returnClaims = allClaims.filter((claim) => claim.receiptType === "RETURN");
  const cancellationClaims = allClaims.filter(
    (claim) => claim.receiptType === "CANCEL"
  );
  const links = buildClaimLinks(returnClaims, sales, cutoffInput);
  const withdrawalOnlyMatches = matchWithdrawalOnlyEvents(
    withdrawalOnlyEvents,
    sales
  );
  const cutoffInspections = input.inspections.filter((inspection) => {
    const checkedAt = parseDate(inspection.checkedAt);
    return (
      checkedAt !== null &&
      checkedAt.getTime() < cutoffExclusive.getTime()
    );
  });
  const cutoffApprovals = input.approvals.filter((approval) => {
    const requestedAt = parseDate(approval.requestedAt);
    return (
      requestedAt !== null &&
      requestedAt.getTime() < cutoffExclusive.getTime()
    );
  });
  const salesById = new Map(sales.map((sale) => [sale.saleRecordId, sale]));
  const filteredSales = salesInRange(sales, periodBounds);
  const previousSales = salesInRange(sales, previousPeriodBounds);
  const filteredReturns = returnClaims.filter(
    (claim) => dateInBounds(claim.externalCreatedAt, periodBounds)
  );
  const filteredReturnIds = new Set(
    filteredReturns.map((claim) => claim.receiptId)
  );
  const filteredCancellations = cancellationClaims.filter(
    (claim) => dateInBounds(claim.externalCreatedAt, periodBounds)
  );
  const filteredExchanges = allExchanges.filter(
    (exchange) => dateInBounds(exchange.externalCreatedAt, periodBounds)
  );
  const filteredWithdrawalOnlyMatches = withdrawalOnlyMatches.filter(
    (match) => dateInBounds(parseDate(match.event.detectedAt), periodBounds)
  );
  const filteredWithdrawalOnlyEventIds = new Set(
    filteredWithdrawalOnlyMatches.map((match) => match.event.eventId)
  );
  const filteredCancellationIds = new Set(
    filteredCancellations.map((claim) => claim.receiptId)
  );
  const filteredExchangeIds = new Set(
    filteredExchanges.map((claim) => claim.exchangeId)
  );
  const filteredLinks = new Map<string, ClaimLink[]>();

  for (const claim of filteredReturns) {
    const claimLinks = links.byReceipt.get(claim.receiptId) ?? [];
    if (claimLinks.length > 0) {
      filteredLinks.set(claim.receiptId, claimLinks);
    }
  }

  const claimsBySale = new Map<number, PreparedReturnClaim[]>();

  for (const claim of returnClaims) {
    if (
      claim.externalCreatedAt === null ||
      claim.externalCreatedAt.getTime() >= cutoffExclusive.getTime()
    ) {
      continue;
    }
    for (const link of links.byReceipt.get(claim.receiptId) ?? []) {
      const current = claimsBySale.get(link.saleRecordId) ?? [];
      current.push(claim);
      claimsBySale.set(link.saleRecordId, current);
    }
  }

  let claimBeforeSaleCount = 0;
  let claimAfterThirtyDaysCount = 0;

  for (const claim of filteredReturns) {
    if (!claim.externalCreatedAt) {
      continue;
    }
    for (const link of filteredLinks.get(claim.receiptId) ?? []) {
      const sale = salesById.get(link.saleRecordId);
      if (!sale) {
        continue;
      }
      const elapsed =
        claim.externalCreatedAt.getTime() - sale.soldDate.getTime();
      if (elapsed < 0) {
        claimBeforeSaleCount += 1;
      } else if (elapsed > 30 * DAY_MS) {
        claimAfterThirtyDaysCount += 1;
      }
    }
  }

  const currentSales = matureSales(
    filteredSales,
    cutoffExclusive,
    30
  );
  const maturePreviousSales = matureSales(
    previousSales,
    cutoffExclusive,
    30
  );
  const currentReturned = qualifyingSaleIds(
    currentSales,
    claimsBySale,
    30
  );
  const previousReturned = qualifyingSaleIds(
    maturePreviousSales,
    claimsBySale,
    30
  );
  const requestRate30Day = rateMetric(
    currentReturned.size,
    currentSales.length,
    "아직 완전히 성숙한 최근 30일 판매 cohort가 없습니다."
  );
  const previousRequestRate30Day = rateMetric(
    previousReturned.size,
    maturePreviousSales.length,
    "비교할 직전 성숙 30일 판매 cohort가 없습니다."
  );
  const linkedSales = uniqueSales(
    filteredReturns.flatMap((claim) =>
      (filteredLinks.get(claim.receiptId) ?? []).map(
        (link) => link.saleRecordId
      )
    ),
    salesById
  );
  const inspections = inspectionRows(
    filteredReturns,
    filteredLinks,
    cutoffInspections,
    salesById
  );
  const cohortInspections = inspectionRows(
    returnClaims,
    links.byReceipt,
    cutoffInspections,
    salesById
  );
  const categories = inspections.map((row) =>
    inspectionCategory(row.inspection.inspectionResult)
  );
  const approvalMap = approvalByReceipt(cutoffApprovals);
  const syncDelayHours: number[] = [];
  const approvalHours: number[] = [];
  const finalizationHours: number[] = [];
  let negativeSyncDurationCount = 0;
  let negativeApprovalDurationCount = 0;
  let negativeFinalizationDurationCount = 0;

  for (const claim of filteredReturns) {
    if (claim.externalCreatedAt) {
      const hours =
        (claim.observedAt.getTime() - claim.externalCreatedAt.getTime()) /
        (60 * 60 * 1000);
      if (hours < 0) {
        negativeSyncDurationCount += 1;
      } else {
        syncDelayHours.push(hours);
      }
    }

    const approval = approvalMap.get(claim.receiptId);
    const requestedAt = parseDate(approval?.requestedAt);
    const parsedFinalizedAt = parseDate(approval?.localFinalizedAt);
    const finalizedAt =
      parsedFinalizedAt &&
      parsedFinalizedAt.getTime() < cutoffExclusive.getTime()
        ? parsedFinalizedAt
        : null;

    if (requestedAt) {
      const hours =
        (requestedAt.getTime() - claim.observedAt.getTime()) /
        (60 * 60 * 1000);
      if (hours < 0) {
        negativeApprovalDurationCount += 1;
      } else {
        approvalHours.push(hours);
      }
    }

    if (finalizedAt) {
      const hours =
        (finalizedAt.getTime() - claim.observedAt.getTime()) /
        (60 * 60 * 1000);
      if (hours < 0) {
        negativeFinalizationDurationCount += 1;
      } else {
        finalizationHours.push(hours);
      }
    }
  }

  const globalEventDates = cutoffEvents
    .map((event) => parseDate(event.detectedAt))
    .filter((value): value is Date => value !== null)
    .sort((left, right) => left.getTime() - right.getTime());
  const filteredEventDates = cutoffEvents
    .filter((event) => {
      const logicalId =
        event.externalReceiptId ??
        event.externalExchangeId ??
        event.sourcePk;
      return (
        filteredReturnIds.has(logicalId) ||
        filteredCancellationIds.has(logicalId) ||
        filteredExchangeIds.has(logicalId) ||
        filteredWithdrawalOnlyEventIds.has(event.eventId)
      );
    })
    .map((event) => parseDate(event.detectedAt))
    .filter((value): value is Date => value !== null)
    .sort((left, right) => left.getTime() - right.getTime());
  const missingOrInvalidExternalTimestampCount = [
    ...returnClaims,
    ...cancellationClaims,
  ].filter((claim) => claim.externalCreatedAt === null).length +
    allExchanges.filter(
      (exchange) => exchange.externalCreatedAt === null
    ).length;
  const linkedSaleRecordCount = new Set(
    Array.from(filteredLinks.values()).flatMap((claimLinks) =>
      claimLinks.map((link) => link.saleRecordId)
    )
  ).size;
  const linkedReceiptCount = filteredReturns.filter(
    (claim) => (filteredLinks.get(claim.receiptId) ?? []).length > 0
  ).length;
  const withdrawnReceiptCount = filteredReturns.filter(
    (claim) => claim.withdrawn
  ).length;
  const currentProductRows = productRows({
    currentSales,
    previousSales: maturePreviousSales,
    claimsBySale,
    links: links.byReceipt,
    inspections: cohortInspections,
    salesById,
  });
  const externalFaults = filteredReturns.map((claim) => claim.faultType);
  const economicRecoveredRows = inspections
    .filter(
      (row) =>
        inspectionCategory(row.inspection.inspectionResult) === "RECOVERED"
    )
    .map((row) => row.sale);
  const economicNonSellableRows = inspections
    .filter(
      (row) =>
        inspectionCategory(row.inspection.inspectionResult) !== "RECOVERED"
    )
    .map((row) => row.sale);
  const unmatchedWithdrawalCount = filteredWithdrawalOnlyMatches.filter(
    (match) => match.saleRecordIds.length === 0
  ).length;
  const withdrawalOnlyUniqueLinkCount = filteredWithdrawalOnlyMatches.reduce(
    (sum, match) => sum + match.saleRecordIds.length,
    0
  );
  const exchangeResult = exchangeStatistics(
    filteredExchanges,
    cutoffExclusive
  );
  const negativeDurationCount =
    negativeSyncDurationCount +
    negativeApprovalDurationCount +
    negativeFinalizationDurationCount +
    exchangeResult.terminalLeadTime.excludedAnomalyCount;

  return {
    generatedAt: now.toISOString(),
    calculation: liveStatisticsCalculationMetadata(period),
    source: {
      eventRecordingStartedAt: globalEventDates[0]?.toISOString() ?? null,
      lastClaimEventAt: filteredEventDates.at(-1)?.toISOString() ?? null,
      claimEventCount: filteredEventDates.length,
      observedReturnReceiptCount: filteredReturns.length,
      observedCancellationReceiptCount: filteredCancellations.length,
      observedExchangeCount: filteredExchanges.length,
      confirmedAllocationLinkCount: Array.from(filteredLinks.values())
        .flat()
        .filter((link) => link.method === "CONFIRMED").length,
      uniqueExternalKeyLinkCount: Array.from(filteredLinks.values())
        .flat()
        .filter((link) => link.method === "UNIQUE_EXTERNAL_KEY").length +
        withdrawalOnlyUniqueLinkCount,
      linkedSaleRecordCount,
      unlinkedReceiptCount: filteredReturns.filter((claim) =>
        links.unlinkedReceiptIds.has(claim.receiptId)
      ).length,
      ambiguousReceiptCount: filteredReturns.filter((claim) =>
        links.ambiguousReceiptIds.has(claim.receiptId)
      ).length,
      cohortSalesCount: filteredSales.length,
      salesPriceAvailableCount: filteredSales.filter(
        (sale) => sale.salesPrice !== null
      ).length,
      salesPriceCoveragePercent: percentage(
        filteredSales.filter((sale) => sale.salesPrice !== null).length,
        filteredSales.length
      ),
      purchasePriceAvailableCount: filteredSales.filter(
        (sale) => sale.purchasePrice !== null
      ).length,
      purchasePriceCoveragePercent: percentage(
        filteredSales.filter((sale) => sale.purchasePrice !== null).length,
        filteredSales.length
      ),
      confirmedInspectionPgCount: inspections.length,
      unmatchedWithdrawalCount,
      missingOrInvalidExternalTimestampCount,
      claimBeforeSaleCount,
      claimAfterThirtyDaysCount,
      negativeDurationCount,
    },
    summary: {
      requestRate30Day,
      previousRequestRate30Day,
      previousCohortDeltaPercentagePoints:
        requestRate30Day.value === null ||
        previousRequestRate30Day.value === null
          ? null
          : round(
              requestRate30Day.value - previousRequestRate30Day.value
            ),
      associatedSalesAmount: amountMetric(
        linkedSales,
        (sale) => sale.salesPrice
      ),
      vendorFaultShare: faultShare(filteredReturns),
      resaleRecoveryRate: recoveryRate(inspections),
    },
    overview: {
      receiptCount: filteredReturns.length,
      returnQuantity: filteredReturns.reduce(
        (sum, claim) => sum + claim.quantity,
        0
      ),
      linkedReceiptCount,
      linkedSaleRecordCount,
      completedReceiptCount: filteredReturns.filter(
        (claim) =>
          isTerminalCoupangReturnStatus(claim.receiptStatus) &&
          !claim.withdrawn
      ).length,
      withdrawnReceiptCount,
      receiptLinkRate: rateMetric(
        linkedReceiptCount,
        filteredReturns.length,
        "조회 조건에 해당하는 고객 반품 접수가 없습니다."
      ),
      withdrawalShare: rateMetric(
        withdrawnReceiptCount,
        filteredReturns.length,
        "조회 조건에 해당하는 고객 반품 접수가 없습니다."
      ),
    },
    cohortTrend: cohortTrend(
      filteredSales,
      claimsBySale,
      cutoffExclusive
    ),
    occurrenceTrend: occurrenceTrend(
      filteredReturns,
      filteredLinks,
      salesById
    ),
    productRows: currentProductRows,
    reasons: countGroups(filteredReturns.map(claimReason)),
    faults: countGroups(externalFaults),
    reasonInspectionMatrix: reasonInspectionRows(
      filteredReturns,
      inspections
    ),
    inspectionOutcome: {
      linkedReturnPgCount: linkedSaleRecordCount,
      confirmedInspectionPgCount: inspections.length,
      recoveredCount: categories.filter((value) => value === "RECOVERED").length,
      nonSellableCount: categories.filter(
        (value) => value === "NON_SELLABLE"
      ).length,
      holdCount: categories.filter((value) => value === "HOLD").length,
      recoveryRate: recoveryRate(inspections),
    },
    economicImpact: {
      associatedSalesAmount: amountMetric(
        linkedSales,
        (sale) => sale.salesPrice
      ),
      associatedPurchaseCost: amountMetric(
        linkedSales,
        (sale) => sale.purchasePrice
      ),
      recoveredAssetCost: amountMetric(
        economicRecoveredRows,
        (sale) => sale.purchasePrice
      ),
      nonSellableOrHoldAssetCost: amountMetric(
        economicNonSellableRows,
        (sale) => sale.purchasePrice
      ),
    },
    leadTimes: {
      externalReceiptToObservation: durationMetric(
        syncDelayHours,
        negativeSyncDurationCount
      ),
      observationToApprovalRequest: durationMetric(
        approvalHours,
        negativeApprovalDurationCount
      ),
      observationToLocalFinalization: durationMetric(
        finalizationHours,
        negativeFinalizationDurationCount
      ),
    },
    preShipmentCancellations: cancellationStatistics(
      filteredCancellations
    ),
    exchanges: exchangeResult,
  };
}

export async function loadReturnStatisticsInput(
  prisma: PrismaClient
): Promise<ReturnStatisticsAggregateInput> {
  const [
    sales,
    events,
    returnRaws,
    allocationLinks,
    inspections,
    approvals,
  ] = await Promise.all([
    loadStatisticsCursorPages({
      loadPage: (cursor, take) =>
        prisma.sales_records.findMany({
          where: {
            sale_status: { in: ["SOLD", "RETURNED"] },
          },
          select: {
            sale_record_id: true,
            allocation_id: true,
            pg_no: true,
            channel: true,
            external_order_id: true,
            external_shipment_id: true,
            external_vendor_item_id: true,
            sold_at: true,
            sale_status: true,
            sales_price: true,
            purchase_price: true,
            model: true,
            storage: true,
            sale_grade: true,
            allocation: {
              select: {
                vendor_item_name: true,
                seller_product_name: true,
                seller_product_item_name: true,
                option_name: true,
              },
            },
          },
          orderBy: { sale_record_id: "asc" },
          take,
          ...(cursor === undefined
            ? {}
            : {
                cursor: { sale_record_id: cursor },
                skip: 1,
              }),
        }),
      getCursor: (row) => row.sale_record_id,
    }),
    loadStatisticsCursorPages({
      loadPage: (cursor, take) =>
        prisma.coupang_raw_change_event.findMany({
          where: {
            event_type: { in: [...CLAIM_EVENT_TYPES] },
          },
          select: {
            coupang_raw_change_event_id: true,
            source_pk: true,
            external_order_id: true,
            external_shipment_id: true,
            external_receipt_id: true,
            external_exchange_id: true,
            event_type: true,
            detected_at: true,
            fields: {
              select: {
                field_name: true,
                after_value: true,
              },
              orderBy: { field_name: "asc" },
            },
          },
          orderBy: { coupang_raw_change_event_id: "asc" },
          take,
          ...(cursor === undefined
            ? {}
            : {
                cursor: { coupang_raw_change_event_id: cursor },
                skip: 1,
              }),
        }),
      getCursor: (row) => row.coupang_raw_change_event_id,
    }),
    loadStatisticsCursorPages({
      loadPage: (cursor, take) =>
        prisma.coupang_return_raw.findMany({
          select: {
            coupang_return_raw_id: true,
            external_receipt_id: true,
            external_order_id: true,
            external_shipment_id: true,
            cancel_type: true,
            cancel_count: true,
            items: {
              select: {
                external_vendor_item_id: true,
                seller_product_item_id: true,
                vendor_item_name: true,
                cancel_count: true,
              },
              orderBy: { coupang_return_raw_item_id: "asc" },
            },
          },
          orderBy: { coupang_return_raw_id: "asc" },
          take,
          ...(cursor === undefined
            ? {}
            : {
                cursor: { coupang_return_raw_id: cursor },
                skip: 1,
              }),
        }),
      getCursor: (row) => row.coupang_return_raw_id,
    }),
    loadStatisticsCursorPages({
      loadPage: (cursor, take) =>
        prisma.coupang_return_allocation.findMany({
          select: {
            coupang_return_allocation_id: true,
            coupang_return_raw_id: true,
            allocation_id: true,
            external_receipt_id: true,
            pg_no: true,
            action_type: true,
          },
          orderBy: { coupang_return_allocation_id: "asc" },
          take,
          ...(cursor === undefined
            ? {}
            : {
                cursor: { coupang_return_allocation_id: cursor },
                skip: 1,
              }),
        }),
      getCursor: (row) => row.coupang_return_allocation_id,
    }),
    loadStatisticsCursorPages({
      loadPage: (cursor, take) =>
        prisma.inspections.findMany({
          where: {
            inspection_type: INSPECTION_TYPE.returnCheck,
            source_type: INSPECTION_SOURCE_TYPE.coupangReturn,
            coupang_return_allocation_id: { not: null },
          },
          select: {
            inspection_id: true,
            coupang_return_allocation_id: true,
            pg_no: true,
            inspection_result: true,
            checked_at: true,
            appearance_defect: true,
            function_defect: true,
          },
          orderBy: { inspection_id: "asc" },
          take,
          ...(cursor === undefined
            ? {}
            : {
                cursor: { inspection_id: cursor },
                skip: 1,
              }),
        }),
      getCursor: (row) => row.inspection_id,
    }),
    loadStatisticsCursorPages({
      loadPage: (cursor, take) =>
        prisma.sales_channel_write_requests.findMany({
          where: {
            channel: "COUPANG",
            request_type: SALES_CHANNEL_WRITE_REQUEST_TYPE.returnApproval,
          },
          select: {
            sales_channel_write_request_id: true,
            target_external_id: true,
            source_entity_id: true,
            requested_at: true,
            local_finalized_at: true,
          },
          orderBy: { sales_channel_write_request_id: "asc" },
          take,
          ...(cursor === undefined
            ? {}
            : {
                cursor: { sales_channel_write_request_id: cursor },
                skip: 1,
              }),
        }),
      getCursor: (row) => row.sales_channel_write_request_id,
    }),
  ]);

  return {
    sales: sales.map((sale) => ({
      saleRecordId: sale.sale_record_id,
      allocationId: sale.allocation_id,
      pgNo: sale.pg_no,
      channel: sale.channel,
      externalOrderId: sale.external_order_id,
      externalShipmentId: sale.external_shipment_id,
      externalVendorItemId: sale.external_vendor_item_id,
      soldAt: requiredApiDateTime(sale.sold_at),
      saleStatus: sale.sale_status,
      salesPrice: sale.sales_price,
      purchasePrice: sale.purchase_price,
      model: sale.model,
      storage: sale.storage,
      saleGrade: sale.sale_grade,
      productNames: [
        sale.allocation.vendor_item_name,
        sale.allocation.seller_product_name,
        sale.allocation.seller_product_item_name,
        sale.allocation.option_name,
      ].filter((value): value is string => Boolean(value)),
    })),
    events: events.map((event) => ({
      eventId: event.coupang_raw_change_event_id,
      sourcePk: event.source_pk,
      externalOrderId: event.external_order_id,
      externalShipmentId: event.external_shipment_id,
      externalReceiptId: event.external_receipt_id,
      externalExchangeId: event.external_exchange_id,
      eventType: event.event_type,
      detectedAt: requiredApiDateTime(event.detected_at),
      fields: event.fields.map((field) => ({
        fieldName: field.field_name,
        afterValue: field.after_value,
      })),
    })),
    returnRaws: returnRaws.map((raw) => ({
      returnRawId: raw.coupang_return_raw_id,
      externalReceiptId: raw.external_receipt_id,
      externalOrderId: raw.external_order_id,
      externalShipmentId: raw.external_shipment_id,
      cancelType: raw.cancel_type,
      cancelCount: raw.cancel_count,
      items: raw.items.map((item) => ({
        externalVendorItemId: item.external_vendor_item_id,
        sellerProductItemId: item.seller_product_item_id,
        vendorItemName: item.vendor_item_name,
        cancelCount: item.cancel_count,
      })),
    })),
    allocationLinks: allocationLinks.map((link) => ({
      returnAllocationId: link.coupang_return_allocation_id,
      returnRawId: link.coupang_return_raw_id,
      allocationId: link.allocation_id,
      externalReceiptId: link.external_receipt_id,
      pgNo: link.pg_no,
      actionType: link.action_type,
    })),
    inspections: inspections.flatMap((inspection) =>
      inspection.coupang_return_allocation_id === null
        ? []
        : [
            {
              inspectionId: inspection.inspection_id,
              returnAllocationId: inspection.coupang_return_allocation_id,
              pgNo: inspection.pg_no,
              inspectionResult: inspection.inspection_result,
              checkedAt: apiDateTime(inspection.checked_at),
              appearanceDefect: inspection.appearance_defect,
              functionDefect: inspection.function_defect,
            },
          ]
    ),
    approvals: approvals.flatMap((approval) => {
      const receiptId =
        approval.target_external_id ?? approval.source_entity_id;
      return receiptId
        ? [
            {
              requestId: approval.sales_channel_write_request_id,
              externalReceiptId: receiptId,
              requestedAt: requiredApiDateTime(approval.requested_at),
              localFinalizedAt: apiDateTime(approval.local_finalized_at),
            },
          ]
        : [];
    }),
  };
}

export async function getReturnStatisticsData(
  prisma: PrismaClient,
  options: { now?: Date; period?: StatisticsPeriodContext } = {}
) {
  const input = await loadReturnStatisticsInput(prisma);
  return aggregateReturnStatistics(input, {
    now: options.now,
    period: options.period,
  });
}
