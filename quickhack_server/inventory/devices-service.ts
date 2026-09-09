// QuickHack note: 기기 목록, 상세 이력, 대시보드 요약을 조회하는 Device 중심 서비스입니다.
import { prisma } from "@/quickhack_server/core/prisma";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import { loadInboundInspectionEvidence } from "@/quickhack_server/inbound/inbound-inspection-evidence-loader";
import {
  effectiveInventoryDisplayStatus,
} from "@/quickhack_shared/inbound/inbound-status";
import {
  type InventoryStatusCode,
} from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_SKU_EDITABLE_STATUSES } from "@/quickhack_shared/inventory/inventory-write-rules";
import type {
  DetailRecord,
  DetailRecordKind,
  DeviceListItem,
} from "@/quickhack_shared/device/types";
import {
  INSPECTION_TYPE,
} from "@/quickhack_shared/inspection/inspection-types";
import {
  apiDateTime,
  compareDateTimes,
  requiredApiDate,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { normalizePgNo } from "@/quickhack_shared/inventory/pg-no";

const DEVICE_WORKSPACE_BATCH_SIZE = 200;
export const deviceAllocationSelect = {
  allocation_id: true,
  allocation_status: true,
  failure_reason: true,
  allocation_note: true,
  allocated_at: true,
  released_at: true,
  external_order_id: true,
  external_shipment_id: true,
  external_vendor_item_id: true,
  external_product_id: true,
  vendor_item_name: true,
  seller_product_name: true,
  seller_product_item_name: true,
  option_name: true,
  external_order_status_at_allocation: true,
  available_quantity_at_allocation: true,
  sales_offer: {
    select: { offer_code: true },
  },
  required_model: true,
  required_storage: true,
  required_color: true,
  required_warranty_group: true,
  inventory_status_before_allocation: true,
  shipment_list_printed_at: true,
  shipment_list_print_batch_id: true,
  shipment_list_print_batch_no: true,
  shipment_list_print_batch_label: true,
  order: {
    select: {
      external_order_id: true,
      external_order_status: true,
      ordered_at: true,
      paid_at: true,
      orderer_name: true,
      receiver_name: true,
      receiver_safe_number: true,
      receiver_address_1: true,
      receiver_address_2: true,
      receiver_post_code: true,
    },
  },
} satisfies Prisma.match_worker_allocationSelect;

const deviceWorkspaceInclude = {
  inbounds: {
    orderBy: { inbound_id: "desc" },
    take: 1,
    include: {
      inbound_batch: true,
      _count: { select: { sales_records: true } },
    },
  },
  inventory: true,
} satisfies Prisma.devicesInclude;
type DeviceWorkspaceRow = Prisma.devicesGetPayload<{
  include: typeof deviceWorkspaceInclude;
}>;
export const returnDecisionInclude = {
  return_raw: true,
  linked_by: {
    select: {
      username: true,
    },
  },
  allocation: {
    select: {
      allocation_id: true,
      allocation_status: true,
      external_order_status_at_allocation: true,
      shipment_list_printed_at: true,
      shipment_list_print_batch_label: true,
    },
  },
} satisfies Prisma.coupang_return_allocationInclude;

export function inspectionDetail(inspection: {
  inspection_type?: string | null;
  inspection_result?: string | null;
  appearance_grade: string | null;
  appearance_defect: string | null;
  function_defect: string | null;
  return_yn: string;
}) {
  const parts = [
    inspection.inspection_type,
    inspection.inspection_result,
    inspection.appearance_grade ? `appearance_grade=${inspection.appearance_grade}` : null,
    inspection.appearance_defect ? `appearance_defect=${inspection.appearance_defect}` : null,
    inspection.function_defect ? `function_defect=${inspection.function_defect}` : null,
    inspection.return_yn === "Y" ? "RETURN_TO_SUPPLIER" : null,
  ].filter(Boolean);

  return parts.join(" / ") || "INSPECTION";
}

function isAppearanceInspection(inspection: {
  inspection_type?: string | null;
  appearance_grade: string | null;
  appearance_checked_at: Date | null;
}) {
  return inspection.inspection_type
    ? inspection.inspection_type === INSPECTION_TYPE.appearance
    : Boolean(inspection.appearance_grade || inspection.appearance_checked_at);
}

function isFunctionInspection(inspection: {
  inspection_type?: string | null;
  function_checked_at: Date | null;
  function_defect: string | null;
  csc: string | null;
  first_call_date: Date | null;
}) {
  return inspection.inspection_type
    ? inspection.inspection_type === INSPECTION_TYPE.function
    : Boolean(
        inspection.function_checked_at ||
          inspection.function_defect ||
          inspection.csc ||
          inspection.first_call_date
      );
}

export function field(
  key: string,
  value: string | number | Date | null | undefined,
  options: {
    displayValue?: string | number | Date | null;
    readOnly?: boolean;
  } = {}
) {
  const formatValue = (candidate: string | number | Date | null | undefined) => {
    if (!(candidate instanceof Date)) {
      return candidate ?? null;
    }

    return key.endsWith("_date")
      ? requiredApiDate(candidate)
      : requiredApiDateTime(candidate);
  };

  return {
    key,
    value: formatValue(value),
    displayValue:
      options.displayValue === undefined
        ? undefined
        : formatValue(options.displayValue),
    readOnly: options.readOnly,
  };
}

export function readOnlyFields(fields: ReturnType<typeof field>[]) {
  return fields.map((item) => ({
    ...item,
    readOnly: true,
  }));
}

export function detailRecord(
  id: string,
  kind: DetailRecordKind,
  recordId: number | null,
  title: string,
  subtitle: string | null,
  at: Date | string | null,
  fields: ReturnType<typeof field>[],
  revision: number | null = null
): DetailRecord {
  return {
    id,
    kind,
    recordId,
    revision,
    title,
    subtitle,
    at: apiDateTime(at),
    fields,
  };
}

async function loadDeviceDetails(options: {
  pgNo?: string;
}, client: Prisma.TransactionClient): Promise<DeviceListItem[]> {
  const orderedDevices = await client.devices.findMany({
    where: options.pgNo ? { pg_no: options.pgNo } : undefined,
    orderBy: [{ updated_at: "desc" }, { device_id: "desc" }],
    select: { device_id: true },
  });
  const rowById = new Map<number, DeviceWorkspaceRow>();

  for (
    let index = 0;
    index < orderedDevices.length;
    index += DEVICE_WORKSPACE_BATCH_SIZE
  ) {
    const batchIds = orderedDevices
      .slice(index, index + DEVICE_WORKSPACE_BATCH_SIZE)
      .map((device) => device.device_id);
    const batchRows = await client.devices.findMany({
      where: { device_id: { in: batchIds } },
      include: deviceWorkspaceInclude,
    });

    batchRows.forEach((row) => rowById.set(row.device_id, row));
  }

  const rows = orderedDevices
    .map((device) => rowById.get(device.device_id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  const inspectionEvidenceByInboundId = await loadInboundInspectionEvidence(
    client,
    rows.flatMap((row) => {
      const inbound = row.inbounds[0];
      return inbound ? [{ pgNo: row.pg_no, inboundId: inbound.inbound_id }] : [];
    })
  );
  const devices = rows.map<DeviceListItem>((row) => {
    const inbound = row.inbounds[0] ?? null;
    const inspections = inbound
      ? inspectionEvidenceByInboundId.get(inbound.inbound_id) ?? []
      : [];
    const resolvedStatus = effectiveInventoryDisplayStatus({
      inboundStatus: inbound?.inbound_status,
      inventoryStatus: row.inventory?.inventory_status,
    });
    const latestAppearanceInspection = inspections.find(isAppearanceInspection);
    const latestFunctionInspection = inspections.find(isFunctionInspection);
    const inspectionCompletedDates = [
      latestAppearanceInspection?.appearance_checked_at,
      latestFunctionInspection?.function_checked_at,
    ]
      .filter((value): value is Date => value instanceof Date)
      .sort(compareDateTimes);
    const skuFieldsReadOnly = Boolean(
      row.inventory &&
        !INVENTORY_SKU_EDITABLE_STATUSES.has(
          row.inventory.inventory_status as InventoryStatusCode
        )
    );
    const detailRecords = {
      devices: [
        detailRecord(
          "device",
          "device",
          row.device_id,
          "DEVICE",
          row.model,
          row.updated_at,
          [
            field("pg_no", row.pg_no, { readOnly: true }),
            field("model", row.model, { readOnly: skuFieldsReadOnly }),
            field("model_code", row.model_code, { readOnly: skuFieldsReadOnly }),
            field("model_seq", row.model_seq),
            field("imei", row.imei),
            field("storage", row.storage, { readOnly: skuFieldsReadOnly }),
            field("color", row.color, { readOnly: skuFieldsReadOnly }),
            field("sale_grade", row.sale_grade, { readOnly: skuFieldsReadOnly }),
            field("warranty", row.warranty),
          ],
          row.revision
        ),
      ],
      inbounds: row.inbounds.map((item, index) =>
        detailRecord(
          `inbound-${item.inbound_id}`,
          "inbound",
          item.inbound_id,
          `INBOUND:${index + 1}`,
          item.inbound_status,
          item.received_at,
          [
            field("batch_date", item.inbound_batch?.batch_date, {
              readOnly: true,
            }),
            field("batch_no", item.inbound_batch?.batch_no),
            field("supplier_name", item.supplier_name, {
              readOnly: item._count.sales_records > 0,
            }),
            field("purchase_price", item.purchase_price, {
              readOnly: item._count.sales_records > 0,
            }),
            field("received_at", item.received_at),
            field("price_agreed_at", item.price_agreed_at, {
              readOnly: item._count.sales_records > 0,
            }),
            field("inbound_status", item.inbound_status, { readOnly: true }),
            field("note", item.note),
            field(
              "purchase_price_updated_at",
              item.purchase_price_updated_at,
              { readOnly: true }
            ),
          ],
          item.revision
        )
      ),
      inspections: inspections.map((item, index) =>
        detailRecord(
          `inspection-${item.inspection_id}`,
          "inspection",
          item.inspection_id,
          `INSPECTION:${index + 1}`,
          inspectionDetail(item),
          item.checked_at || item.function_checked_at || item.appearance_checked_at,
          [
            field("inspection_type", item.inspection_type),
            field("inspection_round", item.inspection_round),
            field("inspection_result", item.inspection_result),
            field("source_type", item.source_type, { readOnly: true }),
            field(
              "coupang_return_allocation_id",
              item.coupang_return_allocation_id,
              { readOnly: true }
            ),
            field("checked_by_user_id", item.checked_by_user_id, {
              readOnly: true,
            }),
            field("checked_at", item.checked_at),
            field("appearance_grade", item.appearance_grade),
            field("appearance_defect", item.appearance_defect),
            field("function_defect", item.function_defect),
            field("return_yn", item.return_yn),
            field("csc", item.csc),
            field("first_call_date", item.first_call_date),
            field("appearance_worker", item.appearance_worker),
            field("function_worker", item.function_worker),
            field("appearance_checked_at", item.appearance_checked_at),
            field("function_checked_at", item.function_checked_at),
            field("note", item.note),
          ],
          item.revision
        )
      ),
      inventory: row.inventory
        ? [
            detailRecord(
              `inventory-${row.inventory.inventory_id}`,
              "inventory",
              row.inventory.inventory_id,
              "INVENTORY",
              row.inventory.inventory_status,
              row.inventory.stocked_at,
              [
                field("inventory_status", row.inventory.inventory_status),
                field("location", row.inventory.location),
                field("stocked_at", row.inventory.stocked_at),
              ],
              row.inventory.revision
            ),
          ]
        : [],
      orderItems: [],
      shipmentWorks: [],
      returnDecisions: [],
      channelOrderMatches: [],
    };

    return {
      deviceId: row.device_id,
      revision: row.revision,
      pgNo: row.pg_no,
      imei: row.imei,
      adbSerial: row.adb_serial,
      model: row.model,
      modelCode: row.model_code,
      modelSeq: row.model_seq,
      storage: row.storage,
      color: row.color,
      appearanceGrade: latestAppearanceInspection?.appearance_grade ?? null,
      appearanceDefect: latestAppearanceInspection?.appearance_defect ?? null,
      functionDefect: latestFunctionInspection?.function_defect ?? null,
      saleGrade: row.sale_grade,
      warranty: row.warranty,
      displayStatus: resolvedStatus,
      createdAt: requiredApiDateTime(row.created_at),
      updatedAt: requiredApiDateTime(row.updated_at),
      appearanceCheckedAt: apiDateTime(latestAppearanceInspection?.appearance_checked_at),
      functionCheckedAt: apiDateTime(latestFunctionInspection?.function_checked_at),
      inspectionCompletedAt:
        apiDateTime(inspectionCompletedDates[inspectionCompletedDates.length - 1]),
      inbound: inbound
        ? {
            id: inbound.inbound_id,
            revision: inbound.revision,
            batchId: inbound.inbound_batch_id,
            batchDate: inbound.inbound_batch?.batch_date
              ? requiredApiDate(inbound.inbound_batch.batch_date)
              : null,
            batchNo: inbound.inbound_batch?.batch_no ?? null,
            supplierName: inbound.supplier_name,
            purchasePrice: inbound.purchase_price,
            receivedAt: apiDateTime(inbound.received_at),
            priceAgreedAt: apiDateTime(inbound.price_agreed_at),
            status: inbound.inbound_status,
            note: inbound.note,
          }
        : null,
      inventory: row.inventory
        ? {
            id: row.inventory.inventory_id,
            revision: row.inventory.revision,
            status: row.inventory.inventory_status,
            location: row.inventory.location,
            stockedAt: apiDateTime(row.inventory.stocked_at),
          }
        : null,
      inspections: inspections.map((inspection) => ({
        id: inspection.inspection_id,
        label: inspection.appearance_worker || inspection.function_worker || "INSPECTION",
        detail: inspectionDetail(inspection),
        at: requiredApiDateTime(
          inspection.checked_at ||
            inspection.function_checked_at ||
            inspection.appearance_checked_at ||
            inspection.created_at
        ),
      })),
      orders: [],
      detailRecords,
    };
  });

  return devices;
}

export async function getDeviceDetailByPgNo(
  pgNo: string,
  owner: PrismaClient = prisma
) {
  const normalizedPgNo = normalizePgNo(pgNo);
  if (!normalizedPgNo) return null;

  return runConsistentReadSnapshot(
    owner,
    "inventory.device-detail.read",
    async (tx) => {
      const devices = await loadDeviceDetails({ pgNo: normalizedPgNo }, tx);
      return devices[0] ?? null;
    }
  );
}
