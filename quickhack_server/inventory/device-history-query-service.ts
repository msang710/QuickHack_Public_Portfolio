import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  KeysetCursorError,
  normalizeKeysetLimit,
} from "@/quickhack_server/core/database/keyset-page";
import {
  detailRecord,
  deviceAllocationSelect,
  field,
  inspectionDetail,
  readOnlyFields,
  returnDecisionInclude,
} from "@/quickhack_server/inventory/devices-service";
import {
  maskAddress,
  maskMemo,
  maskName,
  maskPhone,
} from "@/quickhack_server/security/sensitive-data";
import type {
  DeviceHistoryPage,
  DeviceHistorySection,
} from "@/quickhack_shared/device/device-history";
import type { DetailRecord } from "@/quickhack_shared/device/types";
import { publicBadRequest } from "@/quickhack_server/core/public-error";

const DEVICE_HISTORY_CURSOR_CONTRACT = "device-history-v1";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type Snapshot = { maxId: number; totalCount: number };
type Position = { id: number };
type HistoryRow = { id: number; record: DetailRecord };
type InspectionHistoryRow = Prisma.inspectionsGetPayload<object>;

type DeviceHistoryInput = {
  pgNo: string;
  section: DeviceHistorySection;
  cursor?: string | null;
  limit?: unknown;
};

function requireSnapshot(value: Snapshot): Snapshot {
  if (
    !Number.isSafeInteger(value.maxId) ||
    value.maxId < 0 ||
    !Number.isSafeInteger(value.totalCount) ||
    value.totalCount < 0
  ) {
    throw new KeysetCursorError();
  }
  return value;
}

function requirePosition(value: Position): Position {
  if (!Number.isSafeInteger(value.id) || value.id <= 0) {
    throw new KeysetCursorError();
  }
  return value;
}

function inspectionRecord(row: InspectionHistoryRow, index: number) {
  return detailRecord(
    `inspection-${row.inspection_id}`,
    "inspection",
    row.inspection_id,
    `INSPECTION:${index + 1}`,
    inspectionDetail(row),
    row.checked_at || row.function_checked_at || row.appearance_checked_at,
    [
      field("inspection_type", row.inspection_type),
      field("inspection_round", row.inspection_round),
      field("inspection_result", row.inspection_result),
      field("source_type", row.source_type, { readOnly: true }),
      field(
        "coupang_return_allocation_id",
        row.coupang_return_allocation_id,
        { readOnly: true }
      ),
      field("checked_by_user_id", row.checked_by_user_id, {
        readOnly: true,
      }),
      field("checked_at", row.checked_at),
      field("appearance_grade", row.appearance_grade),
      field("appearance_defect", row.appearance_defect),
      field("function_defect", row.function_defect),
      field("return_yn", row.return_yn),
      field("csc", row.csc),
      field("first_call_date", row.first_call_date),
      field("appearance_worker", row.appearance_worker),
      field("function_worker", row.function_worker),
      field("appearance_checked_at", row.appearance_checked_at),
      field("function_checked_at", row.function_checked_at),
      field("note", row.note),
    ],
    row.revision
  );
}

async function loadSnapshot(
  tx: Prisma.TransactionClient,
  pgNo: string,
  section: DeviceHistorySection
): Promise<Snapshot> {
  switch (section) {
    case "inbounds": {
      const [aggregate, totalCount] = await Promise.all([
        tx.inbounds.aggregate({ where: { pg_no: pgNo }, _max: { inbound_id: true } }),
        tx.inbounds.count({ where: { pg_no: pgNo } }),
      ]);
      return { maxId: aggregate._max.inbound_id ?? 0, totalCount };
    }
    case "inspections": {
      const [aggregate, totalCount] = await Promise.all([
        tx.inspections.aggregate({ where: { pg_no: pgNo }, _max: { inspection_id: true } }),
        tx.inspections.count({ where: { pg_no: pgNo } }),
      ]);
      return { maxId: aggregate._max.inspection_id ?? 0, totalCount };
    }
    case "orderItems": {
      const [aggregate, totalCount] = await Promise.all([
        tx.order_items.aggregate({ where: { pg_no: pgNo }, _max: { order_item_id: true } }),
        tx.order_items.count({ where: { pg_no: pgNo } }),
      ]);
      return { maxId: aggregate._max.order_item_id ?? 0, totalCount };
    }
    case "channelOrderMatches": {
      const [aggregate, totalCount] = await Promise.all([
        tx.match_worker_allocation.aggregate({ where: { pg_no: pgNo }, _max: { allocation_id: true } }),
        tx.match_worker_allocation.count({ where: { pg_no: pgNo } }),
      ]);
      return { maxId: aggregate._max.allocation_id ?? 0, totalCount };
    }
    case "shipmentWorks": {
      const where: Prisma.match_worker_allocationWhereInput = {
        pg_no: pgNo,
        OR: [
          { shipment_list_printed_at: { not: null } },
          { shipment_list_print_batch_label: { not: null } },
          { allocation_status: "SHIPMENT_LIST_PRINTED" },
        ],
      };
      const [aggregate, totalCount] = await Promise.all([
        tx.match_worker_allocation.aggregate({ where, _max: { allocation_id: true } }),
        tx.match_worker_allocation.count({ where }),
      ]);
      return { maxId: aggregate._max.allocation_id ?? 0, totalCount };
    }
    case "returnDecisions": {
      const [aggregate, totalCount] = await Promise.all([
        tx.coupang_return_allocation.aggregate({
          where: { pg_no: pgNo },
          _max: { coupang_return_allocation_id: true },
        }),
        tx.coupang_return_allocation.count({ where: { pg_no: pgNo } }),
      ]);
      return {
        maxId: aggregate._max.coupang_return_allocation_id ?? 0,
        totalCount,
      };
    }
  }
}

async function loadRows(
  tx: Prisma.TransactionClient,
  input: {
    pgNo: string;
    section: DeviceHistorySection;
    maxId: number;
    beforeId: number | null;
    take: number;
  }
): Promise<HistoryRow[]> {
  const idRange = {
    lte: input.maxId,
    ...(input.beforeId === null ? {} : { lt: input.beforeId }),
  };

  switch (input.section) {
    case "inbounds": {
      const rows = await tx.inbounds.findMany({
        where: { pg_no: input.pgNo, inbound_id: idRange },
        orderBy: { inbound_id: "desc" },
        take: input.take,
        include: {
          inbound_batch: true,
          _count: { select: { sales_records: true } },
        },
      });
      return rows.map((item, index) => ({
        id: item.inbound_id,
        record: detailRecord(
          `inbound-${item.inbound_id}`,
          "inbound",
          item.inbound_id,
          `INBOUND:${index + 1}`,
          item.inbound_status,
          item.received_at,
          [
            field("batch_date", item.inbound_batch?.batch_date, { readOnly: true }),
            field("batch_no", item.inbound_batch?.batch_no),
            field("supplier_name", item.supplier_name, { readOnly: item._count.sales_records > 0 }),
            field("purchase_price", item.purchase_price, { readOnly: item._count.sales_records > 0 }),
            field("received_at", item.received_at),
            field("price_agreed_at", item.price_agreed_at, { readOnly: item._count.sales_records > 0 }),
            field("inbound_status", item.inbound_status, { readOnly: true }),
            field("note", item.note),
            field("purchase_price_updated_at", item.purchase_price_updated_at, { readOnly: true }),
          ],
          item.revision
        ),
      }));
    }
    case "inspections": {
      const rows = await tx.inspections.findMany({
        where: { pg_no: input.pgNo, inspection_id: idRange },
        orderBy: { inspection_id: "desc" },
        take: input.take,
      });
      return rows.map((item, index) => ({
        id: item.inspection_id,
        record: inspectionRecord(item, index),
      }));
    }
    case "orderItems": {
      const rows = await tx.order_items.findMany({
        where: { pg_no: input.pgNo, order_item_id: idRange },
        orderBy: { order_item_id: "desc" },
        take: input.take,
        include: { orders: true },
      });
      return rows.map((item, index) => ({
        id: item.order_item_id,
        record: detailRecord(
          `order-item-${item.order_item_id}`,
          "orderItem",
          item.order_item_id,
          `ORDER_ITEM:${index + 1}`,
          `${item.orders.platform} / ${item.orders.platform_order_id}`,
          item.orders.ordered_at,
          readOnlyFields([
            field("orders.platform", item.orders.platform),
            field("orders.platform_order_id", item.orders.platform_order_id),
            field("orders.ordered_at", item.orders.ordered_at),
            field("orders.order_status", item.orders.order_status),
            field("sale_product_name", item.sale_product_name),
            field("sale_price", item.sale_price),
            field("quantity", item.quantity),
            field("matched_model", item.matched_model),
            field("matched_storage", item.matched_storage),
            field("matched_color", item.matched_color),
            field("matched_sale_grade", item.matched_sale_grade),
            field("match_status", item.match_status),
            field("orders.buyer_name", maskName(item.orders.buyer_name)),
            field("orders.receiver_name", maskName(item.orders.receiver_name)),
            field("orders.phone", maskPhone(item.orders.phone)),
            field("orders.shipping_address", maskAddress(item.orders.shipping_address)),
            field("orders.shipping_memo", maskMemo(item.orders.shipping_memo)),
          ])
        ),
      }));
    }
    case "channelOrderMatches":
    case "shipmentWorks": {
      const shipmentOnly = input.section === "shipmentWorks";
      const rows = await tx.match_worker_allocation.findMany({
        where: {
          pg_no: input.pgNo,
          allocation_id: idRange,
          ...(shipmentOnly
            ? {
                OR: [
                  { shipment_list_printed_at: { not: null } },
                  { shipment_list_print_batch_label: { not: null } },
                  { allocation_status: "SHIPMENT_LIST_PRINTED" },
                ],
              }
            : {}),
        },
        orderBy: { allocation_id: "desc" },
        take: input.take,
        select: deviceAllocationSelect,
      });
      return rows.map((item, index) => ({
        id: item.allocation_id,
        record: shipmentOnly
          ? detailRecord(
              `shipment-work-${item.allocation_id}`,
              "shipmentWork",
              item.allocation_id,
              `SHIPMENT_WORK:${index + 1}`,
              item.shipment_list_print_batch_label || item.allocation_status,
              item.shipment_list_printed_at || item.allocated_at,
              readOnlyFields([
                field("allocation_status", item.allocation_status),
                field("external_order_id", item.external_order_id),
                field("external_shipment_id", item.external_shipment_id),
                field("external_vendor_item_id", item.external_vendor_item_id),
                field("vendor_item_name", item.vendor_item_name),
                field("seller_product_name", item.seller_product_name),
                field("seller_product_item_name", item.seller_product_item_name),
                field("shipment_list_printed_at", item.shipment_list_printed_at),
                field("shipment_list_print_batch_label", item.shipment_list_print_batch_label),
                field("order.external_order_status", item.order.external_order_status),
                field("order.receiver_name", maskName(item.order.receiver_name)),
                field("order.receiver_safe_number", maskPhone(item.order.receiver_safe_number)),
                field("order.receiver_address_1", maskAddress(item.order.receiver_address_1)),
                field("order.receiver_address_2", maskAddress(item.order.receiver_address_2)),
                field("allocated_at", item.allocated_at),
                field("released_at", item.released_at),
              ])
            )
          : detailRecord(
              `channel-allocation-${item.allocation_id}`,
              "channelOrderMatch",
              item.allocation_id,
              `CHANNEL_ORDER_MATCH:${index + 1}`,
              `COUPANG / ${item.external_order_id}`,
              item.allocated_at,
              readOnlyFields([
                field("order.channel", "COUPANG"),
                field("order.external_order_id", item.external_order_id),
                field("order.external_order_status", item.order.external_order_status),
                field("order.ordered_at", item.order.ordered_at),
                field("order.paid_at", item.order.paid_at),
                field("order.orderer_name", maskName(item.order.orderer_name)),
                field("shipment.external_shipment_id", item.external_shipment_id),
                field("shipment.receiver_name", maskName(item.order.receiver_name)),
                field("shipment.receiver_safe_number", maskPhone(item.order.receiver_safe_number)),
                field("shipment.receiver_address_1", maskAddress(item.order.receiver_address_1)),
                field("shipment.receiver_address_2", maskAddress(item.order.receiver_address_2)),
                field("shipment.receiver_post_code", item.order.receiver_post_code),
                field("item.external_vendor_item_id", item.external_vendor_item_id),
                field("item.vendor_item_name", item.vendor_item_name),
                field("item.external_product_id", item.external_product_id),
                field("item.seller_product_name", item.seller_product_name),
                field("item.seller_product_item_name", item.seller_product_item_name),
                field("item.option_name", item.option_name),
                field("item.available_quantity", item.available_quantity_at_allocation),
                field("item.sales_offer_code", item.sales_offer?.offer_code),
                field("item.required_model", item.required_model),
                field("item.required_storage", item.required_storage),
                field("item.required_color", item.required_color),
                field("item.required_warranty_group", item.required_warranty_group),
                field("allocation_status", item.allocation_status),
                field("failure_reason", item.failure_reason),
                field("inventory_status_before_allocation", item.inventory_status_before_allocation),
                field("allocation_note", item.allocation_note),
                field("allocated_at", item.allocated_at),
                field("released_at", item.released_at),
                field("shipment_list_printed_at", item.shipment_list_printed_at),
                field("shipment_list_print_batch_label", item.shipment_list_print_batch_label),
              ])
            ),
      }));
    }
    case "returnDecisions": {
      const rows = await tx.coupang_return_allocation.findMany({
        where: {
          pg_no: input.pgNo,
          coupang_return_allocation_id: idRange,
        },
        orderBy: { coupang_return_allocation_id: "desc" },
        take: input.take,
        include: returnDecisionInclude,
      });
      return rows.map((item, index) => ({
        id: item.coupang_return_allocation_id,
        record: detailRecord(
          `return-decision-${item.coupang_return_allocation_id}`,
          "returnDecision",
          item.coupang_return_allocation_id,
          `RETURN_DECISION:${index + 1}`,
          item.return_raw.reason_label || item.action_type,
          item.linked_at,
          readOnlyFields([
            field("action_type", item.action_type),
            field("external_receipt_id", item.external_receipt_id),
            field("external_order_id", item.external_order_id),
            field("external_shipment_id", item.external_shipment_id),
            field("external_vendor_item_id", item.external_vendor_item_id),
            field("return_raw.cancel_type", item.return_raw.cancel_type),
            field("return_raw.return_receipt_status", item.return_raw.return_receipt_status),
            field("return_raw.return_release_status", item.return_raw.return_release_status),
            field("return_raw.reason_label", item.return_raw.reason_label),
            field("return_raw.reason_code", item.return_raw.reason_code),
            field("allocation.allocation_status", item.allocation.allocation_status),
            field("allocation.external_order_status_at_allocation", item.allocation.external_order_status_at_allocation),
            field("allocation.shipment_list_print_batch_label", item.allocation.shipment_list_print_batch_label),
            field("linked_by.username", item.linked_by?.username),
            field("linked_at", item.linked_at),
          ])
        ),
      }));
    }
  }
}

export async function getDeviceHistoryPage(
  input: DeviceHistoryInput,
  owner: PrismaClient = prisma
): Promise<DeviceHistoryPage | null> {
  const pgNo = input.pgNo.trim().toUpperCase();
  if (!pgNo) return null;
  const limit = normalizeKeysetLimit(input.limit, {
    defaultLimit: DEFAULT_PAGE_SIZE,
    maxLimit: MAX_PAGE_SIZE,
  });
  const queryIdentity = { pgNo, section: input.section };

  return runConsistentReadSnapshot(owner, "inventory.device-history.read", async (tx) => {
    const exists = await tx.devices.findUnique({ where: { pg_no: pgNo }, select: { device_id: true } });
    if (!exists) return null;

    let decoded: ReturnType<
      typeof decodeKeysetCursor<Snapshot, Position>
    > | null = null;
    try {
      decoded = input.cursor
        ? decodeKeysetCursor<Snapshot, Position>({
            cursor: input.cursor,
            contract: DEVICE_HISTORY_CURSOR_CONTRACT,
            queryIdentity,
          })
        : null;
      if (decoded) {
        requireSnapshot(decoded.snapshot);
        requirePosition(decoded.position);
      }
    } catch (error) {
      if (error instanceof KeysetCursorError) {
        throw publicBadRequest(
          "DEVICE_HISTORY_CURSOR_INVALID",
          "DEVICE_HISTORY_CURSOR_INVALID"
        );
      }
      throw error;
    }
    const snapshot = decoded
      ? requireSnapshot(decoded.snapshot)
      : await loadSnapshot(tx, pgNo, input.section);
    const position = decoded ? requirePosition(decoded.position) : null;
    const rows = await loadRows(tx, {
      pgNo,
      section: input.section,
      maxId: snapshot.maxId,
      beforeId: position?.id ?? null,
      take: limit + 1,
    });
    const page = createKeysetPage({
      rows,
      limit,
      coverage: "COMPLETE",
      totalCount: snapshot.totalCount,
      cursorFor: (last) =>
        encodeKeysetCursor({
          contract: DEVICE_HISTORY_CURSOR_CONTRACT,
          queryIdentity,
          snapshot,
          position: { id: last.id },
        }),
    });

    return {
      section: input.section,
      items: page.items.map((row) => row.record),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      totalCount: snapshot.totalCount,
      coverage: page.coverage,
    };
  });
}
