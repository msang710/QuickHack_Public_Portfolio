import type { Prisma } from "@/generated/prisma/client";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import {
  ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
  INVENTORY_MATCH_FAILURE_REASONS,
  INVENTORY_MATCH_STATUSES,
} from "@/quickhack_shared/sales-channel/order-matching";

const PROTECTED_WORK_STATUSES = new Set<string>([
  INVENTORY_MATCH_STATUSES.partial,
  INVENTORY_MATCH_STATUSES.matched,
  INVENTORY_MATCH_STATUSES.expired,
]);
const SYNC_CONTROLLED_FAILURE_REASONS = new Set<string>([
  INVENTORY_MATCH_FAILURE_REASONS.noChannelSalesOffer,
  INVENTORY_MATCH_FAILURE_REASONS.orderCanceled,
  INVENTORY_MATCH_FAILURE_REASONS.noAvailableQuantity,
]);
const EXPIRABLE_WORK_STATUSES = new Set<string>([
  INVENTORY_MATCH_STATUSES.unmatched,
  INVENTORY_MATCH_STATUSES.failed,
  INVENTORY_MATCH_STATUSES.skipped,
]);

export type OrderMappingSnapshot = {
  mappingStatus: "MAPPED" | "UNMAPPED";
  salesOfferId: number | null;
  mappingFailureReason: string | null;
  requiredModelLabel: string | null;
  requiredStorageLabel: string | null;
  requiredColorLabel: string | null;
  requiredWarrantyGroup: string | null;
};

export type OrderMappingApplicationOutcome =
  | "UPDATED"
  | "UNCHANGED"
  | "PROTECTED_BY_WORK_STATUS"
  | "PROTECTED_BY_ACTIVE_ALLOCATION";

type WorkItem = Prisma.order_matching_work_queueGetPayload<object>;

function sameMappingSnapshot(
  item: Pick<WorkItem, "mapping_status" | "sales_offer_id" | "mapping_failure_reason">,
  snapshot: OrderMappingSnapshot
) {
  return (
    item.mapping_status === snapshot.mappingStatus &&
    item.sales_offer_id === snapshot.salesOfferId &&
    item.mapping_failure_reason === snapshot.mappingFailureReason
  );
}

export function orderMappingSnapshotFromWorkItem(
  item: Pick<
    WorkItem,
    | "mapping_status"
    | "sales_offer_id"
    | "mapping_failure_reason"
    | "required_model_label"
    | "required_storage_label"
    | "required_color_label"
    | "required_warranty_group"
  >
): OrderMappingSnapshot {
  return {
    mappingStatus: item.mapping_status === "MAPPED" ? "MAPPED" : "UNMAPPED",
    salesOfferId: item.sales_offer_id,
    mappingFailureReason: item.mapping_failure_reason,
    requiredModelLabel: item.required_model_label,
    requiredStorageLabel: item.required_storage_label,
    requiredColorLabel: item.required_color_label,
    requiredWarrantyGroup: item.required_warranty_group,
  };
}

export function derivePreMatchWorkState(
  item: Pick<WorkItem, "canceled" | "matchable_quantity">,
  snapshot: OrderMappingSnapshot
) {
  if (item.canceled === 1) {
    return {
      workStatus: INVENTORY_MATCH_STATUSES.skipped,
      workFailureReason: INVENTORY_MATCH_FAILURE_REASONS.orderCanceled,
    } as const;
  }

  if (item.matchable_quantity <= 0) {
    return {
      workStatus: INVENTORY_MATCH_STATUSES.skipped,
      workFailureReason: INVENTORY_MATCH_FAILURE_REASONS.noAvailableQuantity,
    } as const;
  }

  if (snapshot.mappingStatus !== "MAPPED" || !snapshot.salesOfferId) {
    return {
      workStatus: INVENTORY_MATCH_STATUSES.skipped,
      workFailureReason: INVENTORY_MATCH_FAILURE_REASONS.noChannelSalesOffer,
    } as const;
  }

  return {
    workStatus: INVENTORY_MATCH_STATUSES.unmatched,
    workFailureReason: null,
  } as const;
}

export async function lockOrderMatchingWorkItem(
  tx: Prisma.TransactionClient,
  workItemId: number
) {
  await tx.$queryRaw`
    SELECT work_item_id
    FROM order_matching_work_queue
    WHERE work_item_id = ${workItemId}
    FOR UPDATE
  `;

  return tx.order_matching_work_queue.findUnique({
    where: { work_item_id: workItemId },
  });
}

export async function countActiveAllocationsForWorkItem(
  tx: Prisma.TransactionClient,
  item: Pick<
    WorkItem,
    "external_order_id" | "external_shipment_id" | "external_vendor_item_id"
  >
) {
  return tx.match_worker_allocation.count({
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

function protectedOutcome(
  item: Pick<WorkItem, "work_status">,
  activeAllocationCount: number
): OrderMappingApplicationOutcome | null {
  if (activeAllocationCount > 0) {
    return "PROTECTED_BY_ACTIVE_ALLOCATION";
  }

  if (PROTECTED_WORK_STATUSES.has(item.work_status)) {
    return "PROTECTED_BY_WORK_STATUS";
  }

  return null;
}

export async function applyChangedMappingSnapshotToWorkItem(input: {
  tx: Prisma.TransactionClient;
  workItemId: number;
  snapshot: OrderMappingSnapshot;
  timestamp: DateTimeInput;
}) {
  const item = await lockOrderMatchingWorkItem(input.tx, input.workItemId);

  if (!item) {
    return { outcome: "UNCHANGED" as const, workStateUpdated: false };
  }

  if (sameMappingSnapshot(item, input.snapshot)) {
    return { outcome: "UNCHANGED" as const, workStateUpdated: false };
  }

  const activeAllocationCount = await countActiveAllocationsForWorkItem(
    input.tx,
    item
  );

  if (activeAllocationCount > 0) {
    return {
      outcome: "PROTECTED_BY_ACTIVE_ALLOCATION" as const,
      workStateUpdated: false,
    };
  }

  const protection = protectedOutcome(item, activeAllocationCount);

  if (protection) {
    return { outcome: protection, workStateUpdated: false };
  }

  const workState = derivePreMatchWorkState(item, input.snapshot);

  await input.tx.order_matching_work_queue.update({
    where: { work_item_id: item.work_item_id },
    data: {
      mapping_status: input.snapshot.mappingStatus,
      sales_offer_id: input.snapshot.salesOfferId,
      mapping_failure_reason: input.snapshot.mappingFailureReason,
      required_model_label: input.snapshot.requiredModelLabel,
      required_storage_label: input.snapshot.requiredStorageLabel,
      required_color_label: input.snapshot.requiredColorLabel,
      required_warranty_group: input.snapshot.requiredWarrantyGroup,
      work_status: workState.workStatus,
      work_failure_reason: workState.workFailureReason,
      matched_at: null,
      updated_at: databaseDateTime(input.timestamp),
    },
  });

  return { outcome: "UPDATED" as const, workStateUpdated: true };
}

export async function synchronizeWorkItemMappingSnapshot(input: {
  tx: Prisma.TransactionClient;
  workItemId: number;
  snapshot: OrderMappingSnapshot;
  timestamp: DateTimeInput;
}) {
  const item = await lockOrderMatchingWorkItem(input.tx, input.workItemId);

  if (!item) {
    return { outcome: "UNCHANGED" as const, workStateUpdated: false };
  }

  const activeAllocationCount = await countActiveAllocationsForWorkItem(
    input.tx,
    item
  );

  if (activeAllocationCount > 0) {
    return {
      outcome: sameMappingSnapshot(item, input.snapshot)
        ? ("UNCHANGED" as const)
        : ("PROTECTED_BY_ACTIVE_ALLOCATION" as const),
      workStateUpdated: false,
    };
  }

  const protection = protectedOutcome(item, activeAllocationCount);
  const mappingChanged = !sameMappingSnapshot(item, input.snapshot);
  const canChangeMapping = !protection;
  const effectiveSnapshot =
    mappingChanged && canChangeMapping
      ? input.snapshot
      : orderMappingSnapshotFromWorkItem(item);
  const desiredWorkState = derivePreMatchWorkState(item, effectiveSnapshot);
  const workStatusProtected = PROTECTED_WORK_STATUSES.has(item.work_status);
  const shouldApplyBlockingState =
    !workStatusProtected &&
    desiredWorkState.workStatus === INVENTORY_MATCH_STATUSES.skipped &&
    (item.work_status !== desiredWorkState.workStatus ||
      item.work_failure_reason !== desiredWorkState.workFailureReason);
  const shouldRecoverSyncControlledSkip =
    !workStatusProtected &&
    desiredWorkState.workStatus === INVENTORY_MATCH_STATUSES.unmatched &&
    item.work_status === INVENTORY_MATCH_STATUSES.skipped &&
    SYNC_CONTROLLED_FAILURE_REASONS.has(item.work_failure_reason ?? "");
  const workStateUpdated =
    shouldApplyBlockingState ||
    shouldRecoverSyncControlledSkip ||
    (mappingChanged && canChangeMapping);

  if ((!mappingChanged || !canChangeMapping) && !workStateUpdated) {
    return {
      outcome: mappingChanged && protection ? protection : "UNCHANGED",
      workStateUpdated: false,
    } as const;
  }

  await input.tx.order_matching_work_queue.update({
    where: { work_item_id: item.work_item_id },
    data: {
      ...(mappingChanged && canChangeMapping
        ? {
            mapping_status: input.snapshot.mappingStatus,
            sales_offer_id: input.snapshot.salesOfferId,
            mapping_failure_reason: input.snapshot.mappingFailureReason,
            required_model_label: input.snapshot.requiredModelLabel,
            required_storage_label: input.snapshot.requiredStorageLabel,
            required_color_label: input.snapshot.requiredColorLabel,
            required_warranty_group: input.snapshot.requiredWarrantyGroup,
            matched_at: null,
          }
        : {}),
      ...(workStateUpdated
        ? {
            work_status: desiredWorkState.workStatus,
            work_failure_reason: desiredWorkState.workFailureReason,
            matched_at: null,
          }
        : {}),
      updated_at: databaseDateTime(input.timestamp),
    },
  });

  return {
    outcome:
      mappingChanged && canChangeMapping
        ? ("UPDATED" as const)
        : mappingChanged && protection
          ? protection
          : ("UNCHANGED" as const),
    workStateUpdated,
  };
}

export async function expireOrderMatchingWorkItemIfEligible(input: {
  tx: Prisma.TransactionClient;
  workItemId: number;
  timestamp: DateTimeInput;
}) {
  const item = await lockOrderMatchingWorkItem(input.tx, input.workItemId);

  if (!item || !EXPIRABLE_WORK_STATUSES.has(item.work_status)) {
    return false;
  }

  const activeAllocationCount = await countActiveAllocationsForWorkItem(
    input.tx,
    item
  );

  if (activeAllocationCount > 0) {
    return false;
  }

  await input.tx.order_matching_work_queue.update({
    where: { work_item_id: item.work_item_id },
    data: {
      work_status: INVENTORY_MATCH_STATUSES.expired,
      work_failure_reason: INVENTORY_MATCH_FAILURE_REASONS.syncWindowExpired,
      updated_at: databaseDateTime(input.timestamp),
    },
  });

  return true;
}
