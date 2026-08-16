import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { COUPANG_ACTIVE_RETURN_RECEIPT_STATUSES } from "@/quickhack_server/sales-channel/coupang/config";
import { buildReturnItemRequirements } from "@/quickhack_server/returns/return-item-requirement";

type ReturnConflictClient = typeof prisma | Prisma.TransactionClient;

export const SHIPMENT_RETURN_CONFLICT_CODE =
  "RETURN_PROCESSING_REQUIRED" as const;

export type ShipmentReturnConflict = {
  returnRawId: number;
  externalReceiptId: string;
  externalOrderId: string;
  externalShipmentId: string | null;
  externalVendorItemIds: string[];
  vendorItemNames: string[];
  cancelCount: number;
  receiptStatus: string | null;
  releaseStatus: string | null;
  allocationIds: number[];
  pgNos: string[];
  scopeIncomplete: boolean;
};

export type ShipmentReturnConflictAllocation = {
  allocationId: number;
  externalOrderId: string;
  externalShipmentId: string | null;
  externalVendorItemId: string | null;
  pgNo: string;
};

export type ShipmentReturnConflictRawRow = {
  returnRawId: number;
  externalReceiptId: string;
  externalOrderId: string;
  externalShipmentId: string | null;
  cancelType: string | null;
  receiptStatus: string | null;
  releaseStatus: string | null;
  locallyResolved?: boolean;
  cancelCount: number;
  items: Array<{
    externalShipmentId: string | null;
    externalVendorItemId: string | null;
    sellerProductItemId: string | null;
    vendorItemName: string | null;
    cancelCount: number;
  }>;
};

const ACTIVE_RETURN_RECEIPT_STATUS_SET = new Set<string>(
  COUPANG_ACTIVE_RETURN_RECEIPT_STATUSES
);

function text(value: unknown) {
  return String(value ?? "").trim();
}

function code(value: unknown) {
  return text(value).toUpperCase();
}

function uniqueTexts(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map(text).filter(Boolean)));
}

function effectiveCancelCount(row: ShipmentReturnConflictRawRow) {
  if (row.cancelCount > 0) {
    return row.cancelCount;
  }

  const itemCount = row.items.reduce(
    (sum, item) => sum + Math.max(0, item.cancelCount),
    0
  );

  return itemCount > 0 ? itemCount : 1;
}

export function detectShipmentReturnConflicts(
  allocations: ShipmentReturnConflictAllocation[],
  returnRows: ShipmentReturnConflictRawRow[]
) {
  const conflicts: ShipmentReturnConflict[] = [];

  for (const returnRow of returnRows) {
    if (
      code(returnRow.cancelType) === "EXCHANGE" ||
      returnRow.locallyResolved === true ||
      !ACTIVE_RETURN_RECEIPT_STATUS_SET.has(code(returnRow.receiptStatus))
    ) {
      continue;
    }

    const orderAllocations = allocations.filter(
      (allocation) => allocation.externalOrderId === returnRow.externalOrderId
    );

    if (orderAllocations.length === 0) {
      continue;
    }

    const requirementResult = buildReturnItemRequirements({
      rootCancelCount: returnRow.cancelCount,
      items: returnRow.items.map((item) => ({
        externalShipmentId: item.externalShipmentId,
        externalVendorItemId: item.externalVendorItemId,
        cancelCount: item.cancelCount,
        vendorItemName: item.vendorItemName,
      })),
      allocations: orderAllocations,
    });
    const externalVendorItemIds = uniqueTexts(
      returnRow.items.flatMap((item) => [
        item.externalVendorItemId,
        item.sellerProductItemId,
      ])
    );
    const candidateIds = new Set(
      requirementResult.requirements.flatMap(
        (requirement) => requirement.candidateAllocationIds
      )
    );
    const scopeIncomplete = requirementResult.integrityStatus !== "VALID";
    const knownShipmentIds = new Set(
      uniqueTexts([
        returnRow.externalShipmentId,
        ...returnRow.items.map((item) => item.externalShipmentId),
      ])
    );
    const knownVendorItemIds = new Set(
      uniqueTexts(
        returnRow.items.flatMap((item) => [
          item.externalVendorItemId,
          item.sellerProductItemId,
        ])
      )
    );
    const matchedAllocations = scopeIncomplete
      ? orderAllocations.filter(
          (allocation) =>
            (knownShipmentIds.size === 0 ||
              knownShipmentIds.has(text(allocation.externalShipmentId))) &&
            (knownVendorItemIds.size === 0 ||
              knownVendorItemIds.has(text(allocation.externalVendorItemId)))
        )
      : orderAllocations.filter((allocation) =>
          candidateIds.has(allocation.allocationId)
        );

    if (matchedAllocations.length === 0) {
      continue;
    }

    conflicts.push({
      returnRawId: returnRow.returnRawId,
      externalReceiptId: returnRow.externalReceiptId,
      externalOrderId: returnRow.externalOrderId,
      externalShipmentId: returnRow.externalShipmentId,
      externalVendorItemIds,
      vendorItemNames: uniqueTexts(
        returnRow.items.map((item) => item.vendorItemName)
      ),
      cancelCount: effectiveCancelCount(returnRow),
      receiptStatus: returnRow.receiptStatus,
      releaseStatus: returnRow.releaseStatus,
      allocationIds: matchedAllocations.map(
        (allocation) => allocation.allocationId
      ),
      pgNos: uniqueTexts(
        matchedAllocations.map((allocation) => allocation.pgNo)
      ),
      scopeIncomplete,
    });
  }

  return conflicts;
}

export class ShipmentReturnConflictError extends Error {
  readonly code = SHIPMENT_RETURN_CONFLICT_CODE;
  readonly conflicts: ShipmentReturnConflict[];

  constructor(conflicts: ShipmentReturnConflict[]) {
    super(
      `반품 처리가 필요한 주문 ${conflicts.length.toLocaleString("ko-KR")}건이 포함되어 있습니다. 출고 전 반품목록에서 처리한 뒤 다시 시도해 주세요.`
    );
    this.name = "ShipmentReturnConflictError";
    this.conflicts = conflicts;
  }
}

export function isShipmentReturnConflictError(
  error: unknown
): error is ShipmentReturnConflictError {
  return (
    error instanceof ShipmentReturnConflictError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === SHIPMENT_RETURN_CONFLICT_CODE &&
      "conflicts" in error &&
      Array.isArray(error.conflicts))
  );
}

export async function findShipmentReturnConflicts(
  client: ReturnConflictClient,
  allocationIds: number[]
) {
  const uniqueAllocationIds = Array.from(
    new Set(allocationIds.filter((value) => Number.isSafeInteger(value) && value > 0))
  );

  if (uniqueAllocationIds.length === 0) {
    return [];
  }

  const allocationRows = await client.match_worker_allocation.findMany({
    where: {
      allocation_id: { in: uniqueAllocationIds },
    },
    select: {
      allocation_id: true,
      external_order_id: true,
      external_shipment_id: true,
      external_vendor_item_id: true,
      pg_no: true,
    },
  });
  const externalOrderIds = uniqueTexts(
    allocationRows.map((allocation) => allocation.external_order_id)
  );

  if (externalOrderIds.length === 0) {
    return [];
  }

  const [returnRows, withdrawals, allOrderAllocations] = await Promise.all([
    client.coupang_return_raw.findMany({
    where: {
      external_order_id: { in: externalOrderIds },
      OR: [
        { cancel_type: null },
        { cancel_type: { not: "EXCHANGE" } },
      ],
      return_receipt_status: {
        in: [...COUPANG_ACTIVE_RETURN_RECEIPT_STATUSES],
      },
    },
    include: {
      items: true,
      allocations: {
        select: { allocation_id: true, action_type: true },
      },
    },
    }),
    client.coupang_return_withdrawal.findMany({
      where: { external_order_id: { in: externalOrderIds } },
      select: { external_receipt_id: true },
    }),
    client.match_worker_allocation.findMany({
      where: {
        external_order_id: { in: externalOrderIds },
        allocation_status: { not: "FAILED" },
      },
      select: {
        allocation_id: true,
        external_order_id: true,
        external_shipment_id: true,
        external_vendor_item_id: true,
        pg_no: true,
      },
    }),
  ]);
  const withdrawnReceiptIds = new Set(
    withdrawals.map((withdrawal) => withdrawal.external_receipt_id)
  );

  return detectShipmentReturnConflicts(
    allocationRows.map((allocation) => ({
      allocationId: allocation.allocation_id,
      externalOrderId: allocation.external_order_id,
      externalShipmentId: allocation.external_shipment_id,
      externalVendorItemId: allocation.external_vendor_item_id,
      pgNo: allocation.pg_no,
    })),
    returnRows
      .filter(
        (returnRow) => !withdrawnReceiptIds.has(returnRow.external_receipt_id)
      )
      .map((returnRow) => {
      const orderAllocations = allOrderAllocations.filter(
        (allocation) =>
          allocation.external_order_id === returnRow.external_order_id
      );
      const requirements = buildReturnItemRequirements({
        rootCancelCount: returnRow.cancel_count,
        items: returnRow.items.map((item) => ({
          externalShipmentId: item.external_shipment_id,
          externalVendorItemId: item.external_vendor_item_id,
          cancelCount: item.cancel_count,
          vendorItemName: item.vendor_item_name,
        })),
        allocations: orderAllocations.map((allocation) => ({
          allocationId: allocation.allocation_id,
          externalShipmentId: allocation.external_shipment_id,
          externalVendorItemId: allocation.external_vendor_item_id,
          pgNo: allocation.pg_no,
        })),
      });
      const stoppedAllocationIds = new Set(
        returnRow.allocations
          .filter((allocation) => allocation.action_type === "stopShipment")
          .map((allocation) => allocation.allocation_id)
      );
      const locallyResolved =
        requirements.integrityStatus === "VALID" &&
        requirements.requirements.every(
          (requirement) =>
            requirement.candidateAllocationIds.filter((allocationId) =>
              stoppedAllocationIds.has(allocationId)
            ).length === requirement.selectableQuantity
        );
      return {
      returnRawId: returnRow.coupang_return_raw_id,
      externalReceiptId: returnRow.external_receipt_id,
      externalOrderId: returnRow.external_order_id,
      externalShipmentId: returnRow.external_shipment_id,
      cancelType: returnRow.cancel_type,
      receiptStatus: returnRow.return_receipt_status,
      releaseStatus: returnRow.return_release_status,
      locallyResolved,
      cancelCount: returnRow.cancel_count,
      items: returnRow.items.map((item) => ({
        externalShipmentId: item.external_shipment_id,
        externalVendorItemId: item.external_vendor_item_id,
        sellerProductItemId: item.seller_product_item_id,
        vendorItemName: item.vendor_item_name,
        cancelCount: item.cancel_count,
      })),
      }})
  );
}

export async function assertNoShipmentReturnConflicts(
  client: ReturnConflictClient,
  allocationIds: number[]
) {
  const conflicts = await findShipmentReturnConflicts(client, allocationIds);

  if (conflicts.length > 0) {
    throw new ShipmentReturnConflictError(conflicts);
  }
}
