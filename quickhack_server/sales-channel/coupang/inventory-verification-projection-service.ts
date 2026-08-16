// QuickHack note: 쿠팡 옵션의 raw SELLABLE과 아직 원장에 반영되지 않은 주문수량을 같은 DB snapshot에서 합성합니다.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  calculateMappedOfferSellableQuantity,
  type MappedOfferSellableQuantityProjection,
} from "@/quickhack_server/sales-channel/inventory-quantity-projection-service";
import {
  ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
  INVENTORY_MATCH_STATUSES,
} from "@/quickhack_shared/sales-channel/order-matching";

const COUPANG_CHANNEL = "COUPANG";
const PENDING_ORDER_MATCH_STATUSES = [
  INVENTORY_MATCH_STATUSES.unmatched,
  INVENTORY_MATCH_STATUSES.partial,
  INVENTORY_MATCH_STATUSES.failed,
] as const;
const ALLOCATION_PAIR_QUERY_BATCH_SIZE = 100;

type ProjectedSellableQuantity = Extract<
  MappedOfferSellableQuantityProjection,
  { status: "PROJECTED" }
>;
type SkippedSellableQuantity = Extract<
  MappedOfferSellableQuantityProjection,
  { status: "SKIPPED" }
>;

export type CoupangInventoryVerificationProjection =
  | (ProjectedSellableQuantity & {
      pendingOrderQuantity: number;
      expectedChannelQuantity: number;
    })
  | (SkippedSellableQuantity & {
      pendingOrderQuantity: null;
      expectedChannelQuantity: null;
    });

function orderItemAllocationKey(input: {
  external_order_id: string;
  external_shipment_id: string;
  external_vendor_item_id: string | null;
}) {
  return JSON.stringify([
    input.external_order_id,
    input.external_shipment_id,
    input.external_vendor_item_id,
  ]);
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

export function expectedCoupangInventoryQuantity(
  ledgerQuantity: number,
  pendingOrderQuantity: number
) {
  return Math.max(0, ledgerQuantity - pendingOrderQuantity);
}

async function calculateCoupangInventoryVerificationProjectionWithClient(
  mappingId: number,
  client: Prisma.TransactionClient
): Promise<CoupangInventoryVerificationProjection> {
    const ledgerProjection = await calculateMappedOfferSellableQuantity(
      mappingId,
      client
    );

    if (ledgerProjection.status === "SKIPPED") {
      return {
        ...ledgerProjection,
        pendingOrderQuantity: null,
        expectedChannelQuantity: null,
      };
    }

    const workItems = await client.order_matching_work_queue.findMany({
      where: {
        channel: COUPANG_CHANNEL,
        external_vendor_item_id: ledgerProjection.externalVendorItemId,
        canceled: { not: 1 },
        matchable_quantity: { gt: 0 },
        work_status: { in: [...PENDING_ORDER_MATCH_STATUSES] },
      },
      select: {
        external_order_id: true,
        external_shipment_id: true,
        external_vendor_item_id: true,
        matchable_quantity: true,
      },
    });

    if (workItems.length === 0) {
      return {
        ...ledgerProjection,
        pendingOrderQuantity: 0,
        expectedChannelQuantity: ledgerProjection.ledgerQuantity,
      };
    }

    const allocationPairs = Array.from(
      new Map(
        workItems.map((item) => [
          JSON.stringify([
            item.external_order_id,
            item.external_shipment_id,
          ]),
          {
            external_order_id: item.external_order_id,
            external_shipment_id: item.external_shipment_id,
          },
        ])
      ).values()
    );
    const allocationCounts: Array<{
      external_order_id: string;
      external_shipment_id: string;
      external_vendor_item_id: string | null;
      _count: { _all: number };
    }> = [];

    for (const batch of chunks(
      allocationPairs,
      ALLOCATION_PAIR_QUERY_BATCH_SIZE
    )) {
      allocationCounts.push(
        ...(await client.match_worker_allocation.groupBy({
          by: [
            "external_order_id",
            "external_shipment_id",
            "external_vendor_item_id",
          ],
          where: {
            external_vendor_item_id: ledgerProjection.externalVendorItemId,
            OR: batch,
            allocation_status: {
              in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
            },
          },
          _count: { _all: true },
        }))
      );
    }
    const activeCountByOrderItem = new Map(
      allocationCounts.map((row) => [
        orderItemAllocationKey(row),
        row._count._all,
      ])
    );
    const pendingOrderQuantity = workItems.reduce((total, item) => {
      const activeAllocationCount =
        activeCountByOrderItem.get(orderItemAllocationKey(item)) ?? 0;

      return (
        total + Math.max(0, item.matchable_quantity - activeAllocationCount)
      );
    }, 0);

    return {
      ...ledgerProjection,
      pendingOrderQuantity,
      expectedChannelQuantity: expectedCoupangInventoryQuantity(
        ledgerProjection.ledgerQuantity,
        pendingOrderQuantity
      ),
    };
}

export async function calculateCoupangInventoryVerificationProjection(
  mappingId: number,
  client?: Prisma.TransactionClient
): Promise<CoupangInventoryVerificationProjection> {
  if (client) {
    return calculateCoupangInventoryVerificationProjectionWithClient(
      mappingId,
      client
    );
  }

  return prisma.$transaction((tx) =>
    calculateCoupangInventoryVerificationProjectionWithClient(mappingId, tx)
  );
}
