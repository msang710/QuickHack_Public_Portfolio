import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { publicBadRequest, publicConflict } from "@/quickhack_server/core/public-error";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  lockInventoryQuantityBalanceKeys,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { isRetryablePostgresqlTransactionError } from "@/quickhack_server/core/database/postgres-errors";
import { listCoupangOrderRematchPreview } from "@/quickhack_server/sales-channel/coupang/order-rematch-preview-service";
import { matchCoupangOrders } from "@/quickhack_server/sales-channel/coupang/order-matching-service";
import {
  assertWorkerLeaseActive,
  throwIfWorkerLeaseAborted,
} from "@/quickhack_server/workers/lease-guard";
import { runWorkerJobWithExecutor } from "@/quickhack_server/workers/worker-jobs";
import { ORDER_MATCHING_WORKER_KEY } from "@/quickhack_server/workers/worker-keys";
import { isWorkerShutdownRequestedError } from "@/quickhack_server/workers/shutdown-runtime";
import type { OwnedWorkerLeaseGuard } from "@/quickhack_server/workers/types";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_TRANSITION_POLICY } from "@/quickhack_shared/inventory/inventory-write-rules";
import { INVENTORY_MATCH_STATUSES } from "@/quickhack_shared/sales-channel/order-matching";
import { lockDeviceAggregates } from "@/quickhack_server/inventory/device-aggregate-lock";
import { filterTargetsWithoutManualOrderMatchIntent } from "@/quickhack_server/sales-channel/coupang/manual-order-match-intent-service";

const COUPANG_CHANNEL = "COUPANG";
const REVERSIBLE_ALLOCATION_STATUSES = ["ALLOCATED", "API_ACKED"] as const;

type RematchMatcher = typeof matchCoupangOrders;

type OrderRematchDependencies = {
  workerLease: OwnedWorkerLeaseGuard;
  runMatcher?: RematchMatcher;
  beforeManualIntentCheck?: () => Promise<void>;
};

type ManagedOrderRematchDependencies = {
  runMatcher?: RematchMatcher;
};

type RematchPreviewShipment = Awaited<
  ReturnType<typeof listCoupangOrderRematchPreview>
>["items"][number];

function requiredManifestToken(value: unknown) {
  const token = String(value ?? "").trim().toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw publicBadRequest(
      "COUPANG_ORDER_REMATCH_MANIFEST_INVALID",
      "COUPANG_ORDER_REMATCH_MANIFEST_INVALID"
    );
  }

  return token;
}

function isTransactionConflict(error: unknown) {
  return isRetryablePostgresqlTransactionError(error);
}

async function lockEligibleRematchTargets(
  tx: Prisma.TransactionClient,
  shipments: RematchPreviewShipment[]
) {
  const vendorItemIds = Array.from(
    new Set(
      shipments.flatMap((shipment) =>
        shipment.items.map((item) => item.externalVendorItemId)
      )
    )
  ).sort();
  const salesOfferIds = Array.from(
    new Set(
      shipments
        .flatMap((shipment) => shipment.items)
        .flatMap((item) => [
          item.matchedOffer?.salesOfferId ?? null,
          item.currentDefaultOffer?.salesOfferId ?? null,
        ])
        .filter((salesOfferId): salesOfferId is number => salesOfferId !== null)
    )
  ).sort((left, right) => left - right);
  const workItemIds = shipments
    .flatMap((shipment) => shipment.items.map((item) => item.workItemId))
    .sort((left, right) => left - right);
  const allocationRows = shipments
    .flatMap((shipment) => shipment.items)
    .flatMap((item) => item.allocations)
    .sort((left, right) => left.allocationId - right.allocationId);
  const pgNos = Array.from(
    new Set(allocationRows.map((allocation) => allocation.pgNo))
  ).sort();

  for (const salesOfferId of salesOfferIds) {
    await tx.$queryRaw`
      SELECT sales_offer_id
      FROM sales_offers
      WHERE sales_offer_id = ${salesOfferId}
      FOR UPDATE
    `;
  }

  for (const externalVendorItemId of vendorItemIds) {
    await tx.$queryRaw`
      SELECT mapping_id
      FROM sales_channel_product_mappings
      WHERE channel = ${COUPANG_CHANNEL}
        AND external_vendor_item_id = ${externalVendorItemId}
      FOR UPDATE
    `;
  }

  for (const workItemId of workItemIds) {
    await tx.$queryRaw`
      SELECT work_item_id
      FROM order_matching_work_queue
      WHERE work_item_id = ${workItemId}
      FOR UPDATE
    `;
  }

  for (const shipment of shipments) {
    await tx.$queryRaw`
      SELECT coupang_order_raw_id
      FROM coupang_order_raw
      WHERE external_order_id = ${shipment.externalOrderId}
        AND external_shipment_id = ${shipment.externalShipmentId}
      FOR UPDATE
    `;
  }

  const lockedDevices = await lockDeviceAggregates(tx, {
    pgNos,
    requireDevice: true,
    requireInventory: true,
  });
  const inventorySkuIds = lockedDevices.devices
    .map((device) => device.row?.inventory_sku_id ?? null)
    .filter(
      (inventorySkuId): inventorySkuId is number => inventorySkuId !== null
    );
  await lockInventoryQuantityBalanceKeys(
    tx,
    inventorySkuIds.flatMap((inventorySkuId) => [
      { inventorySkuId, inventoryStatus: INVENTORY_STATUS.sellable },
      { inventorySkuId, inventoryStatus: INVENTORY_STATUS.reserved },
    ])
  );

  for (const allocation of allocationRows) {
    await tx.$queryRaw`
      SELECT allocation_id
      FROM match_worker_allocation
      WHERE allocation_id = ${allocation.allocationId}
      FOR UPDATE
    `;
  }
}

function isWorkerLeaseLostError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "WORKER_LEASE_LOST"
  );
}

async function resetEligibleOrders(input: {
  manifestToken: string;
  user: AuthUser;
  beforeManualIntentCheck?: () => Promise<void>;
}) {
  return runMeasuredTransaction(
    prisma,
    "order-rematch.reset",
    async (tx) => {
      const initialPreview = await listCoupangOrderRematchPreview(
        { unpaginated: true },
        tx
      );

      if (initialPreview.manifestToken !== input.manifestToken) {
        throw publicConflict(
          "COUPANG_ORDER_REMATCH_PREVIEW_STALE",
          "COUPANG_ORDER_REMATCH_PREVIEW_STALE",
          { refreshRequired: true }
        );
      }

      await input.beforeManualIntentCheck?.();
      const initialEligibility = initialPreview.items.filter(
        (item) => item.eligible
      );
      const initialEligibleShipments = await filterTargetsWithoutManualOrderMatchIntent(
        tx,
        initialEligibility
      );

      if (initialEligibleShipments.length === 0) {
        throw publicConflict(
          "COUPANG_ORDER_REMATCH_TARGET_EMPTY",
          "COUPANG_ORDER_REMATCH_TARGET_EMPTY",
          { refreshRequired: true }
        );
      }

      await lockEligibleRematchTargets(tx, initialEligibleShipments);

      const lockedPreview = await listCoupangOrderRematchPreview(
        { unpaginated: true },
        tx
      );

      if (lockedPreview.manifestToken !== input.manifestToken) {
        throw publicConflict(
          "COUPANG_ORDER_REMATCH_PREVIEW_STALE",
          "COUPANG_ORDER_REMATCH_PREVIEW_STALE",
          { refreshRequired: true }
        );
      }

      const lockedEligibility = lockedPreview.items.filter(
        (item) => item.eligible
      );
      const eligibleShipments = await filterTargetsWithoutManualOrderMatchIntent(
        tx,
        lockedEligibility
      );

      const resetAt = databaseNow();
      const workItemIds: number[] = [];
      const allocationIds: number[] = [];
      const pgNos: string[] = [];

      for (const shipment of eligibleShipments) {
        for (const item of shipment.items) {
          if (!item.currentDefaultOffer) {
            throw publicConflict(
              "COUPANG_ORDER_REMATCH_MAPPING_CHANGED",
              "COUPANG_ORDER_REMATCH_MAPPING_CHANGED",
              { refreshRequired: true }
            );
          }

          for (const allocation of item.allocations) {
            await transitionInventoryStatusWithLedger(tx, {
              pgNo: allocation.pgNo,
              expectedFromStatus: INVENTORY_STATUS.reserved,
              toStatus: INVENTORY_STATUS.sellable,
              transitionPolicy: INVENTORY_TRANSITION_POLICY.orderRematchRelease,
              operationKey: `ORDER_REMATCH_RELEASE:${allocation.allocationId}`,
              movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
              sourceType: "ORDER_REMATCH",
              sourceId: String(allocation.allocationId),
              reason: "명시적 미포장 주문 재매칭을 위한 기존 배정 해제",
              actorUserId: input.user.userId,
              occurredAt: resetAt,
            });

            const canceled = await tx.match_worker_allocation.updateMany({
              where: {
                allocation_id: allocation.allocationId,
                pg_no: allocation.pgNo,
                sales_offer_id: allocation.salesOfferId,
                allocation_status: {
                  in: [...REVERSIBLE_ALLOCATION_STATUSES],
                },
              },
              data: {
                allocation_status: "CANCELED",
                released_at: resetAt,
                updated_at: resetAt,
              },
            });

            if (canceled.count !== 1) {
              throw publicConflict(
                "COUPANG_ORDER_REMATCH_ALLOCATION_CHANGED",
                "COUPANG_ORDER_REMATCH_ALLOCATION_CHANGED",
                { refreshRequired: true }
              );
            }

            allocationIds.push(allocation.allocationId);
            pgNos.push(allocation.pgNo);
          }

          const resetWorkItem = await tx.order_matching_work_queue.updateMany({
            where: {
              work_item_id: item.workItemId,
              channel: COUPANG_CHANNEL,
              work_status: INVENTORY_MATCH_STATUSES.matched,
              sales_offer_id: item.matchedOffer?.salesOfferId ?? null,
            },
            data: {
              mapping_status: "MAPPED",
              mapping_failure_reason: null,
              sales_offer_id: item.currentDefaultOffer.salesOfferId,
              required_model_label: item.currentDefaultOffer.model,
              required_storage_label: item.currentDefaultOffer.storage,
              required_color_label: item.currentDefaultOffer.color,
              required_warranty_group:
                item.currentDefaultOffer.warrantyGroup,
              work_status: INVENTORY_MATCH_STATUSES.unmatched,
              work_failure_reason: null,
              matched_at: null,
              updated_at: resetAt,
            },
          });

          if (resetWorkItem.count !== 1) {
            throw publicConflict(
              "COUPANG_ORDER_REMATCH_WORK_ITEM_CHANGED",
              "COUPANG_ORDER_REMATCH_WORK_ITEM_CHANGED",
              { refreshRequired: true }
            );
          }

          await tx.employee_activity_logs.create({
            data: {
              user_id: input.user.userId,
              action_type: "COUPANG_ORDER_REMATCH_RESET",
              target_type: "SALES_CHANNEL_ORDER_ITEM",
              target_id: String(item.workItemId),
              ...activityLogChangeData(
                {
                  mapping: {
                    salesOfferId: item.matchedOffer?.salesOfferId ?? null,
                  },
                  workStatus: INVENTORY_MATCH_STATUSES.matched,
                  activeAllocationCount: item.allocations.length,
                },
                {
                  mapping: {
                    salesOfferId: item.currentDefaultOffer.salesOfferId,
                  },
                  workStatus: INVENTORY_MATCH_STATUSES.unmatched,
                  activeAllocationCount: 0,
                  outcome: {
                    status: "RESET",
                    externalOrderId: shipment.externalOrderId,
                    externalShipmentId: shipment.externalShipmentId,
                    canceledAllocationCount: item.allocations.length,
                  },
                }
              ),
              result: "SUCCESS",
              created_at: resetAt,
            },
          });

          workItemIds.push(item.workItemId);
        }
      }

      const resetSummary = {
        manifestToken: input.manifestToken,
        resetAt,
        shipmentCount: eligibleShipments.length,
        workItemCount: workItemIds.length,
        allocationCount: allocationIds.length,
        workItemIds,
        allocationIds,
        pgNos,
        shipments: eligibleShipments.map((shipment) => ({
          externalOrderId: shipment.externalOrderId,
          externalShipmentId: shipment.externalShipmentId,
        })),
      };

      return resetSummary;
    },
    {
      isolationLevel: "Serializable",
      maxWait: 10_000,
      timeout: 60_000,
    }
  );
}

type OrderRematchResetSummary = Awaited<ReturnType<typeof resetEligibleOrders>>;

async function recordRematchFailure(input: {
  user: AuthUser;
  manifestToken: string;
  workItemIds: number[];
  error: unknown;
}) {
  const failedAt = databaseNow();

  const failureType =
    input.error instanceof Error ? input.error.name : "UNKNOWN_ERROR";

  await prisma.$transaction(
    input.workItemIds.map((workItemId) =>
      prisma.employee_activity_logs.create({
        data: {
          user_id: input.user.userId,
          action_type: "COUPANG_ORDER_REMATCH_EXECUTE",
          target_type: "SALES_CHANNEL_ORDER_ITEM",
          target_id: String(workItemId),
          ...activityLogChangeData(null, {
            outcome: {
              status: "FAILED",
              manifestToken: input.manifestToken,
              failureType,
            },
          }),
          result: "FAILED",
          created_at: failedAt,
        },
      })
    )
  );
}

async function recordRematchSuccess(input: {
  user: AuthUser;
  manifestToken: string;
  items: Array<{
    channelOrderItemId: number;
    inventoryMatchStatus: string;
    activeMatchCount: number;
    matchedNow: number;
    failureReason: string | null;
    deferred: boolean;
  }>;
}) {
  const completedAt = databaseNow();

  await prisma.$transaction(
    input.items.map((item) =>
      prisma.employee_activity_logs.create({
        data: {
          user_id: input.user.userId,
          action_type: "COUPANG_ORDER_REMATCH_EXECUTE",
          target_type: "SALES_CHANNEL_ORDER_ITEM",
          target_id: String(item.channelOrderItemId),
          ...activityLogChangeData(null, {
            outcome: {
              status: "COMPLETED",
              manifestToken: input.manifestToken,
              inventoryMatchStatus: item.inventoryMatchStatus,
              activeMatchCount: item.activeMatchCount,
              matchedNow: item.matchedNow,
              failureReason: item.failureReason,
              deferred: item.deferred,
            },
          }),
          result: "SUCCESS",
          created_at: completedAt,
        },
      })
    )
  );
}

export async function resetAndRematchCoupangOrders(
  input: { manifestToken?: unknown },
  user: AuthUser,
  dependencies: OrderRematchDependencies
) {
  const manifestToken = requiredManifestToken(input.manifestToken);
  const workerLease = dependencies.workerLease;
  let reset: OrderRematchResetSummary;

  await assertWorkerLeaseActive(workerLease);

  try {
    reset = await resetEligibleOrders({
      manifestToken,
      user,
      beforeManualIntentCheck: dependencies.beforeManualIntentCheck,
    });
  } catch (error) {
    if (isTransactionConflict(error)) {
      throw publicConflict(
        "COUPANG_ORDER_REMATCH_CONCURRENT_CHANGE",
        "COUPANG_ORDER_REMATCH_CONCURRENT_CHANGE",
        { refreshRequired: true }
      );
    }

    throw error;
  }
  const runMatcher = dependencies.runMatcher ?? matchCoupangOrders;
  let result: Awaited<ReturnType<RematchMatcher>>;

  try {
    await assertWorkerLeaseActive(workerLease);
    result = await runMatcher(
      {
        workItemIds: reset.workItemIds,
        includeFailed: true,
        includeBlockedItems: false,
      },
      user,
      workerLease
    );
  } catch (error) {
    await recordRematchFailure({
      user,
      manifestToken,
      workItemIds: reset.workItemIds,
      error,
    }).catch(() => undefined);

    if (
      isWorkerShutdownRequestedError(error) ||
      isWorkerLeaseLostError(error)
    ) {
      throw error;
    }

    return {
      resetCommitted: true as const,
      reset,
      rematch: {
        status: "FAILED" as const,
        reasonCode: "ORDER_REMATCH_AFTER_RESET_FAILED" as const,
      },
    };
  }

  // A successful matcher must never be reclassified as a failed rematch merely
  // because the outcome audit write failed after the business state committed.
  await recordRematchSuccess({
    user,
    manifestToken,
    items: result.items,
  });

  return {
    resetCommitted: true as const,
    reset,
    rematch: {
      status: "COMPLETED" as const,
      summary: result.summary,
      items: result.items,
    },
  };
}

export async function runManagedCoupangOrderRematch(
  input: { manifestToken?: unknown },
  user: AuthUser,
  dependencies: ManagedOrderRematchDependencies = {}
) {
  const workerResult = await runWorkerJobWithExecutor(
    ORDER_MATCHING_WORKER_KEY,
    user,
    async (context) => {
      throwIfWorkerLeaseAborted(context);
      const result = await resetAndRematchCoupangOrders(input, user, {
        workerLease: context,
        runMatcher: dependencies.runMatcher,
      });
      await context.updateProgress(
        result.reset.workItemCount,
        result.reset.workItemCount
      );

      return {
        summary: result,
        progressCurrent: result.reset.workItemCount,
        progressTotal: result.reset.workItemCount,
      };
    }
  );

  if (workerResult.skipped) {
    throw publicConflict(
      "COUPANG_ORDER_REMATCH_MATCHING_BUSY",
      "COUPANG_ORDER_REMATCH_MATCHING_BUSY",
      { refreshRequired: true }
    );
  }

  return workerResult.result as Awaited<
    ReturnType<typeof resetAndRematchCoupangOrders>
  >;
}
