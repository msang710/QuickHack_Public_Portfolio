import { Prisma } from "@/generated/prisma/client";
import {
  databaseDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import type { DateTimeInput } from "@/quickhack_shared/core/time";

type TransactionClient = Prisma.TransactionClient;

export async function lockSalesAllocationRoots(
  tx: TransactionClient,
  allocationIds: readonly number[]
) {
  const ids = Array.from(
    new Set(allocationIds.filter((value) => Number.isSafeInteger(value) && value > 0))
  ).sort((left, right) => left - right);
  if (ids.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ allocation_id: number }>>`
    SELECT allocation_id
    FROM match_worker_allocation
    WHERE allocation_id IN (${Prisma.join(ids)})
    ORDER BY allocation_id
    FOR UPDATE
  `;
  if (rows.length !== ids.length) {
    throw new Error("One or more sales allocation roots no longer exist.");
  }
  return ids;
}

export async function markSalesRecordsReturnedForAllocations(
  tx: TransactionClient,
  input: { allocationIds: readonly number[]; returnedAt: DateTimeInput }
) {
  const allocationIds = await lockSalesAllocationRoots(tx, input.allocationIds);
  if (allocationIds.length === 0) return { updatedCount: 0 };
  const rows = await tx.sales_records.findMany({
    where: { allocation_id: { in: allocationIds } },
    select: { allocation_id: true, sale_status: true },
  });
  const invalid = rows.filter(
    (row) => row.sale_status !== "SOLD" && row.sale_status !== "RETURNED"
  );
  if (invalid.length > 0) {
    throw new Error(
      `Cannot confirm a return from sales states: ${invalid
        .map((row) => `${row.allocation_id}:${row.sale_status}`)
        .join(", ")}`
    );
  }
  const updated = await tx.sales_records.updateMany({
    where: { allocation_id: { in: allocationIds }, sale_status: "SOLD" },
    data: {
      sale_status: "RETURNED",
      updated_at: databaseDateTime(input.returnedAt),
    },
  });
  return { updatedCount: updated.count };
}

export type DeliveredSalesAllocationSource = {
  allocationId: number;
  pgNo: string;
  salesOfferId: number | null;
  inventorySkuId: number | null;
  externalOrderId: string;
  externalShipmentId: string | null;
  externalVendorItemId: string | null;
  latestPurchasePrice: number | null;
  purchaseInboundId: number | null;
  supplierName: string | null;
  purchaseAgreedAt: Date | string | null;
  model: string | null;
  storage: string | null;
  color: string | null;
  saleGrade: string | null;
  warrantyGroup: string | null;
  hasApprovedReturn: boolean;
};

export type DeliveredSalesProjectionInput = {
  channel: string;
  soldAt: DateTimeInput;
  allocations: DeliveredSalesAllocationSource[];
};

type NormalizedDeliveredSalesAllocation = DeliveredSalesAllocationSource & {
  pgNo: string;
  externalOrderId: string;
  externalShipmentId: string | null;
  externalVendorItemId: string | null;
  supplierName: string | null;
  purchaseAgreedAt: Date | null;
  model: string | null;
  storage: string | null;
  color: string | null;
  saleGrade: string | null;
  warrantyGroup: string | null;
};

function requiredText(value: unknown, label: string) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(`${label} 값이 비어 있습니다.`);
  }

  return normalized;
}

function optionalText(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function requiredPositiveInteger(value: unknown, label: string) {
  const normalized = Number(value);

  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} 값이 올바르지 않습니다.`);
  }

  return normalized;
}

function nullableNonNegativeInteger(value: unknown, label: string) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = Number(value);

  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${label} 값이 올바르지 않습니다.`);
  }

  return normalized;
}

function nullablePositiveInteger(value: unknown, label: string) {
  if (value === null || value === undefined) {
    return null;
  }

  return requiredPositiveInteger(value, label);
}

function timestampMillis(value: Date | string) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }

  const normalized = value.trim();
  const sqlDateTimeMatch =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(
      normalized
    );
  const parseTarget = sqlDateTimeMatch
    ? `${sqlDateTimeMatch[1]}T${sqlDateTimeMatch[2]}${
        sqlDateTimeMatch[3] ? `.${sqlDateTimeMatch[3]}` : ""
      }+09:00`
    : normalized;
  const parsed = Date.parse(parseTarget);

  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSoldAt(value: unknown) {
  return databaseDateTime(value as DateTimeInput);
}

function earlierSoldAt(current: Date | string, incoming: Date) {
  const currentMillis = timestampMillis(current);
  const incomingMillis = timestampMillis(incoming);

  if (incomingMillis === null) {
    throw new Error("배송 완료 시각 형식이 올바르지 않습니다.");
  }

  if (currentMillis === null || incomingMillis < currentMillis) {
    return incoming;
  }

  return current;
}

function normalizeAllocation(
  source: DeliveredSalesAllocationSource
): NormalizedDeliveredSalesAllocation {
  return {
    ...source,
    allocationId: requiredPositiveInteger(source.allocationId, "allocation ID"),
    pgNo: requiredText(source.pgNo, "PG"),
    salesOfferId:
      source.salesOfferId === null
        ? null
        : requiredPositiveInteger(source.salesOfferId, "판매 offer ID"),
    inventorySkuId:
      source.inventorySkuId === null
        ? null
        : requiredPositiveInteger(source.inventorySkuId, "재고 SKU ID"),
    externalOrderId: requiredText(source.externalOrderId, "외부 주문번호"),
    externalShipmentId: optionalText(source.externalShipmentId),
    externalVendorItemId: optionalText(source.externalVendorItemId),
    latestPurchasePrice: nullableNonNegativeInteger(
      source.latestPurchasePrice,
      "매입가"
    ),
    purchaseInboundId: nullablePositiveInteger(
      source.purchaseInboundId,
      "매입 inbound ID"
    ),
    supplierName: optionalText(source.supplierName),
    purchaseAgreedAt: source.purchaseAgreedAt
      ? databaseDateTime(source.purchaseAgreedAt)
      : null,
    model: optionalText(source.model),
    storage: optionalText(source.storage),
    color: optionalText(source.color),
    saleGrade: optionalText(source.saleGrade),
    warrantyGroup: optionalText(source.warrantyGroup),
    hasApprovedReturn: source.hasApprovedReturn === true,
  };
}

function workItemKey(input: {
  channel: string;
  externalOrderId: string;
  externalShipmentId: string | null;
  externalVendorItemId: string | null;
}) {
  return [
    input.channel,
    input.externalOrderId,
    input.externalShipmentId ?? "",
    input.externalVendorItemId ?? "",
  ].join("\u001f");
}

async function loadSalesPrices(
  tx: TransactionClient,
  channel: string,
  allocations: NormalizedDeliveredSalesAllocation[]
) {
  const exactKeys = allocations.filter(
    (
      allocation
    ): allocation is NormalizedDeliveredSalesAllocation & {
      externalShipmentId: string;
      externalVendorItemId: string;
    } =>
      allocation.externalShipmentId !== null &&
      allocation.externalVendorItemId !== null
  );

  if (exactKeys.length === 0) {
    return new Map<string, number | null>();
  }

  const rows = await tx.order_matching_work_queue.findMany({
    where: {
      OR: exactKeys.map((allocation) => ({
        channel,
        external_order_id: allocation.externalOrderId,
        external_shipment_id: allocation.externalShipmentId,
        external_vendor_item_id: allocation.externalVendorItemId,
      })),
    },
    select: {
      channel: true,
      external_order_id: true,
      external_shipment_id: true,
      external_vendor_item_id: true,
      sales_price: true,
    },
  });

  return new Map(
    rows.map((row) => [
      workItemKey({
        channel: row.channel,
        externalOrderId: row.external_order_id,
        externalShipmentId: row.external_shipment_id,
        externalVendorItemId: row.external_vendor_item_id,
      }),
      row.sales_price,
    ])
  );
}

export async function projectDeliveredSalesRecords(
  tx: TransactionClient,
  input: DeliveredSalesProjectionInput
) {
  const channel = requiredText(input.channel, "판매 채널");
  const soldAt = normalizeSoldAt(input.soldAt);
  const projectedAt = databaseNow();
  const allocationById = new Map<number, NormalizedDeliveredSalesAllocation>();

  for (const source of input.allocations) {
    const allocation = normalizeAllocation(source);

    if (!allocationById.has(allocation.allocationId)) {
      allocationById.set(allocation.allocationId, allocation);
    }
  }

  const allocations = Array.from(allocationById.values());

  if (allocations.length === 0) {
    return {
      createdCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
    };
  }

  const allocationIds = await lockSalesAllocationRoots(
    tx,
    allocations.map((allocation) => allocation.allocationId)
  );
  const approvedReturnRows = await tx.coupang_return_allocation.findMany({
    where: {
      allocation_id: { in: allocationIds },
      action_type: "approve",
    },
    select: { allocation_id: true },
  });
  const approvedReturnAllocationIds = new Set(
    approvedReturnRows.map((row) => row.allocation_id)
  );

  const salesPriceByWorkItem = await loadSalesPrices(
    tx,
    channel,
    allocations
  );
  const existingRows = await tx.sales_records.findMany({
    where: {
      allocation_id: {
        in: allocations.map((allocation) => allocation.allocationId),
      },
    },
  });
  const existingByAllocationId = new Map(
    existingRows.map((row) => [row.allocation_id, row])
  );
  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const allocation of allocations) {
    const salesPrice =
      allocation.externalShipmentId && allocation.externalVendorItemId
        ? (salesPriceByWorkItem.get(
            workItemKey({
              channel,
              externalOrderId: allocation.externalOrderId,
              externalShipmentId: allocation.externalShipmentId,
              externalVendorItemId: allocation.externalVendorItemId,
            })
          ) ?? null)
        : null;
    const existedBefore = existingByAllocationId.has(allocation.allocationId);
    const row = await tx.sales_records.upsert({
      where: { allocation_id: allocation.allocationId },
      create: {
        allocation_id: allocation.allocationId,
        pg_no: allocation.pgNo,
        sales_offer_id: allocation.salesOfferId,
        inventory_sku_id: allocation.inventorySkuId,
        channel,
        external_order_id: allocation.externalOrderId,
        external_shipment_id: allocation.externalShipmentId,
        external_vendor_item_id: allocation.externalVendorItemId,
        sold_at: soldAt,
        sale_status:
          allocation.hasApprovedReturn ||
          approvedReturnAllocationIds.has(allocation.allocationId)
            ? "RETURNED"
            : "SOLD",
        sales_price: salesPrice,
        purchase_price: allocation.latestPurchasePrice,
        purchase_inbound_id: allocation.purchaseInboundId,
        supplier_name: allocation.supplierName,
        purchase_agreed_at: allocation.purchaseAgreedAt,
        model: allocation.model,
        storage: allocation.storage,
        color: allocation.color,
        sale_grade: allocation.saleGrade,
        warranty_group: allocation.warrantyGroup,
        created_at: projectedAt,
        updated_at: projectedAt,
      },
      update: {},
    });

    if (!existedBefore) {
      createdCount += 1;
      continue;
    }

    const update: Prisma.sales_recordsUncheckedUpdateInput = {};
    const earliestSoldAt = earlierSoldAt(row.sold_at, soldAt);
    if (
      row.sale_status === "SOLD" &&
      (allocation.hasApprovedReturn ||
        approvedReturnAllocationIds.has(allocation.allocationId))
    ) {
      update.sale_status = "RETURNED";
    }

    if (earliestSoldAt !== row.sold_at) {
      update.sold_at = earliestSoldAt;
    }
    if (row.sales_offer_id === null && allocation.salesOfferId !== null) {
      update.sales_offer_id = allocation.salesOfferId;
    }
    if (row.inventory_sku_id === null && allocation.inventorySkuId !== null) {
      update.inventory_sku_id = allocation.inventorySkuId;
    }
    if (
      row.external_shipment_id === null &&
      allocation.externalShipmentId !== null
    ) {
      update.external_shipment_id = allocation.externalShipmentId;
    }
    if (
      row.external_vendor_item_id === null &&
      allocation.externalVendorItemId !== null
    ) {
      update.external_vendor_item_id = allocation.externalVendorItemId;
    }
    if (row.sales_price === null && salesPrice !== null) {
      update.sales_price = salesPrice;
    }
    if (
      row.purchase_price === null &&
      allocation.latestPurchasePrice !== null
    ) {
      update.purchase_price = allocation.latestPurchasePrice;
    }
    if (
      row.purchase_inbound_id === null &&
      allocation.purchaseInboundId !== null
    ) {
      update.purchase_inbound_id = allocation.purchaseInboundId;
    }
    if (row.supplier_name === null && allocation.supplierName !== null) {
      update.supplier_name = allocation.supplierName;
    }
    if (
      row.purchase_agreed_at === null &&
      allocation.purchaseAgreedAt !== null
    ) {
      update.purchase_agreed_at = allocation.purchaseAgreedAt;
    }
    if (row.model === null && allocation.model !== null) {
      update.model = allocation.model;
    }
    if (row.storage === null && allocation.storage !== null) {
      update.storage = allocation.storage;
    }
    if (row.color === null && allocation.color !== null) {
      update.color = allocation.color;
    }
    if (row.sale_grade === null && allocation.saleGrade !== null) {
      update.sale_grade = allocation.saleGrade;
    }
    if (row.warranty_group === null && allocation.warrantyGroup !== null) {
      update.warranty_group = allocation.warrantyGroup;
    }

    if (Object.keys(update).length === 0) {
      unchangedCount += 1;
      continue;
    }

    update.updated_at = projectedAt;
    await tx.sales_records.update({
      where: { allocation_id: allocation.allocationId },
      data: update,
    });
    updatedCount += 1;
  }

  return {
    createdCount,
    updatedCount,
    unchangedCount,
  };
}
