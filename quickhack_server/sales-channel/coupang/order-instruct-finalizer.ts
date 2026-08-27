import { Prisma } from "@/generated/prisma/client";
import {
  advanceSalesChannelProjectionRevision,
  SALES_CHANNEL_PROJECTION_CHANNEL,
} from "@/quickhack_server/sales-channel/projection-revision-service";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  lockInventoryQuantityBalanceKeys,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_TRANSITION_POLICY } from "@/quickhack_shared/inventory/inventory-write-rules";
import { SALES_CHANNEL_WRITE_REQUEST_TYPE } from "@/quickhack_shared/sales-channel/write-requests";
import { SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS } from "@/quickhack_shared/sales-channel/write-requests";
import { lockDeviceAggregates } from "@/quickhack_server/inventory/device-aggregate-lock";

const FINALIZABLE_ALLOCATION_STATUSES = [
  "ALLOCATED",
  "API_ACKED",
] as const;
const ACTIVE_ALLOCATION_STATUSES = [
  "ALLOCATED",
  "API_ACKED",
  "SHIPMENT_LIST_PRINTED",
] as const;

const INSTRUCT_OR_LATER_ORDER_STATUSES = new Set([
  "INSTRUCT",
  "DEPARTURE",
  "DELIVERING",
  "FINAL_DELIVERY",
]);

async function projectConfirmedInstructStatus(input: {
  tx: Prisma.TransactionClient;
  request: {
    expected_before_status: string | null;
    requested_after_status: string | null;
    targets: Array<{
      external_order_id: string | null;
      external_shipment_id: string | null;
      target_external_id: string | null;
    }>;
  };
  finalizedAt: Date;
}) {
  const expectedBeforeStatus = String(
    input.request.expected_before_status ?? ""
  ).trim();
  const requestedAfterStatus = String(
    input.request.requested_after_status ?? ""
  ).trim();

  if (!expectedBeforeStatus || requestedAfterStatus !== "INSTRUCT") {
    throw new Error(
      "The persisted Coupang order-instruct transition snapshot is invalid."
    );
  }

  const targetPairs = Array.from(
    new Map(
      input.request.targets
        .map((target) => {
          const externalOrderId = String(
            target.external_order_id ?? ""
          ).trim();
          const externalShipmentId = String(
            target.external_shipment_id ?? target.target_external_id ?? ""
          ).trim();

          return [
            `${externalOrderId}\u0000${externalShipmentId}`,
            { externalOrderId, externalShipmentId },
          ] as const;
        })
        .filter(
          ([, target]) => target.externalOrderId && target.externalShipmentId
        )
    ).values()
  );

  if (targetPairs.length === 0) {
    throw new Error(
      "The persisted Coupang order-instruct request has no exact order targets."
    );
  }

  let projectionRevision: number | null = null;
  const getProjectionRevision = async () => {
    projectionRevision ??= await advanceSalesChannelProjectionRevision(
      input.tx,
      SALES_CHANNEL_PROJECTION_CHANNEL.coupang,
      input.finalizedAt
    );
    return projectionRevision;
  };

  for (const target of targetPairs) {
    const current = await input.tx.coupang_order_raw.findUnique({
      where: {
        external_order_id_external_shipment_id: {
          external_order_id: target.externalOrderId,
          external_shipment_id: target.externalShipmentId,
        },
      },
      select: {
        coupang_order_raw_id: true,
        external_order_status: true,
        projection_revision: true,
        updated_at: true,
      },
    });

    if (!current) {
      throw new Error(
        `Coupang order ${target.externalOrderId}/${target.externalShipmentId} is missing from the local snapshot.`
      );
    }

    const currentStatus = String(current.external_order_status ?? "").trim();

    if (INSTRUCT_OR_LATER_ORDER_STATUSES.has(currentStatus)) {
      continue;
    }

    if (currentStatus !== expectedBeforeStatus) {
      throw new Error(
        `Coupang order ${target.externalOrderId}/${target.externalShipmentId} changed from ${expectedBeforeStatus} to ${currentStatus || "UNKNOWN"} before local finalization.`
      );
    }

    const updated = await input.tx.coupang_order_raw.updateMany({
      where: {
        coupang_order_raw_id: current.coupang_order_raw_id,
        external_order_status: current.external_order_status,
        projection_revision: current.projection_revision,
        updated_at: current.updated_at,
      },
      data: {
        external_order_status: requestedAfterStatus,
        projection_revision: await getProjectionRevision(),
        updated_at: input.finalizedAt,
      },
    });

    if (updated.count !== 1) {
      throw new Error(
        `Coupang order ${target.externalOrderId}/${target.externalShipmentId} changed during local finalization.`
      );
    }
  }
}

export async function finalizePersistedCoupangOrderInstruct(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  targetIds: readonly number[];
  finalizedAt: Date;
}) {
  const request = await input.tx.sales_channel_write_requests.findUnique({
    where: { sales_channel_write_request_id: input.requestId },
    include: {
      targets: {
        where: {
          sales_channel_write_request_target_id: { in: [...input.targetIds] },
          external_result_status:
            SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.succeeded,
        },
      },
    },
  });

  if (
    !request ||
    request.channel !== "COUPANG" ||
    request.request_type !==
      SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct
  ) {
    throw new Error("상품준비중 내부 확정 대상 요청을 찾을 수 없습니다.");
  }
  if (
    input.targetIds.length === 0 ||
    request.targets.length !== input.targetIds.length
  ) {
    throw new Error(
      "상품준비중 내부 확정 대상의 소유권 또는 외부 성공 상태가 일치하지 않습니다."
    );
  }

  await projectConfirmedInstructStatus({
    tx: input.tx,
    request,
    finalizedAt: input.finalizedAt,
  });

  const shipmentIds = Array.from(
    new Set(
      request.targets
        .filter((target) => target.target_type === "SHIPMENT_BOX")
        .map((target) =>
          String(
            target.external_shipment_id ?? target.target_external_id ?? ""
          ).trim()
        )
        .filter(Boolean)
    )
  );

  if (shipmentIds.length === 0) {
    throw new Error("상품준비중 요청의 배송번호 스냅샷이 없습니다.");
  }

  const workItems = await input.tx.$queryRaw<
    Array<{
      external_order_id: string;
      external_shipment_id: string;
      external_vendor_item_id: string;
      matchable_quantity: number;
    }>
  >`
    SELECT external_order_id,
           external_shipment_id,
           external_vendor_item_id,
           matchable_quantity
    FROM order_matching_work_queue
    WHERE channel = 'COUPANG'
      AND external_shipment_id IN (${Prisma.join(shipmentIds)})
    ORDER BY work_item_id ASC
    FOR UPDATE
  `;
  const allocationRoots = await input.tx.$queryRaw<
    Array<{
      allocation_id: number;
      external_order_id: string;
      external_shipment_id: string;
      external_vendor_item_id: string | null;
      pg_no: string;
    }>
  >`
    SELECT allocation_id,
           external_order_id,
           external_shipment_id,
           external_vendor_item_id,
           pg_no
    FROM match_worker_allocation
    WHERE external_shipment_id IN (${Prisma.join(shipmentIds)})
      AND allocation_status IN (${Prisma.join([...ACTIVE_ALLOCATION_STATUSES])})
    ORDER BY allocation_id ASC
  `;
  await lockDeviceAggregates(input.tx, {
    pgNos: allocationRoots.map((allocation) => allocation.pg_no),
    requireDevice: true,
    requireInventory: true,
  });
  if (allocationRoots.length > 0) {
    await input.tx.$queryRaw`
      SELECT allocation_id
      FROM match_worker_allocation
      WHERE allocation_id IN (${Prisma.join(allocationRoots.map((row) => row.allocation_id))})
      ORDER BY allocation_id ASC
      FOR UPDATE
    `;
  }
  const activeAllocations = allocationRoots;
  const itemKey = (item: {
    external_order_id: string;
    external_shipment_id: string;
    external_vendor_item_id: string | null;
  }) =>
    `${item.external_order_id}\u0000${item.external_shipment_id}\u0000${
      item.external_vendor_item_id ?? ""
    }`;
  const activeCountByItem = new Map<string, number>();
  for (const allocation of activeAllocations) {
    const key = itemKey(allocation);
    activeCountByItem.set(key, (activeCountByItem.get(key) ?? 0) + 1);
  }
  const workItemKeys = new Set(workItems.map(itemKey));
  const workShipmentIds = new Set(
    workItems.map((item) => item.external_shipment_id)
  );
  const quantityConflict = workItems.find(
    (item) =>
      (activeCountByItem.get(itemKey(item)) ?? 0) !== item.matchable_quantity
  );
  const orphanAllocation = activeAllocations.find(
    (allocation) => !workItemKeys.has(itemKey(allocation))
  );
  const missingShipmentId = shipmentIds.find(
    (shipmentId) => !workShipmentIds.has(shipmentId)
  );
  if (quantityConflict || orphanAllocation || missingShipmentId) {
    const conflictShipmentId =
      quantityConflict?.external_shipment_id ??
      orphanAllocation?.external_shipment_id ??
      missingShipmentId;
    throw new Error(
      `Coupang shipment ${conflictShipmentId} has an allocation quantity conflict.`
    );
  }

  const allocations = await input.tx.match_worker_allocation.findMany({
    where: {
      external_shipment_id: { in: shipmentIds },
      allocation_status: { in: [...FINALIZABLE_ALLOCATION_STATUSES] },
    },
    include: {
      device: {
        select: {
          inventory: {
            select: { inventory_status: true },
          },
        },
      },
    },
    orderBy: { allocation_id: "asc" },
  });
  await lockInventoryQuantityBalanceKeys(
    input.tx,
    allocations
      .map((allocation) => allocation.inventory_sku_id)
      .filter((inventorySkuId): inventorySkuId is number => Number.isSafeInteger(inventorySkuId) && Number(inventorySkuId) > 0)
      .flatMap((inventorySkuId) => [
        { inventorySkuId, inventoryStatus: INVENTORY_STATUS.sellable },
        { inventorySkuId, inventoryStatus: INVENTORY_STATUS.reserved },
      ])
  );
  let reservedCount = 0;

  for (const allocation of allocations) {
    const inventoryStatus = allocation.device.inventory?.inventory_status;

    if (inventoryStatus === INVENTORY_STATUS.sellable) {
      await transitionInventoryStatusWithLedger(input.tx, {
        pgNo: allocation.pg_no,
        expectedFromStatus: INVENTORY_STATUS.sellable,
        toStatus: INVENTORY_STATUS.reserved,
        transitionPolicy: INVENTORY_TRANSITION_POLICY.orderMatchingReservation,
        operationKey:
          `sales-channel-write:${input.requestId}:instruct:${allocation.allocation_id}`,
        movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "SALES_CHANNEL_WRITE_REQUEST",
        sourceId: String(input.requestId),
        reason: "쿠팡 상품준비중 반영 확인",
        occurredAt: input.finalizedAt,
      });
      reservedCount += 1;
    } else if (inventoryStatus !== INVENTORY_STATUS.reserved) {
      throw new Error(
        `${allocation.pg_no} 재고 상태가 판매가능 또는 주문확인이 아니므로 상품준비중 내부 확정을 중단했습니다.`
      );
    }
  }

  await input.tx.match_worker_allocation.updateMany({
    where: {
      external_shipment_id: { in: shipmentIds },
      allocation_status: "ALLOCATED",
    },
    data: {
      allocation_status: "API_ACKED",
      updated_at: input.finalizedAt,
    },
  });

  return { reservedCount, allocationCount: allocations.length };
}
