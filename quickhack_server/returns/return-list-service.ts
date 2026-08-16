import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  normalizeKeysetLimit,
} from "@/quickhack_server/core/database/keyset-page";
import { maskPhone } from "@/quickhack_server/security/sensitive-data";
import {
  COUPANG_ACTIVE_RETURN_RECEIPT_STATUSES,
  COUPANG_AFTER_SHIPMENT_RETURN_ORDER_STATUSES,
  COUPANG_PRE_SHIPMENT_RETURN_ORDER_STATUSES,
  COUPANG_RELEASE_STOP_PENDING_STATUSES,
  COUPANG_RELEASE_STOP_RECEIPT_STATUSES,
} from "@/quickhack_server/sales-channel/coupang/config";
import {
  coupangReturnReasonLabel,
  normalizeCoupangReasonLabel,
} from "@/quickhack_shared/sales-channel/coupang-return-reasons";
import {
  NON_REUSABLE_AFTER_PACKING_SUPPLY_CODE,
  SUPPLY_MOVEMENT_TYPE,
} from "@/quickhack_shared/supplies/supplies";
import { SALES_CHANNEL_WRITE_REVIEW_STATUSES } from "@/quickhack_shared/sales-channel/write-requests";
import { buildReturnItemRequirements } from "@/quickhack_server/returns/return-item-requirement";

const COUPANG_CHANNEL = "COUPANG";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const RETURN_LIST_CURSOR_CONTRACT = "coupang-return-work-v1";

export type ReturnListPhase = "before" | "after";

type ReturnShipmentSignal =
  | "BEFORE_SHIPMENT"
  | "AFTER_SHIPMENT"
  | "COUPANG_ORDER_STATUS_REQUIRED";

type ReturnNextAction = "stopShipment" | "receiveConfirm" | "approve";

const RETURN_RECEIVE_CONFIRM_STATUSES = [
  "RU",
  "UC",
  "RELEASE_STOP_UNCHECKED",
  "RETURNS_UNCHECKED",
] as const;

const RETURN_APPROVAL_STATUSES = ["VENDOR_WAREHOUSE_CONFIRM"] as const;

const RETURN_ACTION_LABELS = {
  stopShipment: "출고중지완료",
  receiveConfirm: "입고 확인",
  approve: "반품 완료",
} satisfies Record<ReturnNextAction, string>;

function normalizePhase(value: unknown): ReturnListPhase {
  return String(value ?? "").trim() === "after" ? "after" : "before";
}

function uniqueTexts(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
}

function compactText(values: Array<string | number | null | undefined>) {
  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function shipmentBatchLabel(value: {
  shipment_list_print_batch_label: string | null;
  shipment_list_print_batch_no: number | null;
  shipment_list_print_batch_id?: number | null;
  shipment_list_print_batch_items?: Array<{
    shipment_list_print_batch_id: number;
    print_line_no: number;
    batch?: {
      batch_label: string;
      batch_no: number;
    } | null;
  }>;
}) {
  const printItem =
    value.shipment_list_print_batch_items?.find(
      (item) =>
        item.shipment_list_print_batch_id ===
        value.shipment_list_print_batch_id
    ) ?? null;
  const label = String(
    value.shipment_list_print_batch_label ??
      printItem?.batch?.batch_label ??
      ""
  ).trim();

  if (label) {
    return printItem ? `${label}-${printItem.print_line_no}` : label;
  }

  return value.shipment_list_print_batch_no
    ? `${value.shipment_list_print_batch_no}차${
        printItem ? `-${printItem.print_line_no}` : ""
      }`
    : "";
}

function code(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function hasCode(value: unknown, codes: readonly string[]) {
  return codes.includes(code(value));
}

function returnReasonParts(returnRow: CoupangReturnRow) {
  const firstItem = returnRow.items[0] ?? null;
  const rawReasonCode =
    String(returnRow.reason_code ?? "").trim() ||
    String(firstItem?.reason_code ?? "").trim();
  const reason1 =
    normalizeCoupangReasonLabel(
      String(returnRow.reason_label ?? "").trim() ||
        String(firstItem?.reason_label ?? "").trim()
    ) ||
    coupangReturnReasonLabel(rawReasonCode) ||
    rawReasonCode;
  const reason2 = normalizeCoupangReasonLabel(returnRow.reason_category);
  const reason3 = normalizeCoupangReasonLabel(returnRow.reason_detail);

  return { reason1, reason2, reason3 };
}

function returnCancelCount(returnRow: CoupangReturnRow) {
  const directCount = Number(returnRow.cancel_count ?? 0);

  if (directCount > 0) {
    return directCount;
  }

  const itemCount = returnRow.items.reduce(
    (sum, item) => sum + Math.max(0, item.cancel_count),
    0
  );

  return itemCount > 0 ? itemCount : 1;
}

function isActiveReturnReceiptStatus(value: unknown) {
  return hasCode(value, COUPANG_ACTIVE_RETURN_RECEIPT_STATUSES);
}

function isReleaseStopReceiptStatus(value: unknown) {
  return hasCode(value, COUPANG_RELEASE_STOP_RECEIPT_STATUSES);
}

function isReleaseStopPending(value: unknown) {
  return hasCode(value, COUPANG_RELEASE_STOP_PENDING_STATUSES);
}

function nextReturnActionForReceiptStatus(
  value: unknown
): ReturnNextAction | null {
  if (hasCode(value, RETURN_RECEIVE_CONFIRM_STATUSES)) {
    return "receiveConfirm";
  }

  if (hasCode(value, RETURN_APPROVAL_STATUSES)) {
    return "approve";
  }

  return null;
}

function nextReturnActionForRow(
  signal: ReturnShipmentSignal,
  returnRow: CoupangReturnRow
): ReturnNextAction | null {
  if (signal === "BEFORE_SHIPMENT") {
    return isReleaseStopReceiptStatus(returnRow.return_receipt_status) &&
      isReleaseStopPending(returnRow.return_release_status)
      ? "stopShipment"
      : null;
  }

  if (signal === "AFTER_SHIPMENT") {
    return nextReturnActionForReceiptStatus(returnRow.return_receipt_status);
  }

  return null;
}

function returnShipmentSignal(channelStatus: string | null): ReturnShipmentSignal {
  if (hasCode(channelStatus, COUPANG_PRE_SHIPMENT_RETURN_ORDER_STATUSES)) {
    return "BEFORE_SHIPMENT";
  }

  if (hasCode(channelStatus, COUPANG_AFTER_SHIPMENT_RETURN_ORDER_STATUSES)) {
    return "AFTER_SHIPMENT";
  }

  return "COUPANG_ORDER_STATUS_REQUIRED";
}

function shouldShowInPhase(signal: ReturnShipmentSignal, phase: ReturnListPhase) {
  if (phase === "after") {
    return signal === "AFTER_SHIPMENT";
  }

  return signal === "BEFORE_SHIPMENT";
}

function shouldShowReturnWorkRow(row: ReturnWorkRow, phase: ReturnListPhase) {
  if (!isActiveReturnReceiptStatus(row.receiptStatus)) {
    return false;
  }

  if (!shouldShowInPhase(row.returnPhaseSignal, phase)) {
    return false;
  }

  if (phase === "before") {
    return row.nextReturnAction === "stopShipment";
  }

  return true;
}

const returnAllocationInclude = {
  sales_offer: {
    select: { offer_code: true },
  },
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
  supply_consumption_events: {
    include: {
      supplies: {
        select: {
          supply_code: true,
          supply_name: true,
        },
      },
      reversal_movements: {
        where: {
          movement_type: SUPPLY_MOVEMENT_TYPE.returned,
        },
        select: {
          movement_id: true,
        },
      },
    },
    orderBy: {
      supply_consumption_event_id: "asc",
    },
  },
} satisfies Prisma.match_worker_allocationInclude;

const returnRowInclude = {
  items: true,
} satisfies Prisma.coupang_return_rawInclude;

type CoupangReturnRow = Prisma.coupang_return_rawGetPayload<{
  include: typeof returnRowInclude;
}>;
type ReturnOrder = Prisma.coupang_order_rawGetPayload<Record<string, never>>;
type ReturnAllocation = Prisma.match_worker_allocationGetPayload<{
  include: typeof returnAllocationInclude;
}>;
type ReturnWorkRow = ReturnType<typeof buildReturnWorkRow>;

type ReturnLinkedAllocation = Pick<
  Prisma.coupang_return_allocationGetPayload<Record<string, never>>,
  "coupang_return_raw_id" | "allocation_id"
>;

function orderShipmentKey(
  externalOrderId: string,
  externalShipmentId: string | null | undefined
) {
  return externalShipmentId
    ? `${externalOrderId}\u0000${externalShipmentId}`
    : null;
}

function orderMap(orders: ReturnOrder[]) {
  return new Map(
    orders.map((order) => [
      orderShipmentKey(order.external_order_id, order.external_shipment_id),
      order,
    ])
  );
}

function buildReturnWorkRow(
  returnRow: CoupangReturnRow,
  order: ReturnOrder | null,
  allocations: ReturnAllocation[],
  linkedAllocations: ReturnLinkedAllocation[] = []
) {
  const matchedPgNos = uniqueTexts(allocations.map((allocation) => allocation.pg_no));
  const linkedAllocationIds = new Set(
    linkedAllocations.map((allocation) => allocation.allocation_id)
  );
  const signal = returnShipmentSignal(order?.external_order_status ?? null);
  const printedAllocations = allocations.filter(
    (allocation) =>
      allocation.shipment_list_printed_at ||
      allocation.shipment_list_print_batch_id
  );
  const reasonParts = returnReasonParts(returnRow);
  const requirementResult = buildReturnItemRequirements({
    rootCancelCount: returnRow.cancel_count,
    items: returnRow.items.map((item) => ({
      externalShipmentId: item.external_shipment_id,
      externalVendorItemId: item.external_vendor_item_id,
      cancelCount: item.cancel_count,
      vendorItemName: item.vendor_item_name,
    })),
    allocations: allocations.map((allocation) => ({
      allocationId: allocation.allocation_id,
      externalShipmentId: allocation.external_shipment_id,
      externalVendorItemId: allocation.external_vendor_item_id,
      pgNo: allocation.pg_no,
    })),
  });
  const integrityStatus =
    returnRow.item_integrity_status === "VALID"
      ? requirementResult.integrityStatus
      : returnRow.item_integrity_status;
  const nextReturnAction =
    integrityStatus === "VALID"
      ? nextReturnActionForRow(signal, returnRow)
      : null;
  const allocationProductNames = uniqueTexts(
    allocations.map(
      (allocation) =>
        allocation.seller_product_item_name ||
        allocation.vendor_item_name ||
        allocation.seller_product_name ||
        allocation.external_vendor_item_id
    )
  );
  const returnItemProductNames = uniqueTexts(
    returnRow.items.map(
      (item) =>
        item.vendor_item_name ||
        item.external_vendor_item_id ||
        item.seller_product_item_id
    )
  );
  const productNames =
    allocationProductNames.length > 0
      ? allocationProductNames
      : returnItemProductNames;

  return {
    id: returnRow.coupang_return_raw_id,
    projectionRevision: returnRow.projection_revision,
    integrityStatus,
    channel: COUPANG_CHANNEL,
    externalReceiptId: returnRow.external_receipt_id,
    externalOrderId: returnRow.external_order_id,
    externalShipmentId: returnRow.external_shipment_id,
    receiptStatus: returnRow.return_receipt_status,
    reasonCode: returnRow.reason_code,
    returnPhaseSignal: signal,
    returnSignal: signal,
    orderedAt: order?.ordered_at ?? null,
    paidAt: order?.paid_at ?? null,
    syncedAt: returnRow.synced_at,
    createdAt: returnRow.created_at,
    updatedAt: returnRow.updated_at,
    channelStatus: order?.external_order_status ?? null,
    receiverName: order?.receiver_name ?? "",
    receiverSafeNumber: maskPhone(order?.receiver_safe_number, 4),
    receiverAddress: compactText([
      order?.receiver_post_code,
      order?.receiver_address_1,
      order?.receiver_address_2,
    ]),
    externalVendorItemId: uniqueTexts(
      allocations
        .map((allocation) => allocation.external_vendor_item_id)
        .concat(
          returnRow.items.map(
            (item) => item.external_vendor_item_id ?? item.seller_product_item_id
          )
        )
    ).join(", "),
    productName: productNames.join(", "),
    productText: productNames.join(", "),
    shippingCount: allocations.length,
    holdCountForCancel: 0,
    cancelCount: returnCancelCount(returnRow),
    canceled: false,
    availableQuantity: allocations.reduce(
      (sum, allocation) => sum + (allocation.available_quantity_at_allocation ?? 0),
      0
    ),
    mappingStatus: "",
    salesOfferCode: uniqueTexts(
      allocations.map((allocation) => allocation.sales_offer?.offer_code)
    ).join(", "),
    inventoryMatchStatus: uniqueTexts(
      allocations.map((allocation) => allocation.allocation_status)
    ).join(", "),
    inventoryMatchingFailureReason: uniqueTexts(
      allocations.map((allocation) => allocation.failure_reason)
    ).join(", "),
    matchedQuantity: matchedPgNos.length,
    matchedPgText: matchedPgNos.join(", "),
    selectedAllocationIds: Array.from(linkedAllocationIds),
    itemRequirements: requirementResult.requirements.map((requirement) => ({
      key: requirement.key,
      externalShipmentId: requirement.externalShipmentId,
      externalVendorItemId: requirement.externalVendorItemId,
      vendorItemName: requirement.vendorItemName,
      requiredQuantity: requirement.requiredQuantity,
      selectableQuantity: requirement.selectableQuantity,
      missingQuantity: requirement.missingQuantity,
      candidateAllocationIds: requirement.candidateAllocationIds,
      selectedQuantity: requirement.candidateAllocationIds.filter((id) =>
        linkedAllocationIds.has(id)
      ).length,
    })),
    allocationCandidates: allocations.map((allocation) => ({
      allocationId: allocation.allocation_id,
      pgNo: allocation.pg_no,
      externalShipmentId: allocation.external_shipment_id,
      externalVendorItemId: allocation.external_vendor_item_id,
      productName:
        allocation.seller_product_item_name ||
        allocation.vendor_item_name ||
        allocation.seller_product_name ||
        allocation.external_vendor_item_id ||
        "",
      model: allocation.device.model,
      modelSeq: allocation.device.model_seq,
      storage: allocation.device.storage,
      color: allocation.device.color,
      saleGrade: allocation.device.sale_grade,
      warranty:
        allocation.required_warranty_group ?? allocation.device.warranty,
      imei: allocation.device.imei,
      inventoryStatus: allocation.device.inventory?.inventory_status ?? null,
      allocationStatus: allocation.allocation_status,
      matchedAt: allocation.allocated_at,
      shipmentBatchText: shipmentBatchLabel({
        shipment_list_print_batch_label:
          allocation.shipment_list_print_batch_label,
        shipment_list_print_batch_no:
          allocation.shipment_list_print_batch_no,
        shipment_list_print_batch_id:
          allocation.shipment_list_print_batch_id,
        shipment_list_print_batch_items:
          allocation.shipment_list_print_batch_items,
      }),
      reusableSupplies: allocation.supply_consumption_events.map((event) => ({
        consumptionEventId: event.supply_consumption_event_id,
        supplyCode: event.supplies.supply_code,
        supplyName: event.supplies.supply_name,
        quantity: event.quantity,
        reusable:
          event.supplies.supply_code !==
          NON_REUSABLE_AFTER_PACKING_SUPPLY_CODE,
        recovered: event.reversal_movements.length > 0,
      })),
      selectedForReturn: linkedAllocationIds.has(allocation.allocation_id),
    })),
    inventoryStatusText: uniqueTexts(
      allocations.map(
        (allocation) => allocation.device.inventory?.inventory_status ?? null
      )
    ).join("\n"),
    shipmentBatchText: uniqueTexts(
      allocations.map((allocation) =>
        shipmentBatchLabel({
          shipment_list_print_batch_label:
            allocation.shipment_list_print_batch_label,
          shipment_list_print_batch_no:
            allocation.shipment_list_print_batch_no,
          shipment_list_print_batch_id:
            allocation.shipment_list_print_batch_id,
          shipment_list_print_batch_items:
            allocation.shipment_list_print_batch_items,
        })
      )
    ).join("\n"),
    shipmentListPrintedQuantity: printedAllocations.length,
    reason1: reasonParts.reason1,
    reason2: reasonParts.reason2,
    reason3: reasonParts.reason3,
    nextReturnAction,
    nextReturnActionLabel: nextReturnAction
      ? RETURN_ACTION_LABELS[nextReturnAction]
      : null,
  };
}

function returnCandidateAllocations(
  returnRow: CoupangReturnRow,
  allocations: ReturnAllocation[]
) {
  const requirementResult = buildReturnItemRequirements({
    rootCancelCount: returnRow.cancel_count,
    items: returnRow.items.map((item) => ({
      externalShipmentId: item.external_shipment_id,
      externalVendorItemId: item.external_vendor_item_id,
      cancelCount: item.cancel_count,
      vendorItemName: item.vendor_item_name,
    })),
    allocations: allocations.map((allocation) => ({
      allocationId: allocation.allocation_id,
      externalShipmentId: allocation.external_shipment_id,
      externalVendorItemId: allocation.external_vendor_item_id,
      pgNo: allocation.pg_no,
    })),
  });
  const candidateIds = new Set(
    requirementResult.requirements.flatMap(
      (requirement) => requirement.candidateAllocationIds
    )
  );
  return allocations.filter((allocation) =>
    candidateIds.has(allocation.allocation_id)
  );
}

function summarizeReturnRows(rows: ReturnWorkRow[]) {
  const linkedOrderIds = new Set<string>();
  const linkedShipmentIds = new Set<string>();
  let beforeShipmentCount = 0;
  let afterShipmentCount = 0;
  let orderStatusCheckCount = 0;

  for (const row of rows) {
    if (row.externalOrderId) {
      linkedOrderIds.add(row.externalOrderId);
    }

    if (row.externalShipmentId) {
      linkedShipmentIds.add(row.externalShipmentId);
    }

    if (row.returnPhaseSignal === "BEFORE_SHIPMENT") {
      beforeShipmentCount += 1;
    } else if (row.returnPhaseSignal === "AFTER_SHIPMENT") {
      afterShipmentCount += 1;
    } else if (row.returnPhaseSignal === "COUPANG_ORDER_STATUS_REQUIRED") {
      orderStatusCheckCount += 1;
    }
  }

  return {
    returnCount: rows.length,
    linkedOrderCount: linkedOrderIds.size,
    linkedShipmentCount: linkedShipmentIds.size,
    matchedDeviceCount: rows.reduce((sum, row) => sum + row.matchedQuantity, 0),
    beforeShipmentCount,
    afterShipmentCount,
    orderStatusCheckCount,
  };
}

async function listReturnRowsByPhase(
  phase: ReturnListPhase,
  input: { limit?: unknown; cursor?: unknown } = {}
) {
  const limit = normalizeKeysetLimit(input.limit, {
    defaultLimit: DEFAULT_LIMIT,
    maxLimit: MAX_LIMIT,
  });
  const queryIdentity = { phase };
  const cursorText = String(input.cursor ?? "").trim();
  const decoded = cursorText
    ? decodeKeysetCursor<
        { snapshotAt: string },
        { syncedAt: string; returnRawId: number }
      >({
        cursor: cursorText,
        contract: RETURN_LIST_CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;
  const snapshotAt = decoded
    ? new Date(decoded.snapshot.snapshotAt)
    : databaseNow();
  const position = decoded
    ? {
        syncedAt: new Date(decoded.position.syncedAt),
        returnRawId: decoded.position.returnRawId,
      }
    : null;
  if (
    Number.isNaN(snapshotAt.getTime()) ||
    (position && Number.isNaN(position.syncedAt.getTime()))
  ) {
    throw new Error("반품 목록 cursor가 올바르지 않습니다.");
  }
  const receiptStatuses =
    phase === "before"
      ? [...COUPANG_RELEASE_STOP_RECEIPT_STATUSES]
      : [...RETURN_RECEIVE_CONFIRM_STATUSES, ...RETURN_APPROVAL_STATUSES];
  const orderStatuses =
    phase === "before"
      ? [...COUPANG_PRE_SHIPMENT_RETURN_ORDER_STATUSES]
      : [...COUPANG_AFTER_SHIPMENT_RETURN_ORDER_STATUSES];
  const phaseExtra =
    phase === "before"
      ? Prisma.sql`AND upper(coalesce(r.return_release_status, '')) IN (${Prisma.join(
          [...COUPANG_RELEASE_STOP_PENDING_STATUSES]
        )})`
      : Prisma.empty;
  const positionPredicate = position
    ? Prisma.sql`AND (r.synced_at, r.coupang_return_raw_id) < (${position.syncedAt}, ${position.returnRawId})`
    : Prisma.empty;
  const totalRows = await prisma.$queryRaw<Array<{ total_count: bigint }>>`
    SELECT COUNT(*)::bigint AS total_count
    FROM coupang_return_raw AS r
    JOIN coupang_order_raw AS o
      ON o.external_order_id = r.external_order_id
     AND o.external_shipment_id = r.external_shipment_id
    LEFT JOIN coupang_return_withdrawal AS w
      ON w.external_receipt_id = r.external_receipt_id
    WHERE upper(coalesce(r.cancel_type, '')) <> 'EXCHANGE'
      AND upper(coalesce(r.return_receipt_status, '')) IN (${Prisma.join(receiptStatuses)})
      AND upper(coalesce(o.external_order_status, '')) IN (${Prisma.join(orderStatuses)})
      ${phaseExtra}
      AND w.coupang_return_withdrawal_id IS NULL
      AND r.updated_at <= ${snapshotAt}
  `;
  const totalCountBigInt = totalRows[0]?.total_count ?? 0n;
  if (totalCountBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("반품 목록 전체 건수가 안전한 범위를 초과했습니다.");
  }
  const totalCount = Number(totalCountBigInt);
  const eligibleRows = await prisma.$queryRaw<
    Array<{ coupang_return_raw_id: number; synced_at: Date }>
  >`
    SELECT r.coupang_return_raw_id, r.synced_at
    FROM coupang_return_raw AS r
    JOIN coupang_order_raw AS o
      ON o.external_order_id = r.external_order_id
     AND o.external_shipment_id = r.external_shipment_id
    LEFT JOIN coupang_return_withdrawal AS w
      ON w.external_receipt_id = r.external_receipt_id
    WHERE upper(coalesce(r.cancel_type, '')) <> 'EXCHANGE'
      AND upper(coalesce(r.return_receipt_status, '')) IN (${Prisma.join(receiptStatuses)})
      AND upper(coalesce(o.external_order_status, '')) IN (${Prisma.join(orderStatuses)})
      ${phaseExtra}
      AND w.coupang_return_withdrawal_id IS NULL
      AND r.updated_at <= ${snapshotAt}
      ${positionPredicate}
    ORDER BY r.synced_at DESC, r.coupang_return_raw_id DESC
    LIMIT ${limit + 1}
  `;
  const pageSeed = createKeysetPage({
    rows: eligibleRows,
    limit,
    coverage: "COMPLETE",
    totalCount,
    cursorFor: (last) =>
      encodeKeysetCursor({
        contract: RETURN_LIST_CURSOR_CONTRACT,
        queryIdentity,
        snapshot: { snapshotAt: snapshotAt.toISOString() },
        position: {
          syncedAt: last.synced_at.toISOString(),
          returnRawId: last.coupang_return_raw_id,
        },
      }),
  });
  const pageIds = pageSeed.items.map((row) => row.coupang_return_raw_id);
  const loadedReturnRows =
    pageIds.length === 0
      ? []
      : await prisma.coupang_return_raw.findMany({
          where: { coupang_return_raw_id: { in: pageIds } },
          include: returnRowInclude,
        });
  const returnRowById = new Map(
    loadedReturnRows.map((row) => [row.coupang_return_raw_id, row])
  );
  const returnRows = pageIds.flatMap((id) => {
    const row = returnRowById.get(id);
    return row ? [row] : [];
  });
  const externalOrderIds = uniqueTexts(
    returnRows.map((row) => row.external_order_id)
  );
  const returnRawIds = returnRows.map((row) => row.coupang_return_raw_id);
  const orders =
    externalOrderIds.length === 0
      ? []
      : await prisma.coupang_order_raw.findMany({
          where: {
            external_order_id: { in: externalOrderIds },
          },
        });
  const allocations =
    externalOrderIds.length === 0
      ? []
      : await prisma.match_worker_allocation.findMany({
          where: {
            external_order_id: { in: externalOrderIds },
            allocation_status: { not: "FAILED" },
          },
          orderBy: [{ allocated_at: "desc" }, { allocation_id: "desc" }],
          include: returnAllocationInclude,
        });
  const linkedAllocations =
    returnRawIds.length === 0
      ? []
      : await prisma.coupang_return_allocation.findMany({
          where: {
            coupang_return_raw_id: { in: returnRawIds },
          },
          select: {
            coupang_return_raw_id: true,
            allocation_id: true,
          },
        });
  const unresolvedWriteRequests =
    returnRows.length === 0
      ? []
      : await prisma.sales_channel_write_requests.findMany({
          where: {
            source_entity_type: "COUPANG_RETURN_RECEIPT",
            request_status: { in: [...SALES_CHANNEL_WRITE_REVIEW_STATUSES] },
          },
          select: {
            sales_channel_write_request_id: true,
            source_entity_id: true,
          },
          orderBy: { sales_channel_write_request_id: "desc" },
        });
  const ordersByExternalId = orderMap(orders);
  const allocationsByExternalOrderId = new Map<string, ReturnAllocation[]>();
  const linkedAllocationsByReturnId = new Map<number, ReturnLinkedAllocation[]>();
  const unresolvedWriteRequestByReceiptId = new Map<string, number>();

  for (const allocation of allocations) {
    const current =
      allocationsByExternalOrderId.get(allocation.external_order_id) ?? [];

    current.push(allocation);
    allocationsByExternalOrderId.set(allocation.external_order_id, current);
  }

  for (const linkedAllocation of linkedAllocations) {
    const current =
      linkedAllocationsByReturnId.get(linkedAllocation.coupang_return_raw_id) ??
      [];

    current.push(linkedAllocation);
    linkedAllocationsByReturnId.set(
      linkedAllocation.coupang_return_raw_id,
      current
    );
  }

  for (const request of unresolvedWriteRequests) {
    const receiptId = String(request.source_entity_id ?? "").trim();

    if (receiptId && !unresolvedWriteRequestByReceiptId.has(receiptId)) {
      unresolvedWriteRequestByReceiptId.set(
        receiptId,
        request.sales_channel_write_request_id
      );
    }
  }

  const items = returnRows
    .map((returnRow) => {
      const orderKey = orderShipmentKey(
        returnRow.external_order_id,
        returnRow.external_shipment_id
      );
      const order = orderKey ? ordersByExternalId.get(orderKey) ?? null : null;
      const orderAllocations =
        allocationsByExternalOrderId.get(returnRow.external_order_id) ?? [];
      const candidateAllocations = returnCandidateAllocations(
        returnRow,
        orderAllocations
      );

      const row = buildReturnWorkRow(
        returnRow,
        order,
        candidateAllocations,
        linkedAllocationsByReturnId.get(returnRow.coupang_return_raw_id) ?? []
      );

      return {
        ...row,
        writeReviewRequired: unresolvedWriteRequestByReceiptId.has(
          returnRow.external_receipt_id
        ),
        writeRequestId:
          unresolvedWriteRequestByReceiptId.get(returnRow.external_receipt_id) ??
          null,
      };
    })
    .filter((row) => shouldShowReturnWorkRow(row, phase));

  const summary = summarizeReturnRows(items);
  return {
    phase,
    summary: {
      ...summary,
      returnCount: totalCount,
    },
    summaryCoverage: pageSeed.hasMore ? "PAGE" : "COMPLETE",
    items,
    nextCursor: pageSeed.nextCursor,
    hasMore: pageSeed.hasMore,
    totalCount,
    coverage: pageSeed.coverage,
  };
}

export async function listBeforeShipmentReturns(
  input: { limit?: unknown; cursor?: unknown } = {}
) {
  return listReturnRowsByPhase("before", input);
}

export async function listAfterShipmentReturns(
  input: { limit?: unknown; cursor?: unknown } = {}
) {
  return listReturnRowsByPhase("after", input);
}

export async function listCoupangReturnRows(
  input: { phase?: unknown; limit?: unknown; cursor?: unknown } = {}
) {
  return listReturnRowsByPhase(normalizePhase(input.phase), {
    limit: input.limit,
    cursor: input.cursor,
  });
}
