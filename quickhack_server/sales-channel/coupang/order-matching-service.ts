// QuickHack note: 수집된 쿠팡 주문 아이템을 판매 상품 조합과 실제 PG 재고에 매칭하는 서비스입니다.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { isPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { findInventoryCandidatesForSalesOffer } from "@/quickhack_server/catalog/sales-offer-candidate-service";
import { getCoupangRuntimeConfig } from "@/quickhack_server/sales-channel/coupang/config";
import {
  failCoupangMatchingCycleInventoryVerification,
  prepareCoupangMatchingCycleInventoryVerification,
  runCoupangMatchingCycleInventoryVerification,
} from "@/quickhack_server/sales-channel/coupang/inventory-verification-cycle-service";
import type { InventoryVerificationDependencies } from "@/quickhack_server/sales-channel/coupang/inventory-verification-service";
import {
  refreshCoupangOrderAddressesAfterInstruct,
  type CoupangOrderAddressRefreshResult,
} from "@/quickhack_server/sales-channel/coupang/write-verification-service";
import {
  requestSalesChannelWrite,
  SalesChannelWriteReviewRequiredError,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-service";
import { recoverSalesChannelLocalFinalization } from "@/quickhack_server/sales-channel/write/sales-channel-write-review-service";
import { finalizePersistedCoupangOrderInstruct } from "@/quickhack_server/sales-channel/coupang/order-instruct-finalizer";
import { getSalesOfferOrderMatchingPolicy } from "@/quickhack_server/sales-channel/order-matching-policy-service";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { parseKstSqlDateTime } from "@/quickhack_shared/core/time";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_TRANSITION_POLICY } from "@/quickhack_shared/inventory/inventory-write-rules";
import {
  ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
  INVENTORY_MATCH_FAILURE_REASONS,
  INVENTORY_MATCH_STATUSES,
} from "@/quickhack_shared/sales-channel/order-matching";
import {
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
} from "@/quickhack_shared/sales-channel/write-requests";
import {
  assertWorkerLeaseActive,
  requireOwnedWorkerLease,
  throwIfWorkerLeaseAborted,
} from "@/quickhack_server/workers/lease-guard";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { lockDeviceAggregates } from "@/quickhack_server/inventory/device-aggregate-lock";
import { hasActiveManualOrderMatchIntent } from "@/quickhack_server/sales-channel/coupang/manual-order-match-intent-service";
import {
  countActiveAllocationsForWorkItem,
  lockOrderMatchingWorkItem,
} from "@/quickhack_server/sales-channel/coupang/order-mapping-snapshot-service";

const COUPANG_CHANNEL = "COUPANG";
const DEFAULT_MATCH_LIMIT = 100;
const MAX_MATCH_LIMIT = 500;
const ACKNOWLEDGEMENT_BATCH_SIZE = 50;
const ACKNOWLEDGEMENT_RECOVERY_SCAN_PAGE_SIZE = 100;
const SHIPMENT_QUERY_BATCH_SIZE = 20;
const ALLOCATION_STATUS = {
  allocated: "ALLOCATED",
  apiAcked: "API_ACKED",
  shipmentListPrinted: "SHIPMENT_LIST_PRINTED",
  canceled: "CANCELED",
  failed: "FAILED",
} as const;
const COUPANG_ACK_VERIFIED_ORDER_STATUSES = ["INSTRUCT", "DEPARTURE"] as const;
type OrderMatchingInput = Record<string, unknown>;
type OrderMatchingDependencies = {
  inventoryVerification?: InventoryVerificationDependencies;
  beforeCandidateAllocation?: (input: {
    workItemId: number;
    salesOfferId: number;
  }) => Promise<void>;
  afterInventoryVerificationPrepared?: () => Promise<void>;
  beforeManualIntentCheck?: (input: {
    workItemId: number;
    externalShipmentId: string;
  }) => Promise<void>;
  requestWrite?: typeof requestSalesChannelWrite;
  refreshInstructOrderAddresses?:
    typeof refreshCoupangOrderAddressesAfterInstruct;
};
type InventoryMatchStatus =
  (typeof INVENTORY_MATCH_STATUSES)[keyof typeof INVENTORY_MATCH_STATUSES];
type CoupangAcknowledgementShipment = {
  external_order_id: string;
  external_shipment_id: string;
  external_order_status: string | null;
  item_ids: number[];
};
type CoupangAcknowledgementVerificationFailure = {
  externalShipmentId: string;
  resultCode: string;
  resultMessage: string;
  retryRequired: boolean;
};

// QuickHack object: 재고 매칭에 필요한 주문 아이템 스냅샷입니다.
type MatchableOrderItem = Prisma.order_matching_work_queueGetPayload<object>;

function nullableText(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function positiveInt(value: unknown, fallback: number, max: number) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function optionalPositiveInt(value: unknown) {
  const text = nullableText(value);

  if (!text) {
    return null;
  }

  const parsed = Number.parseInt(text, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${text}`);
  }

  return parsed;
}

function positiveIntArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value.map((item) => optionalPositiveInt(item)).filter((item): item is number => item !== null)
    )
  ).sort((left, right) => left - right);
}

function boolValue(value: unknown, fallback = false) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "y", "yes"].includes(normalized);
}

function isUniqueConflict(error: unknown) {
  return isPostgresqlUniqueViolation(error);
}

function isInventoryStatusConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "INVENTORY_STATUS_CONFLICT"
  );
}

function isMatchQuantityConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "MATCH_QUANTITY_CONFLICT"
  );
}

function isOrderMappingSnapshotChanged(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ORDER_MAPPING_SNAPSHOT_CHANGED"
  );
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function coupangApiErrorCode(error: unknown) {
  if (error instanceof Error && error.name && error.name !== "Error") {
    return error.name;
  }

  return "COUPANG_API_ERROR";
}

function coupangApiErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requiredQuantity(item: Pick<MatchableOrderItem, "matchable_quantity">) {
  return Math.max(0, item.matchable_quantity);
}

function shipmentPairWhere(shipments: CoupangAcknowledgementShipment[]) {
  return shipments
    .map((shipment) => ({
      external_order_id: shipment.external_order_id,
      external_shipment_id: shipment.external_shipment_id,
    }))
    .filter((shipment) => shipment.external_order_id && shipment.external_shipment_id);
}

async function reserveInventoryForAllocations(
  tx: Prisma.TransactionClient,
  allocations: Array<{ allocation_id: number; pg_no: string }>,
  timestamp: Date
) {
  const uniqueAllocations = Array.from(
    new Map(
      allocations
        .filter((allocation) => allocation.pg_no)
        .map((allocation) => [allocation.pg_no, allocation])
    ).values()
  );
  let reservedCount = 0;

  for (const allocation of uniqueAllocations) {
    const result = await transitionInventoryStatusWithLedger(tx, {
      pgNo: allocation.pg_no,
      toStatus: INVENTORY_STATUS.reserved,
      transitionPolicy: INVENTORY_TRANSITION_POLICY.orderMatchingReservation,
      operationKey: `ORDER_MATCH_RESERVE:${allocation.allocation_id}:${allocation.pg_no}`,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "MATCH_WORKER_ALLOCATION",
      sourceId: String(allocation.allocation_id),
      occurredAt: timestamp,
    });

    if (result.applied) {
      reservedCount += 1;
    }
  }

  return reservedCount;
}

async function activeAllocationPgNosForShipments(
  tx: Prisma.TransactionClient,
  shipments: CoupangAcknowledgementShipment[]
) {
  const shipmentWhere = shipmentPairWhere(shipments);

  if (shipmentWhere.length === 0) {
    return [];
  }

  const allocations = [];

  for (const batch of chunks(shipmentWhere, SHIPMENT_QUERY_BATCH_SIZE)) {
    allocations.push(
      ...(await tx.match_worker_allocation.findMany({
        where: {
          OR: batch,
          allocation_status: {
            in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
          },
        },
        select: { allocation_id: true, pg_no: true },
      }))
    );
  }

  return Array.from(
    new Map(
      allocations.map((allocation) => [allocation.pg_no, allocation])
    ).values()
  );
}

async function markShipmentsApiAckedAndReserveInventory(
  tx: Prisma.TransactionClient,
  shipments: CoupangAcknowledgementShipment[],
  timestamp: Date
) {
  const shipmentWhere = shipmentPairWhere(shipments);

  if (shipmentWhere.length === 0) {
    return 0;
  }

  const allocations = await activeAllocationPgNosForShipments(tx, shipments);

  for (const batch of chunks(shipmentWhere, SHIPMENT_QUERY_BATCH_SIZE)) {
    await tx.match_worker_allocation.updateMany({
      where: {
        OR: batch,
        allocation_status: ALLOCATION_STATUS.allocated,
      },
      data: {
        allocation_status: ALLOCATION_STATUS.apiAcked,
        updated_at: timestamp,
      },
    });
    await tx.order_matching_work_queue.updateMany({
      where: {
        channel: COUPANG_CHANNEL,
        OR: batch,
        work_status: "MATCHED",
        manual_recovery_status: "REASSIGNMENT_REQUIRED",
      },
      data: {
        manual_recovery_status: "NONE",
        manual_recovery_started_at: null,
        manual_recovery_started_by_user_id: null,
        work_failure_reason: null,
        revision: { increment: 1 },
        updated_at: timestamp,
      },
    });
  }

  if (allocations.length === 0) {
    return 0;
  }

  return reserveInventoryForAllocations(tx, allocations, timestamp);
}

async function loadPreviouslySucceededInstructionShipments(
  shipments: CoupangAcknowledgementShipment[]
) {
  const externalShipmentIds = Array.from(
    new Set(shipments.map((shipment) => shipment.external_shipment_id).filter(Boolean))
  );

  if (externalShipmentIds.length === 0) {
    return [];
  }

  const requestRows =
    await prisma.sales_channel_write_request_targets.findMany({
    where: {
      target_type: "SHIPMENT_BOX",
      target_external_id: { in: externalShipmentIds },
      write_request: {
        request_type: SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct,
      },
      external_result_status: { in: ["PENDING", "SUCCEEDED", "UNKNOWN"] },
    },
    select: {
      target_external_id: true,
    },
  });
  const succeededShipmentIds = new Set(
    requestRows
      .map((row) => nullableText(row.target_external_id))
      .filter((value): value is string => Boolean(value))
  );

  return shipments.filter((shipment) =>
    succeededShipmentIds.has(shipment.external_shipment_id)
  );
}

async function verifyAcknowledgedShipmentsFromRaw(input: {
  shipments: CoupangAcknowledgementShipment[];
  minimumSyncedAt?: string | null;
}) {
  const uniqueShipments = Array.from(
    new Map(
      input.shipments.map((shipment) => [
        shipmentSnapshotKey(
          shipment.external_order_id,
          shipment.external_shipment_id
        ),
        shipment,
      ])
    ).values()
  );
  const shipmentWhere = shipmentPairWhere(uniqueShipments);
  const verifiedShipments: CoupangAcknowledgementShipment[] = [];
  const failures: CoupangAcknowledgementVerificationFailure[] = [];

  if (shipmentWhere.length === 0) {
    return {
      verifiedShipments,
      failures,
    };
  }

  const rawRows = [];

  for (const batch of chunks(shipmentWhere, SHIPMENT_QUERY_BATCH_SIZE)) {
    rawRows.push(
      ...(await prisma.coupang_order_raw.findMany({
        where: { OR: batch },
        select: {
          external_order_id: true,
          external_shipment_id: true,
          external_order_status: true,
          synced_at: true,
        },
      }))
    );
  }
  const rawByShipmentKey = new Map(
    rawRows.map((row) => [
      shipmentSnapshotKey(row.external_order_id, row.external_shipment_id),
      row,
    ])
  );

  for (const shipment of uniqueShipments) {
    const raw = rawByShipmentKey.get(
      shipmentSnapshotKey(
        shipment.external_order_id,
        shipment.external_shipment_id
      )
    );

    if (!raw) {
      failures.push({
        externalShipmentId: shipment.external_shipment_id,
        resultCode: "VERIFICATION_RAW_MISSING",
        resultMessage:
          "Coupang ordersheet sync did not return the target shipmentBoxId.",
        retryRequired: true,
      });
      continue;
    }

    if (
      input.minimumSyncedAt &&
      raw.synced_at.getTime() <
        (parseKstSqlDateTime(input.minimumSyncedAt)?.getTime() ?? Number.MAX_SAFE_INTEGER)
    ) {
      failures.push({
        externalShipmentId: shipment.external_shipment_id,
        resultCode: "VERIFICATION_SYNC_STALE",
        resultMessage:
          "Coupang ordersheet row was not refreshed after the write API request.",
        retryRequired: true,
      });
      continue;
    }

    if (raw.external_shipment_id !== shipment.external_shipment_id) {
      failures.push({
        externalShipmentId: shipment.external_shipment_id,
        resultCode: "VERIFICATION_SHIPMENT_ID_MISMATCH",
        resultMessage: `Expected shipmentBoxId ${shipment.external_shipment_id}, got ${raw.external_shipment_id ?? "null"}.`,
        retryRequired: true,
      });
      continue;
    }

    if (
      !COUPANG_ACK_VERIFIED_ORDER_STATUSES.includes(
        raw.external_order_status as (typeof COUPANG_ACK_VERIFIED_ORDER_STATUSES)[number]
      )
    ) {
      failures.push({
        externalShipmentId: shipment.external_shipment_id,
        resultCode: "VERIFICATION_STATUS_NOT_ACKED",
        resultMessage: `Expected INSTRUCT or DEPARTURE, got ${raw.external_order_status ?? "null"}.`,
        retryRequired: true,
      });
      continue;
    }

    verifiedShipments.push(shipment);
  }

  return {
    verifiedShipments,
    failures,
  };
}

async function markVerifiedShipmentsApiAckedAndReserveInventory(input: {
  shipments: CoupangAcknowledgementShipment[];
  timestamp: Date;
  minimumSyncedAt?: string | null;
}) {
  const verification = await verifyAcknowledgedShipmentsFromRaw({
    shipments: input.shipments,
    minimumSyncedAt: input.minimumSyncedAt,
  });

  if (verification.verifiedShipments.length === 0) {
    return {
      ...verification,
      inventoryReservedCount: 0,
    };
  }

  const inventoryReservedCount = await runMeasuredTransaction(
    prisma,
    "order-matching.acknowledge-and-reserve",
    (tx) =>
      markShipmentsApiAckedAndReserveInventory(
        tx,
        verification.verifiedShipments,
        input.timestamp
      )
  );

  return {
    ...verification,
    inventoryReservedCount,
  };
}

function itemCanBeMatched(item: MatchableOrderItem) {
  return (
    item.canceled !== 1 &&
    requiredQuantity(item) > 0 &&
    item.mapping_status === "MAPPED" &&
    Boolean(item.sales_offer_id)
  );
}

function matchStatusForCounts(required: number, matched: number) {
  if (required <= 0) {
    return INVENTORY_MATCH_STATUSES.skipped;
  }

  if (matched === required) {
    return INVENTORY_MATCH_STATUSES.matched;
  }

  if (matched > required) {
    return INVENTORY_MATCH_STATUSES.failed;
  }

  if (matched > 0) {
    return INVENTORY_MATCH_STATUSES.partial;
  }

  return INVENTORY_MATCH_STATUSES.failed;
}

function structuralFailureReasonForItem(item: MatchableOrderItem) {
  if (item.canceled === 1) {
    return INVENTORY_MATCH_FAILURE_REASONS.orderCanceled;
  }

  if (requiredQuantity(item) <= 0) {
    return INVENTORY_MATCH_FAILURE_REASONS.noAvailableQuantity;
  }

  if (item.mapping_status !== "MAPPED" || !item.sales_offer_id) {
    return (
      item.mapping_failure_reason ||
      INVENTORY_MATCH_FAILURE_REASONS.noChannelSalesOffer
    );
  }

  return null;
}

async function finalizeOrderItemInventoryMatch(input: {
  workItemId: number;
  expectedMappingStatus: string;
  expectedSalesOfferId: number | null;
  expectedMappingFailureReason: string | null;
  timestamp: Date;
  preferredFailureReason: string | null;
}) {
  return runMeasuredTransaction(
    prisma,
    "order-matching.finalize-item",
    async (tx) => {
      const item = await lockOrderMatchingWorkItem(tx, input.workItemId);

      if (
        !item ||
        item.mapping_status !== input.expectedMappingStatus ||
        item.sales_offer_id !== input.expectedSalesOfferId ||
        item.mapping_failure_reason !== input.expectedMappingFailureReason ||
        item.work_status === INVENTORY_MATCH_STATUSES.expired
      ) {
        return {
          deferred: true,
          activeMatchCount: 0,
          inventoryMatchStatus:
            (item?.work_status as InventoryMatchStatus | undefined) ??
            INVENTORY_MATCH_STATUSES.unmatched,
          failureReason: item?.work_failure_reason ?? null,
          inventoryReservedCount: 0,
        };
      }

      const allocations = await tx.match_worker_allocation.findMany({
        where: {
          external_order_id: item.external_order_id,
          external_shipment_id: item.external_shipment_id,
          external_vendor_item_id: item.external_vendor_item_id,
          allocation_status: {
            in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
          },
        },
        select: { allocation_id: true, pg_no: true },
      });
      const activeMatchCount = allocations.length;
      const required = requiredQuantity(item);
      const structuralFailureReason = structuralFailureReasonForItem(item);

      if (activeMatchCount > 0 && structuralFailureReason) {
        return {
          deferred: true,
          activeMatchCount,
          inventoryMatchStatus: item.work_status as InventoryMatchStatus,
          failureReason: item.work_failure_reason,
          inventoryReservedCount: 0,
        };
      }

      const failureReason =
        structuralFailureReason ??
        input.preferredFailureReason ??
        (activeMatchCount > required
          ? INVENTORY_MATCH_FAILURE_REASONS.activeAllocationQuantityExceeded
          : activeMatchCount < required
          ? INVENTORY_MATCH_FAILURE_REASONS.insufficientInventory
          : null);
      const inventoryMatchStatus = structuralFailureReason
        ? INVENTORY_MATCH_STATUSES.skipped
        : matchStatusForCounts(required, activeMatchCount);

      await tx.order_matching_work_queue.update({
        where: { work_item_id: item.work_item_id },
        data: {
          work_status: inventoryMatchStatus,
          work_failure_reason: failureReason,
          matched_at: activeMatchCount > 0 ? input.timestamp : null,
          updated_at: input.timestamp,
        },
      });
      const inventoryReservedCount = await reserveInventoryForAllocations(
        tx,
        allocations,
        input.timestamp
      );

      return {
        deferred: false,
        activeMatchCount,
        inventoryMatchStatus,
        failureReason,
        inventoryReservedCount,
      };
    }
  );
}

function applyFinalizationResult(
  result: {
    activeMatchCount: number;
    inventoryMatchStatus: InventoryMatchStatus;
    failureReason: string | null;
    deferred: boolean;
    inventoryReservedCount: number;
  },
  finalized: Awaited<ReturnType<typeof finalizeOrderItemInventoryMatch>>
) {
  result.activeMatchCount = finalized.activeMatchCount;
  result.inventoryMatchStatus = finalized.inventoryMatchStatus;
  result.failureReason = finalized.failureReason;
  result.deferred = finalized.deferred;
  result.inventoryReservedCount = finalized.inventoryReservedCount;
}

function shipmentStatusFromItemStates(
  states: {
    required: number;
    matched: number;
    canMatch: boolean;
  }[]
) {
  const relevant = states.filter((state) => state.required > 0);

  if (relevant.length === 0) {
    return "WAITING";
  }

  const allMatched = relevant.every(
    (state) => state.canMatch && state.matched === state.required
  );
  const anyMatched = relevant.some((state) => state.matched > 0);
  const anyFailed = relevant.some(
    (state) => !state.canMatch || state.matched !== state.required
  );

  if (allMatched) {
    return "MATCHED";
  }

  if (anyMatched) {
    return "PARTIAL_MATCHED";
  }

  if (anyFailed) {
    return "MATCH_FAILED";
  }

  return "WAITING";
}

async function refreshShipmentMatchingStatus(
  externalOrderId: string,
  externalShipmentId: string
) {
  const items = await prisma.order_matching_work_queue.findMany({
    where: {
      channel: COUPANG_CHANNEL,
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
    },
  });

  if (items.length === 0) {
    return null;
  }

  const activeAllocations = await prisma.match_worker_allocation.findMany({
    where: {
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
      allocation_status: {
        in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
      },
    },
    select: {
      external_vendor_item_id: true,
    },
  });
  const matchedCountByVendorItemId = new Map<string, number>();

  for (const allocation of activeAllocations) {
    const vendorItemId = nullableText(allocation.external_vendor_item_id);

    if (!vendorItemId) {
      continue;
    }

    matchedCountByVendorItemId.set(
      vendorItemId,
      (matchedCountByVendorItemId.get(vendorItemId) ?? 0) + 1
    );
  }

  return shipmentStatusFromItemStates(
    items.map((item) => ({
      required: requiredQuantity(item),
      matched: matchedCountByVendorItemId.get(item.external_vendor_item_id) ?? 0,
      canMatch:
        item.canceled !== 1 &&
        item.mapping_status === "MAPPED" &&
        Boolean(item.sales_offer_id),
    }))
  );
}

function shipmentSnapshotKey(externalOrderId: string, externalShipmentId: string) {
  return `${externalOrderId}\u0000${externalShipmentId}`;
}

async function loadAcknowledgementShipmentsForKeys(shipmentKeys: string[]) {
  const keyParts = Array.from(new Set(shipmentKeys))
    .map((key) => {
      const [externalOrderId, externalShipmentId] = key.split("\u0000");

      return {
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
      };
    })
    .filter((key) => key.external_order_id && key.external_shipment_id);

  if (keyParts.length === 0) {
    return [];
  }

  const items = [];

  for (const batch of chunks(keyParts, SHIPMENT_QUERY_BATCH_SIZE)) {
    items.push(
      ...(await prisma.order_matching_work_queue.findMany({
        where: {
          channel: COUPANG_CHANNEL,
          OR: batch,
        },
        orderBy: [{ work_item_id: "asc" }],
        select: {
          work_item_id: true,
          external_order_id: true,
          external_shipment_id: true,
          external_vendor_item_id: true,
          canceled: true,
          matchable_quantity: true,
          mapping_status: true,
          sales_offer_id: true,
        },
      }))
    );
  }

  if (items.length === 0) {
    return [];
  }

  const orders = [];

  for (const batch of chunks(keyParts, SHIPMENT_QUERY_BATCH_SIZE)) {
    orders.push(
      ...(await prisma.coupang_order_raw.findMany({
        where: { OR: batch },
        select: {
          external_order_id: true,
          external_shipment_id: true,
          external_order_status: true,
        },
      }))
    );
  }

  const activeAllocations = [];

  for (const batch of chunks(keyParts, SHIPMENT_QUERY_BATCH_SIZE)) {
    activeAllocations.push(
      ...(await prisma.match_worker_allocation.findMany({
        where: {
          OR: batch,
          allocation_status: {
            in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
          },
        },
        select: {
          external_order_id: true,
          external_shipment_id: true,
          external_vendor_item_id: true,
        },
      }))
    );
  }
  const orderStatusByShipmentKey = new Map(
    orders.map((order) => [
      shipmentSnapshotKey(
        order.external_order_id,
        order.external_shipment_id
      ),
      order.external_order_status,
    ])
  );
  const allocationCountByItemKey = new Map<string, number>();

  for (const allocation of activeAllocations) {
    const key = [
      allocation.external_order_id,
      allocation.external_shipment_id ?? "",
      allocation.external_vendor_item_id ?? "",
    ].join(":");

    allocationCountByItemKey.set(
      key,
      (allocationCountByItemKey.get(key) ?? 0) + 1
    );
  }

  const itemsByShipmentKey = new Map<string, typeof items>();

  for (const item of items) {
    const key = shipmentSnapshotKey(
      item.external_order_id,
      item.external_shipment_id
    );
    const current = itemsByShipmentKey.get(key) ?? [];

    current.push(item);
    itemsByShipmentKey.set(key, current);
  }

  const shipments: CoupangAcknowledgementShipment[] = [];

  for (const shipmentItems of itemsByShipmentKey.values()) {
    const first = shipmentItems[0];

    if (!first) {
      continue;
    }

    const externalOrderStatus =
      orderStatusByShipmentKey.get(
        shipmentSnapshotKey(
          first.external_order_id,
          first.external_shipment_id
        )
      ) ?? null;

    if (
      externalOrderStatus !== "ACCEPT" &&
      !COUPANG_ACK_VERIFIED_ORDER_STATUSES.includes(
        externalOrderStatus as (typeof COUPANG_ACK_VERIFIED_ORDER_STATUSES)[number]
      )
    ) {
      continue;
    }

    const status = shipmentStatusFromItemStates(
      shipmentItems.map((item) => ({
        required: requiredQuantity(item),
        matched:
          allocationCountByItemKey.get(
            [
              item.external_order_id,
              item.external_shipment_id,
              item.external_vendor_item_id,
            ].join(":")
          ) ?? 0,
        canMatch:
          item.canceled !== 1 &&
          item.mapping_status === "MAPPED" &&
          Boolean(item.sales_offer_id),
      }))
    );

    if (status !== "MATCHED") {
      continue;
    }

    shipments.push({
      external_order_id: first.external_order_id,
      external_shipment_id: first.external_shipment_id,
      external_order_status: externalOrderStatus,
      item_ids: shipmentItems.map((item) => item.work_item_id),
    });
  }

  return shipments;
}

type AcknowledgementRecoveryCursor = {
  eligibleAt: Date;
  externalOrderId: string;
  externalShipmentId: string;
};

type AcknowledgementRecoveryRow = {
  external_order_id: string;
  external_shipment_id: string;
  eligible_at: Date;
};

async function loadAcknowledgementRecoveryShipments(
  workerLease?: WorkerLeaseGuard
) {
  const shipments: CoupangAcknowledgementShipment[] = [];
  const seenShipmentKeys = new Set<string>();
  let cursor: AcknowledgementRecoveryCursor | null = null;

  while (shipments.length < ACKNOWLEDGEMENT_BATCH_SIZE) {
    await assertWorkerLeaseActive(workerLease);
    const cursorFilter: Prisma.Sql = cursor
      ? Prisma.sql`WHERE (
          candidate.eligible_at > ${cursor.eligibleAt}
          OR (
            candidate.eligible_at = ${cursor.eligibleAt}
            AND candidate.external_order_id > ${cursor.externalOrderId}
          )
          OR (
            candidate.eligible_at = ${cursor.eligibleAt}
            AND candidate.external_order_id = ${cursor.externalOrderId}
            AND candidate.external_shipment_id > ${cursor.externalShipmentId}
          )
        )`
      : Prisma.empty;
    const rows: AcknowledgementRecoveryRow[] = await prisma.$queryRaw<
      AcknowledgementRecoveryRow[]
    >`
      WITH candidate AS (
        SELECT work.external_order_id,
               work.external_shipment_id,
               COALESCE(
                 MAX(write_request.requested_at),
                 MIN(work.updated_at)
               ) AS eligible_at
        FROM order_matching_work_queue AS work
        JOIN coupang_order_raw AS raw
          ON raw.external_order_id = work.external_order_id
         AND raw.external_shipment_id = work.external_shipment_id
        LEFT JOIN sales_channel_write_request_targets AS history_target
          ON history_target.external_order_id = work.external_order_id
         AND history_target.external_shipment_id = work.external_shipment_id
        LEFT JOIN sales_channel_write_requests AS write_request
          ON write_request.sales_channel_write_request_id =
               history_target.sales_channel_write_request_id
         AND write_request.channel = ${COUPANG_CHANNEL}
         AND write_request.request_type =
               ${SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct}
        WHERE work.channel = ${COUPANG_CHANNEL}
          AND raw.external_order_status IN ('ACCEPT', 'INSTRUCT', 'DEPARTURE')
        GROUP BY work.external_order_id,
                 work.external_shipment_id,
                 raw.external_order_status
        HAVING BOOL_OR(work.matchable_quantity > 0)
           AND BOOL_AND(
             CASE
               WHEN work.matchable_quantity > 0
                 THEN work.work_status = 'MATCHED'
               ELSE TRUE
             END
           )
           AND (
             (
               raw.external_order_status = 'ACCEPT'
               AND NOT EXISTS (
                 SELECT 1
                 FROM sales_channel_write_request_targets AS blocked_target
                 JOIN sales_channel_write_requests AS blocked_request
                   ON blocked_request.sales_channel_write_request_id =
                        blocked_target.sales_channel_write_request_id
                 WHERE blocked_request.channel = ${COUPANG_CHANNEL}
                   AND blocked_request.request_type =
                        ${SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct}
                   AND blocked_target.external_shipment_id =
                        work.external_shipment_id
                   AND blocked_target.external_order_id = work.external_order_id
                   AND blocked_target.external_result_status IN (
                     'PENDING', 'SUCCEEDED', 'UNKNOWN'
                   )
               )
             )
             OR (
               raw.external_order_status IN ('INSTRUCT', 'DEPARTURE')
               AND EXISTS (
                 SELECT 1
                 FROM match_worker_allocation AS recovery_allocation
                 WHERE recovery_allocation.external_order_id =
                         work.external_order_id
                   AND recovery_allocation.external_shipment_id =
                         work.external_shipment_id
                   AND recovery_allocation.allocation_status = 'ALLOCATED'
               )
             )
           )
      )
      SELECT candidate.external_order_id,
             candidate.external_shipment_id,
             candidate.eligible_at
      FROM candidate
      ${cursorFilter}
      ORDER BY candidate.eligible_at ASC,
               candidate.external_order_id ASC,
               candidate.external_shipment_id ASC
      LIMIT ${ACKNOWLEDGEMENT_RECOVERY_SCAN_PAGE_SIZE}
    `;

    if (rows.length === 0) break;
    const pageShipments = await loadAcknowledgementShipmentsForKeys(
      rows.map((row) =>
        shipmentSnapshotKey(row.external_order_id, row.external_shipment_id)
      )
    );

    for (const shipment of pageShipments) {
      const key = shipmentSnapshotKey(
        shipment.external_order_id,
        shipment.external_shipment_id
      );
      if (seenShipmentKeys.has(key)) continue;
      seenShipmentKeys.add(key);
      shipments.push(shipment);
      if (shipments.length >= ACKNOWLEDGEMENT_BATCH_SIZE) break;
    }

    const last: AcknowledgementRecoveryRow | undefined = rows.at(-1);
    if (!last || rows.length < ACKNOWLEDGEMENT_RECOVERY_SCAN_PAGE_SIZE) break;
    cursor = {
      eligibleAt: last.eligible_at,
      externalOrderId: last.external_order_id,
      externalShipmentId: last.external_shipment_id,
    };
  }

  return shipments;
}

async function recoverPendingOrderInstructLocalProjections(input: {
  workerLease?: WorkerLeaseGuard;
  fallbackUserId: number | null;
}) {
  const candidates = await prisma.sales_channel_write_requests.findMany({
    where: {
      channel: COUPANG_CHANNEL,
      request_type: SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct,
      request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
      active_review_attempt_id: null,
    },
    orderBy: [
      { updated_at: "asc" },
      { sales_channel_write_request_id: "asc" },
    ],
    take: ACKNOWLEDGEMENT_BATCH_SIZE,
    select: {
      sales_channel_write_request_id: true,
      requested_by_user_id: true,
    },
  });
  let succeededCount = 0;
  let failedCount = 0;

  for (const candidate of candidates) {
    await assertWorkerLeaseActive(input.workerLease);
    try {
      await recoverSalesChannelLocalFinalization({
        requestId: candidate.sales_channel_write_request_id,
        userId: candidate.requested_by_user_id ?? input.fallbackUserId,
      });
      succeededCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  return {
    candidateCount: candidates.length,
    succeededCount,
    failedCount,
  };
}

async function acknowledgeMatchedAcceptShipments(
  shipmentKeys: string[],
  timestamp: Date,
  workerLease?: WorkerLeaseGuard,
  includeExternalWriteRecovery = true,
  requestWrite: typeof requestSalesChannelWrite = requestSalesChannelWrite,
  refreshInstructOrderAddresses: typeof refreshCoupangOrderAddressesAfterInstruct =
    refreshCoupangOrderAddressesAfterInstruct
) {
  await assertWorkerLeaseActive(workerLease);
  const prioritizedShipmentKeys = Array.from(new Set(shipmentKeys));
  const config = getCoupangRuntimeConfig();
  const summary = {
    enabled: config.writeApiEnabled,
    candidateCount: 0,
    requestedCount: 0,
    succeededCount: 0,
    writeSucceededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    alreadyInstructCount: 0,
    ambiguousWriteConfirmationReadCount: 0,
    skippedReason: null as string | null,
    failures: [] as CoupangAcknowledgementVerificationFailure[],
    postAcknowledgementRefresh: null as unknown,
    addressRefreshCandidateCount: 0,
    addressRefreshSucceededCount: 0,
    addressRefreshFailedCount: 0,
    inventoryReservedCount: 0,
  };
  const prioritizedShipments =
    await loadAcknowledgementShipmentsForKeys(prioritizedShipmentKeys);
  const recoveryShipments = includeExternalWriteRecovery
    ? await loadAcknowledgementRecoveryShipments(workerLease)
    : [];
  const candidateShipments = Array.from(
    new Map(
      [...prioritizedShipments, ...recoveryShipments].map((shipment) => [
        shipmentSnapshotKey(
          shipment.external_order_id,
          shipment.external_shipment_id
        ),
        shipment,
      ])
    ).values()
  );
  const prioritizedKeySet = new Set(prioritizedShipmentKeys);
  const orderedShipments = [
    ...candidateShipments.filter((shipment) =>
      prioritizedKeySet.has(
        shipmentSnapshotKey(
          shipment.external_order_id,
          shipment.external_shipment_id
        )
      )
    ),
    ...candidateShipments.filter(
      (shipment) =>
        !prioritizedKeySet.has(
          shipmentSnapshotKey(
            shipment.external_order_id,
            shipment.external_shipment_id
          )
        )
    ),
  ];
  const limitedShipments = orderedShipments.slice(
    0,
    ACKNOWLEDGEMENT_BATCH_SIZE
  );

  summary.candidateCount = limitedShipments.length;

  if (limitedShipments.length === 0) {
    return summary;
  }

  const alreadyAckedStatusShipments = limitedShipments.filter((shipment) =>
    COUPANG_ACK_VERIFIED_ORDER_STATUSES.includes(
      shipment.external_order_status as (typeof COUPANG_ACK_VERIFIED_ORDER_STATUSES)[number]
    )
  );

  if (alreadyAckedStatusShipments.length > 0) {
    summary.alreadyInstructCount = alreadyAckedStatusShipments.length;
    const verification = await markVerifiedShipmentsApiAckedAndReserveInventory({
      shipments: alreadyAckedStatusShipments,
      timestamp,
    });

    summary.succeededCount += verification.verifiedShipments.length;
    summary.failedCount += verification.failures.length;
    summary.inventoryReservedCount += verification.inventoryReservedCount;
    summary.failures.push(...verification.failures);
  }

  const requestTargetShipments = limitedShipments.filter(
    (shipment) => shipment.external_order_status === "ACCEPT"
  );

  if (requestTargetShipments.length === 0) {
    return summary;
  }

  const previouslyIssuedShipments =
    await loadPreviouslySucceededInstructionShipments(requestTargetShipments);
  const previouslyIssuedShipmentIds = new Set(
    previouslyIssuedShipments.map((shipment) => shipment.external_shipment_id)
  );
  summary.skippedCount += previouslyIssuedShipments.length;

  const batch = requestTargetShipments
    .filter(
      (shipment) =>
        !previouslyIssuedShipmentIds.has(shipment.external_shipment_id)
    )
    .sort(
      (left, right) =>
        left.external_shipment_id.localeCompare(right.external_shipment_id) ||
        left.external_order_id.localeCompare(right.external_order_id)
    )
    .slice(0, ACKNOWLEDGEMENT_BATCH_SIZE);

  if (batch.length === 0) {
    return summary;
  }

  await assertWorkerLeaseActive(workerLease);
  summary.requestedCount = batch.length;
  const sortedShipmentIds = batch
    .map((shipment) => shipment.external_shipment_id)
    .sort();
  const batchFingerprint = createHash("sha256")
    .update(sortedShipmentIds.join("\n"))
    .digest("hex");
  let reservedCount = 0;

  try {
    const writeResult = await requestWrite(
      {
        channel: "COUPANG",
        requestType: SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct,
        idempotencyKey: `ORDER_STATUS_INSTRUCT:${batchFingerprint}`,
        externalOrderId: batch.length === 1 ? batch[0].external_order_id : null,
        targetType: "SHIPMENT_BATCH",
        targetExternalId: batchFingerprint,
        expectedBeforeStatus: "ACCEPT",
        requestedAfterStatus: "INSTRUCT",
        sourceMenuKey: "shipment-all-orders",
        sourceEntityType: "COUPANG_SHIPMENT_BATCH",
        sourceEntityId: batchFingerprint,
        workerJobId: workerLease?.workerJobId ?? null,
        shipmentBoxIds: sortedShipmentIds,
        targets: batch.map((shipment) => ({
          targetType: "SHIPMENT_BOX",
          targetExternalId: shipment.external_shipment_id,
          externalOrderId: shipment.external_order_id,
          externalShipmentId: shipment.external_shipment_id,
          quantity: 1,
          expectedBeforeStatus: shipment.external_order_status,
          requestedAfterStatus: "INSTRUCT",
        })),
      },
      {
        finalize: async ({ tx, requestId, targetIds, finalizedAt }) => {
          const finalized = await finalizePersistedCoupangOrderInstruct({
            tx,
            requestId,
            targetIds,
            finalizedAt,
          });
          reservedCount = finalized.reservedCount;
        },
      },
      {},
      { signal: workerLease?.signal }
    );

    const successfulTargetRows = await prisma.sales_channel_write_request_targets.findMany({
      where: {
        sales_channel_write_request_id: writeResult.requestId,
        sales_channel_write_request_target_id: { in: [...writeResult.targetIds] },
      },
      select: { external_shipment_id: true },
    });
    const successfulShipmentIds = new Set(
      successfulTargetRows
        .map((target) => nullableText(target.external_shipment_id))
        .filter((value): value is string => Boolean(value))
    );
    const successfulBatch = batch.filter((shipment) =>
      successfulShipmentIds.has(shipment.external_shipment_id)
    );
    const failedBatch = batch.filter(
      (shipment) => !successfulShipmentIds.has(shipment.external_shipment_id)
    );
    const verificationTriggered =
      writeResult.confirmation.source === "READ_AFTER_AMBIGUOUS_WRITE";
    summary.writeSucceededCount += successfulBatch.length;
    summary.succeededCount += successfulBatch.length;
    summary.failedCount += failedBatch.length;
    const unresolvedNeedsReview =
      writeResult.status ===
      SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired;
    summary.failures.push(
      ...failedBatch.map((shipment) => ({
        externalShipmentId: shipment.external_shipment_id,
        resultCode: unresolvedNeedsReview
          ? "WRITE_REVIEW_REQUIRED"
          : "COUPANG_WRITE_TARGET_NOT_APPLIED",
        resultMessage: unresolvedNeedsReview
          ? "쿠팡의 실제 처리 결과를 확정하지 못했습니다. 판매 채널 동기화 점검에서 확인하세요."
          : "쿠팡이 해당 배송번호의 상품준비중 처리를 거절했습니다.",
        retryRequired: !unresolvedNeedsReview,
      }))
    );
    if (verificationTriggered) {
      summary.ambiguousWriteConfirmationReadCount += successfulBatch.length;
    }
    summary.inventoryReservedCount += reservedCount;
    summary.addressRefreshCandidateCount += successfulBatch.length;

    let addressRefresh: CoupangOrderAddressRefreshResult;
    let refreshSource:
      | "AMBIGUOUS_CONFIRMATION_SNAPSHOT_REUSED"
      | "POST_ACKNOWLEDGEMENT_ADDRESS_READ";

    if (verificationTriggered) {
      const refreshedTargetCount = Math.min(
        successfulBatch.length,
        writeResult.verification?.confirmedCount ?? successfulBatch.length
      );
      addressRefresh = {
        status:
          refreshedTargetCount === successfulBatch.length ? "SUCCEEDED" : "PARTIAL",
        code: "ADDRESS_SNAPSHOT_REUSED_FROM_AMBIGUOUS_CONFIRMATION",
        endpointPath: writeResult.verification?.endpointPath ?? null,
        targetCount: successfulBatch.length,
        refreshedTargetCount,
        failedTargetCount: successfulBatch.length - refreshedTargetCount,
      };
      refreshSource = "AMBIGUOUS_CONFIRMATION_SNAPSHOT_REUSED";
    } else {
      try {
        addressRefresh = await refreshInstructOrderAddresses({
          requestId: writeResult.requestId,
          targetIds: writeResult.targetIds,
        });
      } catch (error) {
        addressRefresh = {
          status: "FAILED",
          code: coupangApiErrorCode(error),
          endpointPath: null,
          targetCount: successfulBatch.length,
          refreshedTargetCount: 0,
          failedTargetCount: successfulBatch.length,
        };
      }
      refreshSource = "POST_ACKNOWLEDGEMENT_ADDRESS_READ";
    }

    summary.addressRefreshSucceededCount +=
      addressRefresh.refreshedTargetCount;
    summary.addressRefreshFailedCount += addressRefresh.failedTargetCount;
    summary.postAcknowledgementRefresh = {
      source: refreshSource,
      confirmation: writeResult.confirmation,
      result: addressRefresh,
    };
  } catch (error) {
    summary.failedCount += batch.length;
    const requiresReview = error instanceof SalesChannelWriteReviewRequiredError;
    const resultCode = requiresReview
      ? "WRITE_REVIEW_REQUIRED"
      : coupangApiErrorCode(error);
    const resultMessage = requiresReview
      ? error.message
      : coupangApiErrorMessage(error);

    if (!config.writeApiEnabled) {
      summary.skippedReason = "Coupang 쓰기 API 금지";
    }

    for (const shipment of batch) {
      summary.failures.push({
        externalShipmentId: shipment.external_shipment_id,
        resultCode,
        resultMessage,
        retryRequired: false,
      });
    }
    throwIfWorkerLeaseAborted(workerLease);
  }

  return summary;
}

export async function runCoupangMatchingPostCycleForShipment(
  input: {
    externalOrderId: string;
    externalShipmentId: string;
  },
  workerLease?: WorkerLeaseGuard,
  dependencies: Pick<
    OrderMatchingDependencies,
    "requestWrite" | "refreshInstructOrderAddresses"
  > = {}
) {
  const ownedWorkerLease = requireOwnedWorkerLease(workerLease);
  const shipmentKey = shipmentSnapshotKey(
    input.externalOrderId,
    input.externalShipmentId
  );

  await assertWorkerLeaseActive(ownedWorkerLease);
  const shippingWorkStatus = await refreshShipmentMatchingStatus(
    input.externalOrderId,
    input.externalShipmentId
  );
  await assertWorkerLeaseActive(ownedWorkerLease);
  const coupangAcknowledgement = await acknowledgeMatchedAcceptShipments(
    [shipmentKey],
    databaseNow(),
    ownedWorkerLease,
    false,
    dependencies.requestWrite,
    dependencies.refreshInstructOrderAddresses
  );
  await assertWorkerLeaseActive(ownedWorkerLease);

  return {
    shippingWorkStatus,
    coupangAcknowledgement,
    postAcknowledgementRefresh:
      coupangAcknowledgement.postAcknowledgementRefresh,
  };
}

type MatchAllocationCountClient = Pick<
  typeof prisma,
  "order_matching_work_queue" | "match_worker_allocation"
>;

async function countActiveAllocationsForOrderItem(
  client: MatchAllocationCountClient,
  channelOrderItemId: number
) {
  const item = await client.order_matching_work_queue.findUnique({
    where: { work_item_id: channelOrderItemId },
    select: {
      external_order_id: true,
      external_shipment_id: true,
      external_vendor_item_id: true,
    },
  });

  if (!item) {
    return 0;
  }

  return client.match_worker_allocation.count({
    where: {
      external_order_id: item.external_order_id,
      external_shipment_id: item.external_shipment_id,
      external_vendor_item_id: item.external_vendor_item_id,
      allocation_status: {
        in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
      },
    },
  });
}

async function countActiveMatches(channelOrderItemId: number) {
  return countActiveAllocationsForOrderItem(prisma, channelOrderItemId);
}

async function loadMatchableOrderItems(input: OrderMatchingInput) {
  const workItemIds = positiveIntArray(input.workItemIds);
  const workItemId = optionalPositiveInt(
    input.workItemId ?? input.channelOrderItemId
  );
  const externalShipmentId = nullableText(input.externalShipmentId);
  const externalVendorItemId = nullableText(input.externalVendorItemId);
  const includeMatched = boolValue(input.includeMatched, false);
  const targetedRun = Boolean(
    workItemIds.length > 0 ||
      workItemId ||
      externalShipmentId ||
      externalVendorItemId
  );
  const includeFailed = boolValue(input.includeFailed, targetedRun);
  const includeBlockedItems = boolValue(input.includeBlockedItems, targetedRun);
  const limit = positiveInt(input.limit, DEFAULT_MATCH_LIMIT, MAX_MATCH_LIMIT);
  const where: Prisma.order_matching_work_queueWhereInput = {
    channel: COUPANG_CHANNEL,
    ...(workItemIds.length > 0
      ? { work_item_id: { in: workItemIds } }
      : workItemId
        ? { work_item_id: workItemId }
        : {}),
    ...(externalShipmentId
      ? { external_shipment_id: externalShipmentId }
      : {}),
    ...(externalVendorItemId
      ? { external_vendor_item_id: externalVendorItemId }
      : {}),
    ...(includeBlockedItems
      ? {}
      : {
          canceled: { not: 1 },
          matchable_quantity: { gt: 0 },
          mapping_status: "MAPPED",
          sales_offer_id: { not: null },
        }),
    ...(includeMatched
      ? {}
      : {
          work_status: includeFailed
            ? {
                notIn: [
                  INVENTORY_MATCH_STATUSES.matched,
                  INVENTORY_MATCH_STATUSES.expired,
                ],
              }
            : {
                in: [
                  INVENTORY_MATCH_STATUSES.unmatched,
                  INVENTORY_MATCH_STATUSES.partial,
                ],
              },
        }),
  };

  if (!targetedRun && !includeMatched && !includeFailed && !includeBlockedItems) {
    const candidates = await prisma.$queryRaw<Array<{ work_item_id: number }>>`
      SELECT work.work_item_id
      FROM order_matching_work_queue AS work
      JOIN coupang_order_raw AS raw
        ON raw.external_order_id = work.external_order_id
       AND raw.external_shipment_id = work.external_shipment_id
      WHERE work.channel = ${COUPANG_CHANNEL}
        AND raw.external_order_status IN ('ACCEPT', 'INSTRUCT')
        AND work.canceled <> 1
        AND work.matchable_quantity > 0
        AND work.mapping_status = 'MAPPED'
        AND work.sales_offer_id IS NOT NULL
        AND work.work_status IN ('UNMATCHED', 'PARTIAL')
      ORDER BY work.work_item_id ASC
      LIMIT ${limit}
    `;
    if (candidates.length === 0) return [];
    return prisma.order_matching_work_queue.findMany({
      where: {
        work_item_id: { in: candidates.map((candidate) => candidate.work_item_id) },
      },
      orderBy: [{ work_item_id: "asc" }],
    });
  }

  if (workItemIds.length === 0) {
    return prisma.order_matching_work_queue.findMany({
      where,
      orderBy: [{ work_item_id: "asc" }],
      take: limit,
    });
  }

  const items: MatchableOrderItem[] = [];

  for (const workItemIdBatch of chunks(workItemIds, 400)) {
    items.push(
      ...(await prisma.order_matching_work_queue.findMany({
        where: {
          ...where,
          work_item_id: { in: workItemIdBatch },
        },
        orderBy: [{ work_item_id: "asc" }],
      }))
    );
  }

  return items.sort((left, right) => left.work_item_id - right.work_item_id);
}

// QuickHack object: 주문 아이템 하나에 대해 필요한 수량만큼 실제 PG 재고를 매칭합니다.
async function matchSingleOrderItem(
  item: MatchableOrderItem,
  dependencies: OrderMatchingDependencies
) {
  const timestamp = databaseNow();
  const required = requiredQuantity(item);
  const existingMatchCount = await countActiveMatches(item.work_item_id);
  const offerIdentity = item.sales_offer_id
    ? await prisma.sales_offers.findUnique({
        where: { sales_offer_id: item.sales_offer_id },
        select: { offer_code: true },
      })
    : null;
  const offer =
    item.sales_offer_id &&
    item.required_model_label &&
    item.required_warranty_group
      ? {
          salesOfferId: item.sales_offer_id,
          offerCode: offerIdentity?.offer_code ?? null,
          model: item.required_model_label,
          requiredStorage: item.required_storage_label,
          requiredColor: item.required_color_label,
          requiredWarrantyGroup: item.required_warranty_group,
        }
      : null;
  const result = {
    channelOrderItemId: item.work_item_id,
    externalOrderId: item.external_order_id,
    externalShipmentId: item.external_shipment_id,
    externalVendorItemId: item.external_vendor_item_id,
    salesOfferId: item.sales_offer_id,
    salesOfferCode: offer?.offerCode ?? null,
    requiredStorage: offer?.requiredStorage ?? null,
    requiredColor: offer?.requiredColor ?? null,
    requiredWarrantyGroup: offer?.requiredWarrantyGroup ?? null,
    requiredQuantity: required,
    existingMatchCount,
    matchedNow: 0,
    activeMatchCount: existingMatchCount,
    inventoryMatchStatus: INVENTORY_MATCH_STATUSES.unmatched as InventoryMatchStatus,
    failureReason: null as string | null,
    warnings: [] as string[],
    matchedDevices: [] as {
      pgNo: string;
      model: string;
      modelSeq: number | null;
      storage: string | null;
      color: string | null;
      saleGrade: string | null;
      warranty: string | null;
    }[],
    conflictCount: 0,
    deferred: false,
    inventoryReservedCount: 0,
  };

  await dependencies.beforeManualIntentCheck?.({
    workItemId: item.work_item_id,
    externalShipmentId: item.external_shipment_id,
  });
  if (await hasActiveManualOrderMatchIntent(prisma, {
    externalOrderId: item.external_order_id,
    externalShipmentId: item.external_shipment_id,
  })) {
    result.deferred = true;
    result.failureReason = "MANUAL_ORDER_MATCH_INTENT_ACTIVE";
    return result;
  }

  if (!itemCanBeMatched(item) || !offer) {
    result.failureReason = itemCanBeMatched(item)
      ? INVENTORY_MATCH_FAILURE_REASONS.noChannelSalesOffer
      : structuralFailureReasonForItem(item);
    applyFinalizationResult(
      result,
      await finalizeOrderItemInventoryMatch({
        workItemId: item.work_item_id,
        expectedMappingStatus: item.mapping_status,
        expectedSalesOfferId: item.sales_offer_id,
        expectedMappingFailureReason: item.mapping_failure_reason,
        timestamp,
        preferredFailureReason: result.failureReason,
      })
    );

    return result;
  }

  if (existingMatchCount > required) {
    result.failureReason =
      INVENTORY_MATCH_FAILURE_REASONS.activeAllocationQuantityExceeded;
    applyFinalizationResult(
      result,
      await finalizeOrderItemInventoryMatch({
        workItemId: item.work_item_id,
        expectedMappingStatus: item.mapping_status,
        expectedSalesOfferId: item.sales_offer_id,
        expectedMappingFailureReason: item.mapping_failure_reason,
        timestamp,
        preferredFailureReason: result.failureReason,
      })
    );
    return result;
  }

  let remainingQuantity = Math.max(0, required - existingMatchCount);

  if (remainingQuantity > 0 && item.sales_offer_id) {
    const policy = await getSalesOfferOrderMatchingPolicy(item.sales_offer_id);

    if (policy && !policy.autoMatchEnabled) {
      const activeMatchCount = await countActiveMatches(item.work_item_id);
      result.failureReason = INVENTORY_MATCH_FAILURE_REASONS.autoMatchDisabled;
      result.activeMatchCount = activeMatchCount;
      applyFinalizationResult(
        result,
        await finalizeOrderItemInventoryMatch({
          workItemId: item.work_item_id,
          expectedMappingStatus: item.mapping_status,
          expectedSalesOfferId: item.sales_offer_id,
          expectedMappingFailureReason: item.mapping_failure_reason,
          timestamp,
          preferredFailureReason: result.failureReason,
        })
      );

      return result;
    }

    const candidatesResult = await findInventoryCandidatesForSalesOffer(
      item.sales_offer_id,
      {
        candidateSortMode: policy?.candidateSortMode,
        gradeFallbackEnabled: policy?.gradeFallbackEnabled,
        saleGradeGroups: policy?.tiers.map((tier) => tier.saleGradeValues),
        allowInactiveOffer: true,
      }
    );

    await dependencies.beforeCandidateAllocation?.({
      workItemId: item.work_item_id,
      salesOfferId: item.sales_offer_id,
    });

    result.warnings = candidatesResult.warnings;

    if (candidatesResult.candidates.length === 0 && candidatesResult.failureReason) {
      result.failureReason = candidatesResult.failureReason;
    }

    for (const candidate of candidatesResult.candidates) {
      if (remainingQuantity <= 0) {
        break;
      }

      try {
        await runMeasuredTransaction(
          prisma,
          "order-matching.allocate-candidate",
          async (tx) => {
          const lockedItem = await lockOrderMatchingWorkItem(
            tx,
            item.work_item_id
          );

          if (
            !lockedItem ||
            lockedItem.mapping_status !== item.mapping_status ||
            lockedItem.sales_offer_id !== item.sales_offer_id ||
            lockedItem.mapping_failure_reason !== item.mapping_failure_reason
          ) {
            throw Object.assign(new Error("Order mapping snapshot changed"), {
              code: "ORDER_MAPPING_SNAPSHOT_CHANGED",
            });
          }

          const currentRequired = requiredQuantity(lockedItem);
          const lockedOrders = await tx.$queryRaw<
            Array<{ external_order_status: string | null }>
          >`
            SELECT external_order_status
            FROM coupang_order_raw
            WHERE external_order_id = ${lockedItem.external_order_id}
              AND external_shipment_id = ${lockedItem.external_shipment_id}
            FOR UPDATE
          `;
          const lockedOrderStatus = lockedOrders[0]?.external_order_status ?? null;
          const currentMatchCount = await countActiveAllocationsForWorkItem(
            tx,
            lockedItem
          );

          if (await hasActiveManualOrderMatchIntent(tx, {
            externalOrderId: lockedItem.external_order_id,
            externalShipmentId: lockedItem.external_shipment_id,
            pgNo: candidate.pgNo,
          })) {
            throw Object.assign(new Error("Manual order match intent is active"), {
              code: "MANUAL_ORDER_MATCH_INTENT_ACTIVE",
            });
          }

          if (
            lockedItem.canceled === 1 ||
            currentRequired <= 0 ||
            lockedItem.mapping_status !== "MAPPED" ||
            !lockedItem.sales_offer_id ||
            lockedItem.work_status === INVENTORY_MATCH_STATUSES.expired ||
            lockedItem.work_status === INVENTORY_MATCH_STATUSES.matched ||
            !["ACCEPT", "INSTRUCT"].includes(lockedOrderStatus ?? "") ||
            currentMatchCount >= currentRequired
          ) {
            throw Object.assign(new Error("Order item match quantity conflict"), {
              code: "MATCH_QUANTITY_CONFLICT",
            });
          }

          await lockDeviceAggregates(tx, {
            pgNos: [candidate.pgNo],
            requireDevice: true,
            requireInventory: true,
          });
          await transitionInventoryStatusWithLedger(tx, {
            pgNo: candidate.pgNo,
            expectedFromStatus: INVENTORY_STATUS.sellable,
            toStatus: INVENTORY_STATUS.reserved,
            transitionPolicy:
              INVENTORY_TRANSITION_POLICY.orderMatchingReservation,
            operationKey:
              `ORDER_MATCH:${item.work_item_id}:${candidate.pgNo}:` +
              `${INVENTORY_STATUS.sellable}-${INVENTORY_STATUS.reserved}`,
            movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
            sourceType: "ORDER_MATCHING_WORK_ITEM",
            sourceId: String(item.work_item_id),
            occurredAt: timestamp,
          });

          await tx.match_worker_allocation.create({
            data: {
              external_order_id: lockedItem.external_order_id,
              pg_no: candidate.pgNo,
              external_shipment_id: lockedItem.external_shipment_id,
              external_vendor_item_id: lockedItem.external_vendor_item_id,
              external_product_id: lockedItem.seller_product_id,
              vendor_item_name: lockedItem.vendor_item_name,
              seller_product_name: lockedItem.seller_product_name,
              seller_product_item_name: lockedItem.seller_product_item_name,
              option_name: lockedItem.seller_product_item_name,
              external_order_status_at_allocation:
                lockedOrderStatus,
              available_quantity_at_allocation:
                lockedItem.matchable_quantity,
              sales_offer_id: lockedItem.sales_offer_id,
              inventory_sku_id: candidate.inventorySkuId,
              required_model: offer.model,
              required_storage: offer.requiredStorage,
              required_color: offer.requiredColor,
              required_warranty_group: offer.requiredWarrantyGroup,
              inventory_status_before_allocation: INVENTORY_STATUS.sellable,
              allocation_status: ALLOCATION_STATUS.allocated,
              failure_reason: null,
              allocation_note:
                candidatesResult.warnings.length > 0
                  ? candidatesResult.warnings.join(" | ")
                  : null,
              allocated_at: timestamp,
              created_at: timestamp,
              updated_at: timestamp,
            },
          });
        });

        result.matchedNow += 1;
        remainingQuantity -= 1;
        result.matchedDevices.push({
          pgNo: candidate.pgNo,
          model: candidate.model,
          modelSeq: candidate.modelSeq,
          storage: candidate.storage,
          color: candidate.color,
          saleGrade: candidate.saleGrade,
          warranty: candidate.warranty,
        });
      } catch (error) {
        if (isUniqueConflict(error) || isInventoryStatusConflict(error)) {
          result.conflictCount += 1;
          continue;
        }

        if (isMatchQuantityConflict(error)) {
          result.conflictCount += 1;
          remainingQuantity = 0;
          break;
        }

        if (isOrderMappingSnapshotChanged(error)) {
          result.conflictCount += 1;
          result.deferred = true;
          remainingQuantity = 0;
          break;
        }

        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "MANUAL_ORDER_MATCH_INTENT_ACTIVE"
        ) {
          result.conflictCount += 1;
          result.deferred = true;
          result.failureReason = "MANUAL_ORDER_MATCH_INTENT_ACTIVE";
          remainingQuantity = 0;
          break;
        }

        throw error;
      }
    }
  }

  applyFinalizationResult(
    result,
    await finalizeOrderItemInventoryMatch({
      workItemId: item.work_item_id,
      expectedMappingStatus: item.mapping_status,
      expectedSalesOfferId: item.sales_offer_id,
      expectedMappingFailureReason: item.mapping_failure_reason,
      timestamp,
      preferredFailureReason: result.failureReason,
    })
  );

  return result;
}

async function reconcileChangedAllocationQuantities(timestamp: Date) {
  let reconciledCount = 0;

  while (true) {
    const rows = await prisma.$queryRaw<
      Array<{ work_item_id: number; active_count: bigint; matchable_quantity: number }>
    >`
      SELECT work.work_item_id,
             allocation.active_count,
             work.matchable_quantity
      FROM order_matching_work_queue AS work
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::bigint AS active_count
        FROM match_worker_allocation AS item
        WHERE item.external_order_id = work.external_order_id
          AND item.external_shipment_id = work.external_shipment_id
          AND item.external_vendor_item_id = work.external_vendor_item_id
          AND item.allocation_status IN ('ALLOCATED', 'API_ACKED', 'SHIPMENT_LIST_PRINTED')
      ) AS allocation
      WHERE work.channel = ${COUPANG_CHANNEL}
        AND work.work_status <> 'EXPIRED'
        AND (
          (allocation.active_count > work.matchable_quantity
           AND NOT (
             work.work_status = 'FAILED'
             AND work.work_failure_reason = 'ACTIVE_ALLOCATION_QUANTITY_EXCEEDED'
           ))
          OR
          (allocation.active_count < work.matchable_quantity
           AND work.work_status = 'MATCHED')
        )
      ORDER BY work.work_item_id ASC
      LIMIT ${MAX_MATCH_LIMIT}
    `;

    if (rows.length === 0) break;

    await runMeasuredTransaction(
      prisma,
      "order-matching.reconcile-quantity-page",
      async (tx) => {
        for (const row of rows) {
          const activeCount = Number(row.active_count);
          const exceeded = activeCount > row.matchable_quantity;
          await tx.order_matching_work_queue.updateMany({
            where: {
              work_item_id: row.work_item_id,
              work_status: { not: INVENTORY_MATCH_STATUSES.expired },
            },
            data: {
              work_status: exceeded
                ? INVENTORY_MATCH_STATUSES.failed
                : activeCount > 0
                  ? INVENTORY_MATCH_STATUSES.partial
                  : INVENTORY_MATCH_STATUSES.unmatched,
              work_failure_reason: exceeded
                ? INVENTORY_MATCH_FAILURE_REASONS.activeAllocationQuantityExceeded
                : activeCount > 0
                  ? INVENTORY_MATCH_FAILURE_REASONS.insufficientInventory
                  : null,
              matched_at: activeCount > 0 ? timestamp : null,
              updated_at: timestamp,
            },
          });
        }
      }
    );
    reconciledCount += rows.length;
  }

  return reconciledCount;
}

// QuickHack object: 조건에 맞는 쿠팡 주문 아이템들을 일괄 매칭하고 결과 통계를 반환합니다.
export async function matchCoupangOrders(
  input: OrderMatchingInput = {},
  user: AuthUser | null = null,
  workerLease?: WorkerLeaseGuard,
  dependencies: OrderMatchingDependencies = {}
) {
  const ownedWorkerLease = requireOwnedWorkerLease(workerLease);
  const startedAt = databaseNow();
  const explicitWorkItemIds = positiveIntArray(input.workItemIds);
  const strictTargetedRun = explicitWorkItemIds.length > 0;
  await assertWorkerLeaseActive(ownedWorkerLease);
  const reconciledAllocationQuantityCount = strictTargetedRun
    ? 0
    : await reconcileChangedAllocationQuantities(startedAt);
  const activeAllocationInventoryReservedCount = 0;
  const items = await loadMatchableOrderItems(input);
  await assertWorkerLeaseActive(ownedWorkerLease);
  const affectedShipmentKeys = new Set<string>();
  const results = [];

  for (const [index, item] of items.entries()) {
    if (index % 10 === 0) {
      await assertWorkerLeaseActive(ownedWorkerLease);
    } else {
      throwIfWorkerLeaseAborted(ownedWorkerLease);
    }

    const result = await matchSingleOrderItem(item, dependencies);

    results.push(result);
    if (result.failureReason !== "MANUAL_ORDER_MATCH_INTENT_ACTIVE") {
      affectedShipmentKeys.add(
        shipmentSnapshotKey(item.external_order_id, item.external_shipment_id)
      );
    }
  }

  const inventoryVerificationCycle =
    await prepareCoupangMatchingCycleInventoryVerification({
      salesOfferIds: results
        .filter((result) => !result.deferred)
        .map((result) => result.salesOfferId),
      externalVendorItemIds: results
        .filter((result) => !result.deferred)
        .map((result) => result.externalVendorItemId),
      workerLease: ownedWorkerLease,
      dependencies: dependencies.inventoryVerification,
    });
  const postCycle = await (async () => {
    try {
      await dependencies.afterInventoryVerificationPrepared?.();
      const localProjectionRecovery = strictTargetedRun
        ? { candidateCount: 0, succeededCount: 0, failedCount: 0 }
        : await recoverPendingOrderInstructLocalProjections({
            workerLease: ownedWorkerLease,
            fallbackUserId: user?.userId ?? null,
          });
      const refreshedShipments = [];
      const refreshedAt = databaseNow();

      for (const shipmentKey of affectedShipmentKeys) {
        throwIfWorkerLeaseAborted(ownedWorkerLease);
        const [externalOrderId, externalShipmentId] = shipmentKey.split("\u0000");

        refreshedShipments.push({
          externalOrderId,
          externalShipmentId,
          shippingWorkStatus: await refreshShipmentMatchingStatus(
            externalOrderId,
            externalShipmentId
          ),
        });
      }

      await assertWorkerLeaseActive(ownedWorkerLease);
      const coupangAcknowledgement = await acknowledgeMatchedAcceptShipments(
        Array.from(affectedShipmentKeys),
        refreshedAt,
        ownedWorkerLease,
        !strictTargetedRun,
        dependencies.requestWrite,
        dependencies.refreshInstructOrderAddresses
      );
      await assertWorkerLeaseActive(ownedWorkerLease);
      const inventoryVerification =
        await runCoupangMatchingCycleInventoryVerification({
          cycle: inventoryVerificationCycle,
          workerLease: ownedWorkerLease,
          dependencies: dependencies.inventoryVerification,
        });
      await assertWorkerLeaseActive(ownedWorkerLease);

      return {
        localProjectionRecovery,
        refreshedShipments,
        coupangAcknowledgement,
        inventoryVerification,
      };
    } catch (error) {
      await failCoupangMatchingCycleInventoryVerification({
        cycle: inventoryVerificationCycle,
        workerLease: ownedWorkerLease,
        error,
      }).catch(() => undefined);
      throw error;
    }
  })();
  const finishedAt = databaseNow();

  const summary = {
    startedAt,
    finishedAt,
    processedItemCount: results.length,
    matchedDeviceCount: results.reduce((sum, item) => sum + item.matchedNow, 0),
    fullyMatchedItemCount: results.filter(
      (item) => item.inventoryMatchStatus === INVENTORY_MATCH_STATUSES.matched
    ).length,
    partialItemCount: results.filter(
      (item) => item.inventoryMatchStatus === INVENTORY_MATCH_STATUSES.partial
    ).length,
    failedItemCount: results.filter(
      (item) => item.inventoryMatchStatus === INVENTORY_MATCH_STATUSES.failed
    ).length,
    skippedItemCount: results.filter(
      (item) => item.inventoryMatchStatus === INVENTORY_MATCH_STATUSES.skipped
    ).length,
    deferredItemCount: results.filter((item) => item.deferred).length,
    conflictCount: results.reduce((sum, item) => sum + item.conflictCount, 0),
    finalizedInventoryReservedCount: results.reduce(
      (sum, item) => sum + item.inventoryReservedCount,
      0
    ),
    activeAllocationInventoryReservedCount,
    reconciledAllocationQuantityCount,
    refreshedShipments: postCycle.refreshedShipments,
    coupangAcknowledgement: postCycle.coupangAcknowledgement,
    postAcknowledgementRefresh:
      postCycle.coupangAcknowledgement.postAcknowledgementRefresh,
    inventoryVerification: postCycle.inventoryVerification,
    localProjectionRecovery: postCycle.localProjectionRecovery,
  };
  const activitySummary = {
    startedAt,
    finishedAt,
    processedItemCount: summary.processedItemCount,
    matchedDeviceCount: summary.matchedDeviceCount,
    fullyMatchedItemCount: summary.fullyMatchedItemCount,
    partialItemCount: summary.partialItemCount,
    failedItemCount: summary.failedItemCount,
    skippedItemCount: summary.skippedItemCount,
    deferredItemCount: summary.deferredItemCount,
    conflictCount: summary.conflictCount,
    finalizedInventoryReservedCount: summary.finalizedInventoryReservedCount,
    activeAllocationInventoryReservedCount:
      summary.activeAllocationInventoryReservedCount,
    reconciledAllocationQuantityCount: summary.reconciledAllocationQuantityCount,
    refreshedShipmentCount: summary.refreshedShipments.length,
  };

  if (user) {
    await prisma.employee_activity_logs.create({
      data: {
        user_id: user.userId,
        action_type: "COUPANG_ORDER_AUTO_MATCH",
        target_type: "SALES_CHANNEL_ORDER_ITEM",
        target_id: nullableText(input.channelOrderItemId) ?? "BATCH",
        ...activityLogChangeData(null, activitySummary),
        result: "SUCCESS",
        created_at: finishedAt,
      },
    });
  }

  return {
    summary,
    items: results,
  };
}
