import { prisma } from "@/quickhack_server/core/prisma";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "@/quickhack_server/core/database/keyset-page";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import { publicConflict } from "@/quickhack_server/core/public-error";
import { maskPhone } from "@/quickhack_server/security/sensitive-data";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { Prisma } from "@/generated/prisma/client";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_TRANSITION_POLICY } from "@/quickhack_shared/inventory/inventory-write-rules";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import {
  kstDayRange,
  quickHackClock,
} from "@/quickhack_shared/core/time";
import {
  apiDateTime,
  databaseDate,
  databaseDateTime,
  databaseNow,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { warrantyGroupLabel } from "@/quickhack_shared/sales-channel/sales-matching";
import {
  ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
} from "@/quickhack_shared/sales-channel/order-matching";
import {
  assertNoShipmentReturnConflicts,
  isShipmentReturnConflictError,
} from "@/quickhack_server/returns/shipment-return-conflict-service";
import { SALES_CHANNEL_WRITE_REVIEW_STATUSES } from "@/quickhack_shared/sales-channel/write-requests";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { transitionShipmentPrintBatchStatus } from "@/quickhack_server/shipment/shipment-print-batch-state-service";
import { lockDeviceAggregates } from "@/quickhack_server/inventory/device-aggregate-lock";
import {
  cancelShipmentPackageGroups,
  createDraftShipmentPackageGroups,
  expandPackageGroupSelection,
  freezeShipmentPackageGroups,
  packageGroupKeyForAllocation,
} from "@/quickhack_server/shipment/shipment-package-group-service";
import {
  SHIPMENT_PRINT_BATCH_STATUS,
  type ShipmentPrintBatchStatus,
} from "@/quickhack_shared/shipment/shipment-print-batch-status";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 3000;
const ORDER_LIST_CURSOR_CONTRACT = "shipment-order-list:v1";

const SHIPMENT_PRINT_TABS = {
  "coupang-2y": {
    key: "coupang-2y",
    label: "2년 보증",
    warrantyKeyword: "2년",
  },
  "coupang-1y": {
    key: "coupang-1y",
    label: "1년 보증",
    warrantyKeyword: "1년",
  },
} as const;

const ACTIVE_SHIPMENT_PRINT_BATCH_STATUSES = [
  SHIPMENT_PRINT_BATCH_STATUS.pending,
  SHIPMENT_PRINT_BATCH_STATUS.printDialogClosed,
  SHIPMENT_PRINT_BATCH_STATUS.confirmed,
] as const;
const ALLOCATION_STATUS = {
  allocated: "ALLOCATED",
  apiAcked: "API_ACKED",
  shipmentListPrinted: "SHIPMENT_LIST_PRINTED",
} as const;
const PRINT_READY_ALLOCATION_STATUSES = [ALLOCATION_STATUS.apiAcked] as const;
const COUPANG_INSTRUCT_ORDER_STATUS = "INSTRUCT";
const COUPANG_DELIVERING_ORDER_STATUS = "DELIVERING";

export type ShipmentOrderListMode = "all" | "matched";
type ShipmentPrintTabKey = keyof typeof SHIPMENT_PRINT_TABS;
type ShipmentDataClient = typeof prisma | Prisma.TransactionClient;

const workItemSalesOfferInclude = {
  sales_offer: {
    include: {
      model_option: true,
      storage_option: true,
      color_option: true,
      warranty_group_option: true,
    },
  },
} satisfies Prisma.order_matching_work_queueInclude;

type WorkItemWithSalesOffer = Prisma.order_matching_work_queueGetPayload<{
  include: typeof workItemSalesOfferInclude;
}>;

function workItemOfferValues(row: WorkItemWithSalesOffer) {
  const offer = row.sales_offer;

  return {
    salesOfferId: row.sales_offer_id,
    salesOfferCode: offer?.offer_code ?? null,
    model: row.required_model_label,
    requiredStorage: row.required_storage_label,
    requiredColor: row.required_color_label,
    requiredWarrantyGroup: row.required_warranty_group,
  };
}

const shipmentPrintAllocationInclude = {
  order: true,
  device: {
    include: {
      inventory: true,
    },
  },
  coupang_return_allocations: {
    select: {
      coupang_return_allocation_id: true,
    },
  },
} satisfies Prisma.match_worker_allocationInclude;

type ShipmentPrintAllocation = Prisma.match_worker_allocationGetPayload<{
  include: typeof shipmentPrintAllocationInclude;
}>;

const shipmentPrintBatchInclude = {
  items: {
    orderBy: [
      { print_line_no: "asc" },
      { shipment_list_print_batch_item_id: "asc" },
    ],
    include: {
      allocation: {
        include: shipmentPrintAllocationInclude,
      },
      package_group: true,
    },
  },
} satisfies Prisma.sales_channel_shipment_list_print_batchesInclude;

type ShipmentPrintBatch = Prisma.sales_channel_shipment_list_print_batchesGetPayload<{
  include: typeof shipmentPrintBatchInclude;
}>;

function shipmentPrintBatchPackageGroupIds(batch: ShipmentPrintBatch) {
  const missingPackageGroupSnapshot = batch.items.some(
    (item) => item.package_group_id === null
  );
  const packageGroupIds = Array.from(
    new Set(
      batch.items
        .map((item) => item.package_group_id)
        .filter((id): id is number => id !== null)
    )
  );
  const snapshotMatches =
    !missingPackageGroupSnapshot &&
    batch.items.length === batch.item_count &&
    packageGroupIds.length === batch.package_group_count;

  if (!snapshotMatches) {
    throw publicConflict(
      "SHIPMENT_PRINT_BATCH_SNAPSHOT_INVALID",
      "출고 출력 차수의 합포장 스냅샷이 일치하지 않아 작업을 중단했습니다.",
      {
        batchId: batch.shipment_list_print_batch_id,
        expectedItemCount: batch.item_count,
        actualItemCount: batch.items.length,
        expectedPackageGroupCount: batch.package_group_count,
        actualPackageGroupCount: packageGroupIds.length,
        missingPackageGroupSnapshot,
      }
    );
  }

  return packageGroupIds;
}

function shipmentPrintBatchTerminalConflict(
  batchId: number,
  currentStatus: ShipmentPrintBatchStatus,
  requestedStatus: ShipmentPrintBatchStatus
) {
  return publicConflict(
    "SHIPMENT_PRINT_BATCH_STATE_CONFLICT",
    currentStatus === SHIPMENT_PRINT_BATCH_STATUS.confirmed
      ? "이미 확정된 출고 출력 차수는 폐기할 수 없습니다."
      : "이미 폐기된 출고 출력 차수는 확정할 수 없습니다.",
    { batchId, currentStatus, requestedStatus }
  );
}

const deliveringAllocationInclude = {
  device: {
    include: {
      inventory: true,
    },
  },
  shipment_list_print_batch_items: {
    include: {
      batch: true,
    },
    orderBy: [
      { print_line_no: "asc" },
      { shipment_list_print_batch_item_id: "asc" },
    ],
  },
} satisfies Prisma.match_worker_allocationInclude;

type DeliveringAllocation = Prisma.match_worker_allocationGetPayload<{
  include: typeof deliveringAllocationInclude;
}>;

function positiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function normalizeMode(value: unknown): ShipmentOrderListMode {
  return String(value ?? "").trim() === "matched" ? "matched" : "all";
}

function normalizeShipmentPrintTab(value: unknown) {
  const tabKey = String(value ?? "").trim() as ShipmentPrintTabKey;
  return SHIPMENT_PRINT_TABS[tabKey] ?? null;
}

function compactText(values: Array<string | number | null | undefined>) {
  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" / ");
}

function uniqueText(values: Array<string | number | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  ).join("\n");
}

function shipmentItemKey(input: {
  external_order_id: string;
  external_shipment_id?: string | null;
  external_vendor_item_id?: string | null;
}) {
  return [
    input.external_order_id,
    input.external_shipment_id ?? "",
    input.external_vendor_item_id ?? "",
  ].join(":");
}

function shipmentPairKey(input: {
  external_order_id: string;
  external_shipment_id: string;
}) {
  return JSON.stringify([
    input.external_order_id,
    input.external_shipment_id,
  ]);
}

function uniqueShipmentPairs(
  rows: Array<{
    external_order_id: string;
    external_shipment_id: string;
  }>
) {
  const pairs = new Map<
    string,
    { external_order_id: string; external_shipment_id: string }
  >();

  for (const row of rows) {
    const pair = {
      external_order_id: row.external_order_id,
      external_shipment_id: row.external_shipment_id,
    };

    pairs.set(shipmentPairKey(pair), pair);
  }

  return Array.from(pairs.values());
}

function hasWarrantyKeyword(value: string | null | undefined, keyword: string) {
  return String(value ?? "").replace(/\s+/g, "").includes(keyword.replace(/\s+/g, ""));
}

function displayWarranty(
  warrantyGroup: string | null | undefined,
  fallbackWarranty: string | null | undefined
) {
  const label = warrantyGroupLabel(warrantyGroup);

  return label === "-" ? (fallbackWarranty ?? "") : label;
}

function compareNullableText(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined
) {
  const leftText = left instanceof Date ? left.toISOString() : String(left ?? "").trim();
  const rightText = right instanceof Date ? right.toISOString() : String(right ?? "").trim();

  if (!leftText && !rightText) {
    return 0;
  }

  if (!leftText) {
    return 1;
  }

  if (!rightText) {
    return -1;
  }

  return leftText.localeCompare(rightText);
}

function sortShipmentPrintAllocationsByOrderedAt(
  allocations: ShipmentPrintAllocation[]
) {
  const groupOrder = new Map<
    string,
    {
      firstAllocationId: number;
      firstOrderedAt: Date | string | null;
    }
  >();

  for (const allocation of allocations) {
    const groupKey = packageGroupKeyForAllocation(allocation);
    const orderedAt = allocation.order.ordered_at;
    const current = groupOrder.get(groupKey);

    if (
      !current ||
      compareNullableText(orderedAt, current.firstOrderedAt) < 0 ||
      (compareNullableText(orderedAt, current.firstOrderedAt) === 0 &&
        allocation.allocation_id < current.firstAllocationId)
    ) {
      groupOrder.set(groupKey, {
        firstAllocationId: allocation.allocation_id,
        firstOrderedAt: orderedAt,
      });
    }
  }

  return [...allocations].sort((left, right) => {
    const leftGroupKey = packageGroupKeyForAllocation(left);
    const rightGroupKey = packageGroupKeyForAllocation(right);
    const leftGroup = groupOrder.get(leftGroupKey);
    const rightGroup = groupOrder.get(rightGroupKey);
    const groupOrderResult = compareNullableText(
      leftGroup?.firstOrderedAt,
      rightGroup?.firstOrderedAt
    );

    if (groupOrderResult !== 0) {
      return groupOrderResult;
    }

    if (leftGroupKey !== rightGroupKey) {
      return (leftGroup?.firstAllocationId ?? left.allocation_id) -
        (rightGroup?.firstAllocationId ?? right.allocation_id);
    }

    const orderedAtResult = compareNullableText(
      left.order.ordered_at,
      right.order.ordered_at
    );

    if (orderedAtResult !== 0) {
      return orderedAtResult;
    }

    const vendorItemResult = compareNullableText(
      left.external_vendor_item_id,
      right.external_vendor_item_id
    );

    if (vendorItemResult !== 0) {
      return vendorItemResult;
    }

    return left.allocation_id - right.allocation_id;
  });
}

function todayPrintRange() {
  return kstDayRange();
}

function uniquePositiveIds(value: unknown) {
  const source = Array.isArray(value) ? value : [];
  const ids = source
    .map((item) => Number.parseInt(String(item ?? ""), 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  return Array.from(new Set(ids));
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function requiredPositiveId(value: unknown, label: string) {
  const id = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${label}이 올바르지 않습니다.`);
  }

  return id;
}

function toShipmentPrintRow(
  allocation: ShipmentPrintAllocation,
  batchOverride?: {
    batchId?: number | null;
    batchNo?: number | null;
    batchLabel?: string | null;
    printLineNo?: number | null;
    printedAt?: Date | string | null;
    packageGroupId?: number | null;
    packageGroupKey?: string | null;
    packageGroupSize?: number | null;
    packageGroupMemberSequence?: number | null;
  }
) {
  const order = allocation.order;
  const device = allocation.device;
  const returnExcluded =
    allocation.allocation_status === "CANCELED" &&
    allocation.coupang_return_allocations.length > 0;

  return {
    allocationId: allocation.allocation_id,
    batchId:
      batchOverride?.batchId ?? allocation.shipment_list_print_batch_id ?? null,
    batchNo:
      batchOverride?.batchNo ?? allocation.shipment_list_print_batch_no ?? null,
    batchLabel:
      batchOverride?.batchLabel ??
      allocation.shipment_list_print_batch_label ??
      "",
    printLineNo: batchOverride?.printLineNo ?? null,
    printedAt:
      apiDateTime(batchOverride?.printedAt ?? allocation.shipment_list_printed_at) ?? "",
    packageGroupId: batchOverride?.packageGroupId ?? null,
    packageGroupKey:
      batchOverride?.packageGroupKey ?? packageGroupKeyForAllocation(allocation),
    packageGroupSize: batchOverride?.packageGroupSize ?? 1,
    packageGroupMemberSequence:
      batchOverride?.packageGroupMemberSequence ?? null,
    channel: "COUPANG",
    externalOrderId: order.external_order_id,
    externalShipmentId: allocation.external_shipment_id ?? "",
    orderedAt: apiDateTime(order.ordered_at),
    pgNo: allocation.pg_no,
    uniqueNo: formatModelSeqLabel(device.model, device.model_seq),
    warranty: displayWarranty(allocation.required_warranty_group, device.warranty),
    saleGrade: device.sale_grade ?? "",
    model: device.model,
    modelSeq: device.model_seq,
    storage: device.storage,
    color: device.color,
    receiverName: order.receiver_name ?? "",
    receiverAddress: compactText([
      order.receiver_post_code,
      order.receiver_address_1,
      order.receiver_address_2,
    ]),
    allocationStatus: allocation.allocation_status,
    inventoryStatus: device.inventory?.inventory_status ?? null,
    returnExcluded,
    exclusionReason: returnExcluded ? "반품 처리로 출고 대상에서 제외" : null,
  };
}

function shipmentBatchLineLabel(allocation: DeliveringAllocation) {
  const printItem =
    allocation.shipment_list_print_batch_items.find(
      (item) =>
        item.shipment_list_print_batch_id ===
        allocation.shipment_list_print_batch_id
    ) ?? null;
  const label = String(
    allocation.shipment_list_print_batch_label ??
      printItem?.batch?.batch_label ??
      ""
  ).trim();

  if (label) {
    return printItem ? `${label}-${printItem.print_line_no}` : label;
  }

  return allocation.shipment_list_print_batch_no
    ? `${allocation.shipment_list_print_batch_no}차${
        printItem ? `-${printItem.print_line_no}` : ""
      }`
    : "";
}

function findShipmentPrintAllocations(
  client: ShipmentDataClient,
  allocationIds?: number[]
) {
  return client.match_worker_allocation.findMany({
    where: {
      ...(allocationIds
        ? {
            allocation_id: {
              in: allocationIds,
            },
          }
        : {}),
      allocation_status: {
        in: [...PRINT_READY_ALLOCATION_STATUSES],
      },
      shipment_list_printed_at: null,
      shipment_list_print_batch_id: null,
      shipment_list_print_batch_items: {
        none: {
          batch: {
            batch_status: { in: [...ACTIVE_SHIPMENT_PRINT_BATCH_STATUSES] },
          },
        },
      },
      order: {
        external_order_status: COUPANG_INSTRUCT_ORDER_STATUS,
      },
      device: {
        inventory: {
          is: {
            inventory_status: INVENTORY_STATUS.reserved,
          },
        },
      },
    },
    orderBy: [
      { allocated_at: "asc" },
      { allocation_id: "asc" },
    ],
    include: shipmentPrintAllocationInclude,
  }).then((allocations) =>
    filterExactQuantityShipmentAllocations(client, allocations)
  );
}

async function filterExactQuantityShipmentAllocations(
  client: ShipmentDataClient,
  allocations: ShipmentPrintAllocation[],
  lockRows = false,
  settledReturnAllocations: ShipmentPrintAllocation[] = []
) {
  const shipmentPairs = uniqueShipmentPairs(
    allocations.map((allocation) => ({
      external_order_id: allocation.external_order_id,
      external_shipment_id: allocation.external_shipment_id,
    }))
  );
  if (shipmentPairs.length === 0) return [];

  const workItems: Array<{
    external_order_id: string;
    external_shipment_id: string;
    external_vendor_item_id: string;
    matchable_quantity: number;
    manual_recovery_status: string;
  }> = [];
  const activeAllocations: Array<{
    external_order_id: string;
    external_shipment_id: string;
    external_vendor_item_id: string | null;
  }> = [];

  for (const batch of chunks(shipmentPairs, 100)) {
    if (lockRows) {
      const pairPredicate = Prisma.join(
        batch.map(
          (pair) =>
            Prisma.sql`(
              external_order_id = ${pair.external_order_id}
              AND external_shipment_id = ${pair.external_shipment_id}
            )`
        ),
        " OR "
      );
      await client.$queryRaw`
        SELECT work_item_id
        FROM order_matching_work_queue
        WHERE channel = 'COUPANG'
          AND (${pairPredicate})
        ORDER BY work_item_id ASC
        FOR UPDATE
      `;
      const allocationPgRows = await client.$queryRaw<Array<{ pg_no: string }>>`
        SELECT pg_no
        FROM match_worker_allocation
        WHERE (${pairPredicate})
          AND allocation_status IN (${Prisma.join([
            ...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
          ])})
        ORDER BY pg_no ASC
      `;
      await lockDeviceAggregates(client as Prisma.TransactionClient, {
        pgNos: allocationPgRows.map((allocation) => allocation.pg_no),
        requireDevice: true,
        requireInventory: true,
      });
      await client.$queryRaw`
        SELECT allocation_id
        FROM match_worker_allocation
        WHERE (${pairPredicate})
          AND allocation_status IN (${Prisma.join([
            ...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
          ])})
        ORDER BY allocation_id ASC
        FOR UPDATE
      `;
    }
    workItems.push(
      ...(await client.order_matching_work_queue.findMany({
        where: { channel: "COUPANG", OR: batch },
        select: {
          external_order_id: true,
          external_shipment_id: true,
          external_vendor_item_id: true,
          matchable_quantity: true,
          manual_recovery_status: true,
        },
      }))
    );
    activeAllocations.push(
      ...(await client.match_worker_allocation.findMany({
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

  const activeCountByItem = new Map<string, number>();
  for (const allocation of activeAllocations) {
    const key = shipmentItemKey(allocation);
    activeCountByItem.set(key, (activeCountByItem.get(key) ?? 0) + 1);
  }
  const settledReturnCountByItem = new Map<string, number>();
  for (const allocation of settledReturnAllocations) {
    const key = shipmentItemKey(allocation);
    settledReturnCountByItem.set(
      key,
      (settledReturnCountByItem.get(key) ?? 0) + 1
    );
  }
  const invalidShipments = new Set<string>();
  const workItemKeys = new Set<string>();
  const workShipmentKeys = new Set<string>();
  for (const item of workItems) {
    workItemKeys.add(shipmentItemKey(item));
    workShipmentKeys.add(shipmentPairKey(item));
    if (
      item.manual_recovery_status !== "NONE" ||
      (activeCountByItem.get(shipmentItemKey(item)) ?? 0) +
        (settledReturnCountByItem.get(shipmentItemKey(item)) ?? 0) !==
      item.matchable_quantity
    ) {
      invalidShipments.add(shipmentPairKey(item));
    }
  }
  for (const allocation of activeAllocations) {
    if (!workItemKeys.has(shipmentItemKey(allocation))) {
      invalidShipments.add(shipmentPairKey(allocation));
    }
  }
  for (const pair of shipmentPairs) {
    if (!workShipmentKeys.has(shipmentPairKey(pair))) {
      invalidShipments.add(shipmentPairKey(pair));
    }
  }

  return allocations.filter(
    (allocation) => !invalidShipments.has(shipmentPairKey(allocation))
  );
}

function toShipmentPrintBatchDto(batch: ShipmentPrintBatch) {
  const packageGroupSizes = new Map<number, number>();

  for (const item of batch.items) {
    if (item.package_group_id) {
      packageGroupSizes.set(
        item.package_group_id,
        (packageGroupSizes.get(item.package_group_id) ?? 0) + 1
      );
    }
  }

  const items = batch.items.map((item) =>
    toShipmentPrintRow(item.allocation, {
      batchId: batch.shipment_list_print_batch_id,
      batchNo: batch.batch_no,
      batchLabel: batch.batch_label,
      printLineNo: item.print_line_no,
      printedAt: batch.confirmed_at ?? batch.printed_at,
      packageGroupId: item.package_group_id,
      packageGroupKey: item.package_group?.grouping_key ?? null,
      packageGroupSize: item.package_group_id
        ? packageGroupSizes.get(item.package_group_id) ?? 1
        : 1,
      packageGroupMemberSequence: item.package_group_id
        ? batch.items.filter(
            (candidate) =>
              candidate.package_group_id === item.package_group_id &&
              candidate.print_line_no <= item.print_line_no
          ).length
        : null,
    })
  );
  const returnExcludedCount = items.filter(
    (item) => item.returnExcluded
  ).length;

  return {
    batchId: batch.shipment_list_print_batch_id,
    batchNo: batch.batch_no,
    batchLabel: batch.batch_label,
    tabKey: batch.tab_key,
    tabLabel: batch.tab_label,
    warrantyLabel: batch.warranty_label,
    batchStatus: batch.batch_status,
    printedAt: apiDateTime(batch.printed_at),
    printDialogClosedAt: apiDateTime(batch.print_dialog_closed_at),
    confirmedAt: apiDateTime(batch.confirmed_at),
    canceledAt: apiDateTime(batch.canceled_at),
    itemCount: batch.item_count,
    packageGroupCount:
      batch.package_group_count ||
      new Set(
        batch.items.map(
          (item) =>
            item.package_group_id ??
            packageGroupKeyForAllocation(item.allocation)
        )
      ).size,
    effectiveItemCount: items.length - returnExcludedCount,
    returnExcludedCount,
    items,
  };
}

export { isShipmentReturnConflictError };

async function workRowsForAllocations(
  client: ShipmentDataClient,
  allocations: ShipmentPrintAllocation[]
) {
  const itemKeys = new Map<
    string,
    {
      external_order_id: string;
      external_shipment_id: string;
      external_vendor_item_id: string;
    }
  >();
  for (const allocation of allocations) {
    const externalVendorItemId = String(
      allocation.external_vendor_item_id ?? ""
    ).trim();
    if (!externalVendorItemId) continue;
    const key = shipmentItemKey(allocation);
    itemKeys.set(key, {
      external_order_id: allocation.external_order_id,
      external_shipment_id: allocation.external_shipment_id,
      external_vendor_item_id: externalVendorItemId,
    });
  }
  const rows: WorkItemWithSalesOffer[] = [];
  for (const batch of chunks([...itemKeys.values()], 100)) {
    rows.push(
      ...(await client.order_matching_work_queue.findMany({
        where: { channel: "COUPANG", OR: batch },
        include: workItemSalesOfferInclude,
      }))
    );
  }
  return rows;
}

type MatchedGroupPosition = {
  orderedAt: string | null;
  firstAllocationId: number;
  groupKey: string;
};

function matchedGroupPosition(
  groupKey: string,
  allocations: ShipmentPrintAllocation[]
): MatchedGroupPosition {
  const first = sortShipmentPrintAllocationsByOrderedAt(allocations)[0];
  return {
    orderedAt:
      first?.order.ordered_at instanceof Date
        ? first.order.ordered_at.toISOString()
        : first?.order.ordered_at
          ? String(first.order.ordered_at)
          : null,
    firstAllocationId: Math.min(
      ...allocations.map((allocation) => allocation.allocation_id)
    ),
    groupKey,
  };
}

function compareMatchedGroupPosition(
  left: MatchedGroupPosition,
  right: MatchedGroupPosition
) {
  return (
    compareNullableText(left.orderedAt, right.orderedAt) ||
    left.firstAllocationId - right.firstAllocationId ||
    left.groupKey.localeCompare(right.groupKey)
  );
}

async function loadMatchedOrderPage(input: {
  client: ShipmentDataClient;
  cursor?: unknown;
  limit: number;
}) {
  const queryIdentity = { mode: "matched", eligibility: "PRINT_READY_V1" };
  const cursorText = String(input.cursor ?? "").trim();
  const decoded = cursorText
    ? decodeKeysetCursor<
        {
          maxAllocationId: number;
          orderCount: number;
          orderItemCount: number;
          matchedOrderItemCount: number;
          fullyMatchedOrderItemCount: number;
          matchedDeviceCount: number;
          packageGroupCount: number;
        },
        MatchedGroupPosition
      >({
        cursor: cursorText,
        contract: ORDER_LIST_CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;
  const currentEligible = await findShipmentPrintAllocations(input.client);
  const maxAllocationId = decoded?.snapshot.maxAllocationId ??
    currentEligible.reduce(
      (maximum, allocation) => Math.max(maximum, allocation.allocation_id),
      0
    );
  const eligible = currentEligible.filter(
    (allocation) => allocation.allocation_id <= maxAllocationId
  );
  const allWorkRows = await workRowsForAllocations(input.client, eligible);
  const allocationsByGroup = new Map<string, ShipmentPrintAllocation[]>();
  for (const allocation of eligible) {
    const key = packageGroupKeyForAllocation(allocation);
    const current = allocationsByGroup.get(key) ?? [];
    current.push(allocation);
    allocationsByGroup.set(key, current);
  }
  const groups = [...allocationsByGroup.entries()]
    .map(([groupKey, allocations]) => ({
      groupKey,
      allocations,
      position: matchedGroupPosition(groupKey, allocations),
    }))
    .sort((left, right) =>
      compareMatchedGroupPosition(left.position, right.position)
    );
  const snapshot = decoded?.snapshot ?? {
    maxAllocationId,
    orderCount: new Set(eligible.map((row) => row.external_order_id)).size,
    orderItemCount: allWorkRows.length,
    matchedOrderItemCount: allWorkRows.length,
    fullyMatchedOrderItemCount: allWorkRows.filter(
      (row) => row.work_status === "MATCHED"
    ).length,
    matchedDeviceCount: eligible.length,
    packageGroupCount: groups.length,
  };
  const remaining = decoded
    ? groups.filter(
        (group) =>
          compareMatchedGroupPosition(group.position, decoded.position) > 0
      )
    : groups;
  const pageGroups = remaining.slice(0, input.limit);
  const hasMore = remaining.length > pageGroups.length;
  const pageGroupKeys = new Set(pageGroups.map((group) => group.groupKey));
  const allocations = eligible.filter((allocation) =>
    pageGroupKeys.has(packageGroupKeyForAllocation(allocation))
  );
  const pageItemKeys = new Set(allocations.map(shipmentItemKey));
  const rows = allWorkRows.filter((row) => pageItemKeys.has(shipmentItemKey(row)));
  const lastGroup = pageGroups.at(-1) ?? null;
  return {
    rows,
    allocations,
    summary: snapshot,
    hasMore,
    nextCursor:
      hasMore && lastGroup
        ? encodeKeysetCursor({
            contract: ORDER_LIST_CURSOR_CONTRACT,
            queryIdentity,
            snapshot,
            position: lastGroup.position,
          })
        : null,
    totalCount: snapshot.orderItemCount,
    coverage: "COMPLETE" as const,
  };
}

async function loadAllOrderPage(input: {
  client: ShipmentDataClient;
  cursor?: unknown;
  limit: number;
}) {
  const queryIdentity = { mode: "all" };
  const cursorText = String(input.cursor ?? "").trim();
  const decoded = cursorText
    ? decodeKeysetCursor<
        {
          maxWorkItemId: number;
          totalCount: number;
          orderCount: number;
          matchedOrderItemCount: number;
          fullyMatchedOrderItemCount: number;
          matchedDeviceCount: number;
        },
        { workItemId: number }
      >({
        cursor: cursorText,
        contract: ORDER_LIST_CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;
  const snapshot = decoded?.snapshot ??
    (await (async () => {
      const [aggregate, totals, matchedDeviceCount] = await Promise.all([
        input.client.order_matching_work_queue.aggregate({
          where: { channel: "COUPANG" },
          _max: { work_item_id: true },
        }),
        input.client.$queryRaw<Array<{
          total_count: bigint;
          order_count: bigint;
          matched_item_count: bigint;
          fully_matched_count: bigint;
        }>>`
          SELECT
            COUNT(*)::bigint AS total_count,
            COUNT(DISTINCT w.external_order_id)::bigint AS order_count,
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1
                FROM match_worker_allocation AS a
                WHERE a.external_order_id = w.external_order_id
                  AND a.external_shipment_id = w.external_shipment_id
                  AND COALESCE(a.external_vendor_item_id, '') = w.external_vendor_item_id
                  AND a.allocation_status IN (${Prisma.join([
                    ...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
                  ])})
              )
            )::bigint AS matched_item_count,
            COUNT(*) FILTER (WHERE w.work_status = 'MATCHED')::bigint
              AS fully_matched_count
          FROM order_matching_work_queue AS w
          WHERE w.channel = 'COUPANG'
        `,
        input.client.match_worker_allocation.count({
          where: {
            allocation_status: {
              in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
            },
          },
        }),
      ]);
      const total = totals[0];
      const safeCount = (value: bigint | undefined) => {
        const count = Number(value ?? 0n);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error("주문 목록 집계 건수가 안전한 범위를 초과했습니다.");
        }
        return count;
      };
      return {
        maxWorkItemId: aggregate._max.work_item_id ?? 0,
        totalCount: safeCount(total?.total_count),
        orderCount: safeCount(total?.order_count),
        matchedOrderItemCount: safeCount(total?.matched_item_count),
        fullyMatchedOrderItemCount: safeCount(total?.fully_matched_count),
        matchedDeviceCount,
      };
    })());
  const beforeId = decoded?.position.workItemId ?? null;
  const loaded = await input.client.order_matching_work_queue.findMany({
    where: {
      channel: "COUPANG",
      work_item_id: {
        lte: snapshot.maxWorkItemId,
        ...(beforeId ? { lt: beforeId } : {}),
      },
    },
    orderBy: { work_item_id: "desc" },
    take: input.limit + 1,
    include: workItemSalesOfferInclude,
  });
  const hasMore = loaded.length > input.limit;
  const rows = loaded.slice(0, input.limit);
  const last = rows.at(-1) ?? null;
  return {
    rows,
    allocations: [] as ShipmentPrintAllocation[],
    summary: {
      orderCount: snapshot.orderCount,
      orderItemCount: snapshot.totalCount,
      matchedOrderItemCount: snapshot.matchedOrderItemCount,
      fullyMatchedOrderItemCount: snapshot.fullyMatchedOrderItemCount,
      matchedDeviceCount: snapshot.matchedDeviceCount,
      packageGroupCount: 0,
    },
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeKeysetCursor({
            contract: ORDER_LIST_CURSOR_CONTRACT,
            queryIdentity,
            snapshot,
            position: { workItemId: last.work_item_id },
          })
        : null,
    totalCount: snapshot.totalCount,
    coverage: "COMPLETE" as const,
  };
}

async function listShipmentOrderItemsInSnapshot(
  client: Prisma.TransactionClient,
  input: {
  mode?: unknown;
  limit?: unknown;
  cursor?: unknown;
  }
) {
  const mode = normalizeMode(input.mode);
  const limit = positiveInt(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const page =
    mode === "matched"
      ? await loadMatchedOrderPage({ client, cursor: input.cursor, limit })
      : await loadAllOrderPage({ client, cursor: input.cursor, limit });
  const rows = page.rows;
  const externalOrderIds = Array.from(
    new Set(rows.map((row) => row.external_order_id))
  );
  const shipmentPairs = uniqueShipmentPairs(rows);
  const rawOrderRows = [];
  const allocationRows = [...page.allocations];

  for (const batch of chunks(shipmentPairs, 100)) {
    rawOrderRows.push(
      ...(await client.coupang_order_raw.findMany({
        where: {
          OR: batch.map((pair) => ({
            external_order_id: pair.external_order_id,
            external_shipment_id: pair.external_shipment_id,
          })),
        },
      }))
    );
  }

  for (const batch of mode === "matched" ? [] : chunks(externalOrderIds, 100)) {
    allocationRows.push(
      ...(await client.match_worker_allocation.findMany({
        where: {
          external_order_id: { in: batch },
          allocation_status: {
            in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
          },
        },
        orderBy: [{ allocated_at: "desc" }, { allocation_id: "desc" }],
        include: shipmentPrintAllocationInclude,
      }))
    );
  }
  const unresolvedWriteTargets =
    rows.length === 0
      ? []
      : await client.sales_channel_write_request_targets.findMany({
          where: {
            external_shipment_id: {
              in: Array.from(
                new Set(rows.map((row) => row.external_shipment_id))
              ),
            },
            write_request: {
              request_type: "ORDER_STATUS_INSTRUCT",
              request_status: { in: [...SALES_CHANNEL_WRITE_REVIEW_STATUSES] },
            },
          },
          select: {
            external_shipment_id: true,
            sales_channel_write_request_id: true,
          },
          orderBy: { sales_channel_write_request_target_id: "desc" },
        });
  const unresolvedWriteRequestByShipmentId = new Map<string, number>();

  for (const target of unresolvedWriteTargets) {
    const shipmentId = String(target.external_shipment_id ?? "").trim();

    if (shipmentId && !unresolvedWriteRequestByShipmentId.has(shipmentId)) {
      unresolvedWriteRequestByShipmentId.set(
        shipmentId,
        target.sales_channel_write_request_id
      );
    }
  }
  const rawOrdersByShipmentPair = new Map(
    rawOrderRows.map((order) => [shipmentPairKey(order), order])
  );
  const allocationsByItemKey = new Map<string, typeof allocationRows>();
  const packageGroupSizes = new Map<string, number>();

  for (const allocation of allocationRows) {
    const packageGroupKey = packageGroupKeyForAllocation(allocation);
    packageGroupSizes.set(
      packageGroupKey,
      (packageGroupSizes.get(packageGroupKey) ?? 0) + 1
    );
    const key = [
      allocation.external_order_id,
      allocation.external_shipment_id ?? "",
      allocation.external_vendor_item_id ?? "",
    ].join(":");
    const current = allocationsByItemKey.get(key) ?? [];

    current.push(allocation);
    allocationsByItemKey.set(key, current);
  }
  const orderIds = new Set(externalOrderIds);
  const rowDtos = rows.map((row) => {
    const offer = workItemOfferValues(row);
    const rawOrder = rawOrdersByShipmentPair.get(shipmentPairKey(row)) ?? null;
    const rowAllocations =
      allocationsByItemKey.get(
        [
          row.external_order_id,
          row.external_shipment_id ?? "",
          row.external_vendor_item_id ?? "",
        ].join(":")
      ) ?? [];
    const matchedPgNos = rowAllocations.map((allocation) => allocation.pg_no);
    const matchedDevices = rowAllocations.map((allocation) => ({
      allocationId: allocation.allocation_id,
      allocationStatus: allocation.allocation_status,
      allocationFailureReason: allocation.failure_reason,
      pgNo: allocation.pg_no,
      model: allocation.device.model,
      modelSeq: allocation.device.model_seq,
      storage: allocation.device.storage,
      color: allocation.device.color,
      saleGrade: allocation.device.sale_grade,
      warranty: displayWarranty(
        allocation.required_warranty_group,
        allocation.device.warranty
      ),
      inventoryStatus: allocation.device.inventory?.inventory_status ?? null,
      matchedAt: requiredApiDateTime(allocation.allocated_at),
      allocatedAt: requiredApiDateTime(allocation.allocated_at),
      shipmentListPrintedAt: apiDateTime(allocation.shipment_list_printed_at),
      shipmentListPrintBatchId: allocation.shipment_list_print_batch_id,
      shipmentListPrintBatchNo: allocation.shipment_list_print_batch_no,
      shipmentListPrintBatchLabel: allocation.shipment_list_print_batch_label,
      packageGroupKey: packageGroupKeyForAllocation(allocation),
      packageGroupSize:
        packageGroupSizes.get(packageGroupKeyForAllocation(allocation)) ?? 1,
    }));

    return {
      id: row.work_item_id,
      channel: row.channel,
      externalOrderId: row.external_order_id,
      externalShipmentId: row.external_shipment_id,
      orderedAt: apiDateTime(rawOrder?.ordered_at),
      paidAt: apiDateTime(rawOrder?.paid_at),
      syncedAt: requiredApiDateTime(row.updated_at),
      channelStatus: rawOrder?.external_order_status ?? null,
      orderWorkStatus: row.work_status,
      shippingWorkStatus: row.work_status,
      invoiceStatus: "NOT_TRACKED",
      receiverName: rawOrder?.receiver_name ?? "",
      receiverSafeNumber: maskPhone(rawOrder?.receiver_safe_number, 4),
      receiverAddress: compactText([
        rawOrder?.receiver_post_code,
        rawOrder?.receiver_address_1,
        rawOrder?.receiver_address_2,
      ]),
      externalVendorItemId: row.external_vendor_item_id,
      vendorItemName: row.vendor_item_name,
      sellerProductName: row.seller_product_name,
      sellerProductItemName: row.seller_product_item_name,
      externalVendorSkuCode: row.external_vendor_sku_code,
      displayProductName:
        row.seller_product_item_name ||
        row.vendor_item_name ||
        row.seller_product_name ||
        row.external_vendor_item_id,
      displayRequiredOption: compactText([
        offer.model,
        offer.requiredStorage,
        offer.requiredColor,
        offer.requiredWarrantyGroup,
      ]),
      shippingCount: row.ordered_quantity,
      holdCountForCancel: row.cancel_hold_quantity,
      cancelCount: row.canceled_quantity,
      canceled: row.canceled === 1,
      availableQuantity: row.matchable_quantity,
      mappingStatus: row.mapping_status,
      salesOfferId: offer.salesOfferId,
      salesOfferCode: offer.salesOfferCode,
      requiredStorage: offer.requiredStorage,
      requiredColor: offer.requiredColor,
      requiredWarrantyGroup: offer.requiredWarrantyGroup,
      matchingFailureReason: row.mapping_failure_reason,
      inventoryMatchStatus: row.work_status,
      inventoryMatchingFailureReason: row.work_failure_reason,
      inventoryMatchedAt: row.matched_at,
      matchedQuantity: rowAllocations.length,
      matchedPgNos,
      matchedPgText: matchedPgNos.join(", "),
      matchedDevices,
      writeReviewRequired: unresolvedWriteRequestByShipmentId.has(
        row.external_shipment_id
      ),
      writeRequestId:
        unresolvedWriteRequestByShipmentId.get(row.external_shipment_id) ?? null,
    };
  });
  const printReadyMatchedRows = rowDtos.filter(
    (row) =>
      row.matchedDevices.length > 0 &&
      row.channelStatus === COUPANG_INSTRUCT_ORDER_STATUS
  );
  const visibleRows =
    mode === "matched"
      ? printReadyMatchedRows
      : rowDtos;
  const matchedRows =
    mode === "matched"
      ? printReadyMatchedRows
      : rowDtos.filter((row) => row.matchedDevices.length > 0);
  const fullyMatchedRows = rowDtos.filter(
    (row) => row.inventoryMatchStatus === "MATCHED"
  );

  return {
    mode,
    summary: {
      orderCount: page.summary?.orderCount ?? orderIds.size,
      orderItemCount: page.summary?.orderItemCount ?? page.totalCount,
      matchedOrderItemCount:
        page.summary?.matchedOrderItemCount ?? matchedRows.length,
      fullyMatchedOrderItemCount:
        page.summary?.fullyMatchedOrderItemCount ?? fullyMatchedRows.length,
      matchedDeviceCount:
        page.summary?.matchedDeviceCount ??
        rowDtos.reduce((sum, row) => sum + row.matchedDevices.length, 0),
      packageGroupCount: page.summary?.packageGroupCount ?? 0,
    },
    items: visibleRows,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    totalCount: page.totalCount,
    coverage: page.coverage,
  };
}

export async function listShipmentOrderItems(input: {
  mode?: unknown;
  limit?: unknown;
  cursor?: unknown;
} = {}) {
  return runConsistentReadSnapshot(
    prisma,
    "shipment.order-list.read",
    (tx) => listShipmentOrderItemsInSnapshot(tx, input),
    { timeout: 120_000 }
  );
}

export async function listDeliveringShipmentItems(input: {
  limit?: unknown;
} = {}) {
  const limit = positiveInt(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const rawOrders = await prisma.coupang_order_raw.findMany({
    where: {
      external_order_status: COUPANG_DELIVERING_ORDER_STATUS,
    },
    orderBy: [
      { updated_at: "desc" },
      { coupang_order_raw_id: "desc" },
    ],
    take: limit,
  });
  const shipmentPairs = uniqueShipmentPairs(rawOrders);
  const rawOrdersByShipmentPair = new Map(
    rawOrders.map((order) => [shipmentPairKey(order), order])
  );
  const workRows: WorkItemWithSalesOffer[] = [];
  const allocationRows: DeliveringAllocation[] = [];

  for (const batch of chunks(shipmentPairs, 100)) {
    workRows.push(
      ...(await prisma.order_matching_work_queue.findMany({
        where: {
          channel: "COUPANG",
          OR: batch.map((pair) => ({
            external_order_id: pair.external_order_id,
            external_shipment_id: pair.external_shipment_id,
          })),
        },
        orderBy: [
          { updated_at: "desc" },
          { work_item_id: "desc" },
        ],
        include: workItemSalesOfferInclude,
      }))
    );
    allocationRows.push(
      ...(await prisma.match_worker_allocation.findMany({
        where: {
          OR: batch.map((pair) => ({
            external_order_id: pair.external_order_id,
            external_shipment_id: pair.external_shipment_id,
          })),
          allocation_status: {
            in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
          },
        },
        orderBy: [{ allocated_at: "desc" }, { allocation_id: "desc" }],
        include: deliveringAllocationInclude,
      }))
    );
  }

  const allocationsByItemKey = new Map<string, DeliveringAllocation[]>();

  for (const allocation of allocationRows) {
    const key = shipmentItemKey(allocation);
    const current = allocationsByItemKey.get(key) ?? [];

    current.push(allocation);
    allocationsByItemKey.set(key, current);
  }

  const items = workRows.map((row) => {
    const offer = workItemOfferValues(row);
    const rawOrder = rawOrdersByShipmentPair.get(shipmentPairKey(row)) ?? null;
    const rowAllocations =
      allocationsByItemKey.get(shipmentItemKey(row)) ?? [];
    const matchedDevices = rowAllocations.map((allocation) => ({
      allocationId: allocation.allocation_id,
      allocationStatus: allocation.allocation_status,
      pgNo: allocation.pg_no,
      uniqueNo: formatModelSeqLabel(
        allocation.device.model,
        allocation.device.model_seq
      ),
      model: allocation.device.model,
      modelSeq: allocation.device.model_seq,
      storage: allocation.device.storage,
      color: allocation.device.color,
      saleGrade: allocation.device.sale_grade,
      warranty: displayWarranty(
        allocation.required_warranty_group,
        allocation.device.warranty
      ),
      inventoryStatus: allocation.device.inventory?.inventory_status ?? null,
      shipmentBatchText: shipmentBatchLineLabel(allocation),
      allocatedAt: requiredApiDateTime(allocation.allocated_at),
      shipmentListPrintedAt: apiDateTime(allocation.shipment_list_printed_at),
    }));

    return {
      id: row.work_item_id,
      channel: row.channel,
      externalOrderId: row.external_order_id,
      externalShipmentId: row.external_shipment_id,
      orderedAt: apiDateTime(rawOrder?.ordered_at),
      paidAt: apiDateTime(rawOrder?.paid_at),
      syncedAt: requiredApiDateTime(rawOrder?.synced_at ?? row.updated_at),
      channelStatus: rawOrder?.external_order_status ?? null,
      receiverName: rawOrder?.receiver_name ?? "",
      receiverSafeNumber: maskPhone(rawOrder?.receiver_safe_number, 4),
      receiverAddress: compactText([
        rawOrder?.receiver_post_code,
        rawOrder?.receiver_address_1,
        rawOrder?.receiver_address_2,
      ]),
      externalVendorItemId: row.external_vendor_item_id,
      vendorItemName: row.vendor_item_name,
      sellerProductName: row.seller_product_name,
      sellerProductItemName: row.seller_product_item_name,
      externalVendorSkuCode: row.external_vendor_sku_code,
      displayProductName:
        row.seller_product_item_name ||
        row.vendor_item_name ||
        row.seller_product_name ||
        row.external_vendor_item_id,
      displayRequiredOption: compactText([
        offer.model,
        offer.requiredStorage,
        offer.requiredColor,
        offer.requiredWarrantyGroup,
      ]),
      orderedQuantity: row.ordered_quantity,
      matchableQuantity: row.matchable_quantity,
      salesPrice: row.sales_price,
      workStatus: row.work_status,
      matchedQuantity: rowAllocations.length,
      matchedPgText: uniqueText(rowAllocations.map((allocation) => allocation.pg_no)),
      uniqueNoText: uniqueText(matchedDevices.map((device) => device.uniqueNo)),
      inventoryStatusText: uniqueText(
        matchedDevices.map((device) => device.inventoryStatus)
      ),
      shipmentBatchText: uniqueText(
        matchedDevices.map((device) => device.shipmentBatchText)
      ),
      matchedDevices,
    };
  });

  return {
    summary: {
      orderCount: rawOrders.length,
      orderItemCount: items.length,
      matchedDeviceCount: allocationRows.length,
    },
    items,
  };
}

export async function recordShipmentListPrint(input: {
  allocationIds?: unknown;
  tabKey?: unknown;
  userId?: number | null;
} = {}) {
  const tab = normalizeShipmentPrintTab(input.tabKey);

  if (!tab) {
    throw new Error("출고 목록 출력 탭이 올바르지 않습니다.");
  }

  const allocationIds = uniquePositiveIds(input.allocationIds);

  if (allocationIds.length === 0) {
    throw new Error("출력할 출고 목록 항목이 없습니다.");
  }

  const printedDate = quickHackClock.nowDate();
  const printDate = databaseDate(printedDate);
  const printedAt = printedDate;

  const result = await runMeasuredTransaction(prisma, "shipment.print.create", async (tx) => {
    const selectedAllocations = await findShipmentPrintAllocations(
      tx,
      allocationIds
    );

    if (selectedAllocations.length !== allocationIds.length) {
      throw new Error(
        "출고 목록 출력에는 쿠팡 상품준비중 처리 확인이 끝났고 재고상태가 주문확인인 PG만 포함할 수 있습니다."
      );
    }

    const tabAllocations = selectedAllocations.filter((allocation) =>
        hasWarrantyKeyword(
          displayWarranty(
            allocation.required_warranty_group,
            allocation.device.warranty
          ),
          tab.warrantyKeyword
        )
      );

    if (tabAllocations.length === 0) {
      throw new Error("출력 가능한 매칭 완료 항목이 없습니다.");
    }

    const selectedPackageGroupCount = new Set(
      selectedAllocations.map(packageGroupKeyForAllocation)
    ).size;

    if (selectedPackageGroupCount > 30) {
      throw new Error("출고 목록은 한 번에 합포장 그룹 30개까지만 출력할 수 있습니다.");
    }

    const allEligibleAllocations = await findShipmentPrintAllocations(tx);
    const printableAllocations = sortShipmentPrintAllocationsByOrderedAt(
      expandPackageGroupSelection(selectedAllocations, allEligibleAllocations)
    );

    const printableAllocationIds = printableAllocations.map(
      (allocation) => allocation.allocation_id
    );

    await assertNoShipmentReturnConflicts(tx, printableAllocationIds);

    const activeBatchItems =
      await tx.sales_channel_shipment_list_print_batch_items.findMany({
        where: {
          allocation_id: {
            in: printableAllocationIds,
          },
          batch: {
            print_date: printDate,
            batch_status: {
              in: [...ACTIVE_SHIPMENT_PRINT_BATCH_STATUSES],
            },
          },
        },
        select: {
          allocation_id: true,
          batch: {
            select: {
              batch_label: true,
              batch_status: true,
            },
          },
        },
      });

    if (activeBatchItems.length > 0) {
      const labels = Array.from(
        new Set(activeBatchItems.map((item) => item.batch.batch_label))
      ).join(", ");
      throw new Error(
        `이미 출력 대기 또는 확정 차수에 포함된 항목입니다.${labels ? ` (${labels})` : ""}`
      );
    }

    const packageGroups = await createDraftShipmentPackageGroups(tx, {
      channel: "COUPANG",
      allocations: printableAllocations,
      createdAt: printedAt,
    });

    const latestPrintItem =
      await tx.sales_channel_shipment_list_print_batch_items.findFirst({
        where: {
          channel: "COUPANG",
          tab_key: tab.key,
          print_date: printDate,
        },
        orderBy: {
          print_line_no: "desc",
        },
        select: {
          print_line_no: true,
        },
      });
    const firstPrintLineNo = (latestPrintItem?.print_line_no ?? 0) + 1;
    const printItems = printableAllocations.map((allocation, index) => {
      const packageGroup = packageGroups.assignments.get(
        allocation.allocation_id
      );

      if (!packageGroup) {
        throw new Error("합포장 그룹 배정 결과가 누락되었습니다.");
      }

      return {
        allocation,
        packageGroup,
        printLineNo: firstPrintLineNo + index,
      };
    });
    const latestBatch = await tx.sales_channel_shipment_list_print_batches.findFirst({
      where: {
        channel: "COUPANG",
        tab_key: tab.key,
        print_date: printDate,
      },
      orderBy: {
        batch_no: "desc",
      },
      select: {
        batch_no: true,
      },
    });
    const batchNo = (latestBatch?.batch_no ?? 0) + 1;
    const batchLabel = `${tab.label} ${batchNo}차`;
    const createdBatch = await tx.sales_channel_shipment_list_print_batches.create({
      data: {
        channel: "COUPANG",
        tab_key: tab.key,
        tab_label: tab.label,
        warranty_label: tab.label,
        print_date: printDate,
        batch_no: batchNo,
        batch_label: batchLabel,
        item_count: printableAllocations.length,
        package_group_count: packageGroups.groups.length,
        batch_status: SHIPMENT_PRINT_BATCH_STATUS.pending,
        printed_by_user_id: input.userId ?? null,
        printed_at: printedAt,
        created_at: printedAt,
        updated_at: printedAt,
      },
    });

    await tx.sales_channel_shipment_list_print_batch_items.createMany({
      data: printItems.map(({ allocation, packageGroup, printLineNo }) => ({
        shipment_list_print_batch_id:
          createdBatch.shipment_list_print_batch_id,
        channel: "COUPANG",
        tab_key: tab.key,
        print_date: printDate,
        print_line_no: printLineNo,
        allocation_id: allocation.allocation_id,
        pg_no: allocation.pg_no,
        package_group_id: packageGroup.packageGroupId,
        created_at: printedAt,
      })),
    });

    return {
      batch: createdBatch,
      printedCount: printableAllocations.length,
      packageGroupCount: packageGroups.groups.length,
      items: printItems.map(({ allocation, packageGroup, printLineNo }) =>
        toShipmentPrintRow(allocation, {
          batchId: createdBatch.shipment_list_print_batch_id,
          batchNo: createdBatch.batch_no,
          batchLabel: createdBatch.batch_label,
          printLineNo,
          printedAt,
          packageGroupId: packageGroup.packageGroupId,
          packageGroupKey: packageGroup.packageGroupKey,
          packageGroupSize: packageGroup.packageGroupSize,
          packageGroupMemberSequence: packageGroup.memberSequence,
        })
      ),
    };
  });

  return {
    batchId: result.batch.shipment_list_print_batch_id,
    batchNo: result.batch.batch_no,
    batchLabel: result.batch.batch_label,
    batchStatus: result.batch.batch_status,
    printedAt: requiredApiDateTime(printedAt),
    requestedCount: allocationIds.length,
    printedCount: result.printedCount,
    packageGroupCount: result.packageGroupCount,
    items: result.items,
  };
}

export async function markShipmentListPrintDialogClosed(input: {
  batchId?: unknown;
}) {
  const batchId = requiredPositiveId(input.batchId, "출력 차수");
  const closedAt = databaseNow();

  const batch = await runMeasuredTransaction(
    prisma,
    "shipment.print.dialog-closed",
    async (tx) => {
      await transitionShipmentPrintBatchStatus(tx, {
        batchId,
        targetStatus: SHIPMENT_PRINT_BATCH_STATUS.printDialogClosed,
        transitionedAt: closedAt,
      });

      return tx.sales_channel_shipment_list_print_batches.findUniqueOrThrow({
        where: { shipment_list_print_batch_id: batchId },
        include: shipmentPrintBatchInclude,
      });
    }
  );

  return toShipmentPrintBatchDto(batch);
}

export async function confirmShipmentListPrintBatch(input: {
  batchId?: unknown;
  userId?: number | null;
}) {
  const batchId = requiredPositiveId(input.batchId, "출력 차수");
  const confirmedAt = databaseNow();

  const batch = await runMeasuredTransaction(prisma, "shipment.print.confirm", async (tx) => {
    const currentBatch =
      await tx.sales_channel_shipment_list_print_batches.findUnique({
        where: {
          shipment_list_print_batch_id: batchId,
        },
        include: shipmentPrintBatchInclude,
      });

    if (!currentBatch) {
      throw new Error("출력 차수를 찾지 못했습니다.");
    }

    if (currentBatch.batch_status === SHIPMENT_PRINT_BATCH_STATUS.canceled) {
      throw shipmentPrintBatchTerminalConflict(
        batchId,
        SHIPMENT_PRINT_BATCH_STATUS.canceled,
        SHIPMENT_PRINT_BATCH_STATUS.confirmed
      );
    }

    if (currentBatch.batch_status === SHIPMENT_PRINT_BATCH_STATUS.confirmed) {
      return currentBatch;
    }

    const batchAllocationIds = currentBatch.items.map(
      (item) => item.allocation_id
    );
    const packageGroupIds = shipmentPrintBatchPackageGroupIds(currentBatch);

    await assertNoShipmentReturnConflicts(tx, batchAllocationIds);

    const returnExcludedItems = currentBatch.items.filter(
      (item) =>
        item.allocation.allocation_status === "CANCELED" &&
        item.allocation.coupang_return_allocations.length > 0
    );
    const unexpectedItems = currentBatch.items.filter(
      (item) =>
        item.allocation.allocation_status !== ALLOCATION_STATUS.apiAcked &&
        !returnExcludedItems.includes(item)
    );

    if (unexpectedItems.length > 0) {
      throw new Error(
        `출력 차수에 반품 처리와 무관한 비정상 상태의 PG가 포함되어 있습니다: ${unexpectedItems
          .map((item) => `${item.pg_no}(${item.allocation.allocation_status})`)
          .join(", ")}`
      );
    }

    const confirmableItems = currentBatch.items.filter((item) =>
      item.allocation.allocation_status === ALLOCATION_STATUS.apiAcked
    );
    const exactQuantityAllocations = await filterExactQuantityShipmentAllocations(
      tx,
      confirmableItems.map((item) => item.allocation),
      true,
      returnExcludedItems.map((item) => item.allocation)
    );
    if (exactQuantityAllocations.length !== confirmableItems.length) {
      throw publicConflict(
        "SHIPMENT_PRINT_QUANTITY_CHANGED",
        "주문 가능 수량과 활성 PG 배정 수량이 달라 출고 목록 확정을 중단했습니다. 목록을 새로고침한 뒤 주문 동기화 상태를 확인하세요.",
        { batchId, refreshRequired: true }
      );
    }
    const allocationIds = confirmableItems.map((item) => item.allocation_id);
    const pgNos = Array.from(
      new Set(confirmableItems.map((item) => item.pg_no).filter(Boolean))
    );
    const alreadyConfirmedAllocation = currentBatch.items.find(
      (item) =>
        item.allocation.shipment_list_print_batch_id &&
        item.allocation.shipment_list_print_batch_id !== batchId
    );

    if (alreadyConfirmedAllocation) {
      throw new Error(
        `${alreadyConfirmedAllocation.pg_no}는 이미 다른 출력 차수에 확정되어 있습니다.`
      );
    }

    const transition = await transitionShipmentPrintBatchStatus(tx, {
      batchId,
      targetStatus: SHIPMENT_PRINT_BATCH_STATUS.confirmed,
      transitionedAt: confirmedAt,
    });
    if (!transition.applied) {
      return tx.sales_channel_shipment_list_print_batches.findUniqueOrThrow({
        where: { shipment_list_print_batch_id: batchId },
        include: shipmentPrintBatchInclude,
      });
    }

    await freezeShipmentPackageGroups(tx, packageGroupIds, confirmedAt);

    if (allocationIds.length > 0) {
      const updatedAllocations = await tx.match_worker_allocation.updateMany({
        where: {
          allocation_id: {
            in: allocationIds,
          },
          allocation_status: {
            equals: ALLOCATION_STATUS.apiAcked,
          },
          shipment_list_print_batch_id: null,
        },
        data: {
          allocation_status: ALLOCATION_STATUS.shipmentListPrinted,
          shipment_list_printed_at: confirmedAt,
          shipment_list_print_batch_id:
            currentBatch.shipment_list_print_batch_id,
          shipment_list_print_batch_no: currentBatch.batch_no,
          shipment_list_print_batch_label: currentBatch.batch_label,
          updated_at: confirmedAt,
        },
      });

      if (updatedAllocations.count !== allocationIds.length) {
        throw new Error(
          "출력 확정 중 일부 PG의 매칭 상태가 변경되었습니다. 목록을 새로고침한 뒤 다시 시도해 주세요."
        );
      }

      for (const item of confirmableItems) {
        await transitionInventoryStatusWithLedger(tx, {
          pgNo: item.pg_no,
          toStatus: INVENTORY_STATUS.packing,
          expectedFromStatus: INVENTORY_STATUS.reserved,
          transitionPolicy: INVENTORY_TRANSITION_POLICY.shipmentPrintConfirmation,
          operationKey: `shipment-print-batch:${batchId}:allocation:${item.allocation_id}`,
          movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
          sourceType: "SHIPMENT_LIST_PRINT_BATCH",
          sourceId: String(batchId),
          reason: "포장 출력 차수 확정",
          actorUserId: input.userId ?? null,
          occurredAt: confirmedAt,
        });
      }
    }

    await tx.employee_activity_logs.create({
      data: {
        user_id: input.userId ?? null,
        action_type: "SHIPMENT_LIST_PRINT_BATCH_CONFIRMED",
        target_type: "SALES_CHANNEL_SHIPMENT_LIST_PRINT_BATCH",
        target_id: String(currentBatch.shipment_list_print_batch_id),
        ...activityLogChangeData(
          {
            batchStatus: currentBatch.batch_status,
            confirmedAt: currentBatch.confirmed_at,
            allocationIds,
            pgNos,
          },
          {
            batchStatus: SHIPMENT_PRINT_BATCH_STATUS.confirmed,
            confirmedAt,
            batchLabel: currentBatch.batch_label,
            allocationIds,
            pgNos,
            returnExcludedAllocationIds: returnExcludedItems.map(
              (item) => item.allocation_id
            ),
            inventoryStatusAfter: INVENTORY_STATUS.packing,
          }
        ),
        result: "SUCCESS",
        created_at: confirmedAt,
      },
    });

    return tx.sales_channel_shipment_list_print_batches.findUniqueOrThrow({
      where: {
        shipment_list_print_batch_id: batchId,
      },
      include: shipmentPrintBatchInclude,
    });
  });

  return toShipmentPrintBatchDto(batch);
}

export async function cancelShipmentListPrintBatch(input: {
  batchId?: unknown;
  userId?: number | null;
}) {
  const batchId = requiredPositiveId(input.batchId, "출력 차수");
  const canceledAt = databaseNow();

  const batch = await runMeasuredTransaction(prisma, "shipment.print.cancel", async (tx) => {
    const currentBatch =
      await tx.sales_channel_shipment_list_print_batches.findUnique({
        where: {
          shipment_list_print_batch_id: batchId,
        },
        include: shipmentPrintBatchInclude,
      });

    if (!currentBatch) {
      throw new Error("출력 차수를 찾지 못했습니다.");
    }

    if (currentBatch.batch_status === SHIPMENT_PRINT_BATCH_STATUS.confirmed) {
      throw shipmentPrintBatchTerminalConflict(
        batchId,
        SHIPMENT_PRINT_BATCH_STATUS.confirmed,
        SHIPMENT_PRINT_BATCH_STATUS.canceled
      );
    }

    if (currentBatch.batch_status === SHIPMENT_PRINT_BATCH_STATUS.canceled) {
      return currentBatch;
    }

    const packageGroupIds = shipmentPrintBatchPackageGroupIds(currentBatch);

    const transition = await transitionShipmentPrintBatchStatus(tx, {
      batchId,
      targetStatus: SHIPMENT_PRINT_BATCH_STATUS.canceled,
      transitionedAt: canceledAt,
    });
    if (!transition.applied) {
      return tx.sales_channel_shipment_list_print_batches.findUniqueOrThrow({
        where: { shipment_list_print_batch_id: batchId },
        include: shipmentPrintBatchInclude,
      });
    }

    await cancelShipmentPackageGroups(tx, packageGroupIds, canceledAt);

    await tx.employee_activity_logs.create({
      data: {
        user_id: input.userId ?? null,
        action_type: "SHIPMENT_LIST_PRINT_BATCH_CANCELED",
        target_type: "SALES_CHANNEL_SHIPMENT_LIST_PRINT_BATCH",
        target_id: String(currentBatch.shipment_list_print_batch_id),
        ...activityLogChangeData(
          {
            batchStatus: currentBatch.batch_status,
            canceledAt: currentBatch.canceled_at,
            packageGroupIds,
          },
          {
            batchStatus: SHIPMENT_PRINT_BATCH_STATUS.canceled,
            canceledAt,
            packageGroupIds,
          }
        ),
        result: "SUCCESS",
        created_at: canceledAt,
      },
    });

    return tx.sales_channel_shipment_list_print_batches.findUniqueOrThrow({
      where: { shipment_list_print_batch_id: batchId },
      include: shipmentPrintBatchInclude,
    });
  });

  return toShipmentPrintBatchDto(batch);
}

export async function listTodayShipmentPrintItems() {
  const range = todayPrintRange();
  const batches = await prisma.sales_channel_shipment_list_print_batches.findMany({
    where: {
      channel: "COUPANG",
      batch_status: SHIPMENT_PRINT_BATCH_STATUS.confirmed,
      confirmed_at: {
        gte: databaseDateTime(range.from),
        lte: databaseDateTime(range.to),
      },
    },
    orderBy: [
      { confirmed_at: "desc" },
      { shipment_list_print_batch_id: "desc" },
    ],
    include: shipmentPrintBatchInclude,
  });
  const batchDtos = batches.map(toShipmentPrintBatchDto);

  return {
    range,
    batches: batchDtos,
    items: batchDtos.flatMap((batch) => batch.items),
    count: batchDtos.reduce((sum, batch) => sum + batch.items.length, 0),
  };
}

export async function listShipmentPrintBatches(input: {
  tabKey?: unknown;
  limit?: unknown;
  focusBatchId?: unknown;
} = {}) {
  const tab = normalizeShipmentPrintTab(input.tabKey);

  if (!tab) {
    return {
      tabKey: "",
      batches: [],
      count: 0,
    };
  }

  const limit = positiveInt(input.limit, 50, 200);
  const parsedFocusBatchId = Number.parseInt(
    String(input.focusBatchId ?? ""),
    10
  );
  const focusBatchId =
    Number.isSafeInteger(parsedFocusBatchId) && parsedFocusBatchId > 0
      ? parsedFocusBatchId
      : null;
  const range = todayPrintRange();
  const [batches, focusedBatch] = await Promise.all([
    prisma.sales_channel_shipment_list_print_batches.findMany({
      where: {
        channel: "COUPANG",
        tab_key: tab.key,
        print_date: {
          gte: databaseDate(range.date),
          lte: databaseDate(range.date),
        },
        batch_status: {
          not: SHIPMENT_PRINT_BATCH_STATUS.canceled,
        },
      },
      orderBy: [
        { batch_no: "desc" },
        { shipment_list_print_batch_id: "desc" },
      ],
      take: limit,
      include: shipmentPrintBatchInclude,
    }),
    focusBatchId
      ? prisma.sales_channel_shipment_list_print_batches.findUnique({
          where: { shipment_list_print_batch_id: focusBatchId },
          include: shipmentPrintBatchInclude,
        })
      : Promise.resolve(null),
  ]);
  const visibleFocusedBatch =
    focusedBatch &&
    focusedBatch.channel === "COUPANG" &&
    focusedBatch.tab_key === tab.key &&
    focusedBatch.batch_status !== SHIPMENT_PRINT_BATCH_STATUS.canceled
      ? focusedBatch
      : null;
  const mergedBatches =
    visibleFocusedBatch &&
    !batches.some(
      (batch) =>
        batch.shipment_list_print_batch_id ===
        visibleFocusedBatch.shipment_list_print_batch_id
    )
      ? [visibleFocusedBatch, ...batches]
      : batches;
  const batchDtos = mergedBatches.map(toShipmentPrintBatchDto);

  return {
    tabKey: tab.key,
    batches: batchDtos,
    count: batchDtos.length,
    focusBatchFound:
      !focusBatchId ||
      batchDtos.some((batch) => batch.batchId === focusBatchId),
  };
}
