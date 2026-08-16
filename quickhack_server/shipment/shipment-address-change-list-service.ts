import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  normalizeKeysetLimit,
} from "@/quickhack_server/core/database/keyset-page";
import { maskPhone } from "@/quickhack_server/security/sensitive-data";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import { inventoryStatusLabel } from "@/quickhack_shared/inventory/inventory-status";

const CURSOR_CONTRACT = "shipment-address-changes:v1";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const ALL_STATUS = "ALL";
const ACTION_REQUIRED_STATUS = "ACTION_REQUIRED";

const CHANGE_STATUS_LABELS: Record<string, string> = {
  PENDING: "확인 필요",
  CONFIRMED: "확인 완료",
  IGNORED: "무시",
  FAILED: "처리 실패",
};

const STAGE_LABELS: Record<string, string> = {
  AFTER_PRINT: "출고 목록 출력 후",
  BEFORE_PRINT: "출고 목록 출력 전",
  UNMATCHED: "매칭 없음",
  UNKNOWN: "확인 필요",
  AFTER_SHIPMENT: "집하·배송 시작 후",
};

const FIELD_LABELS: Record<string, string> = {
  receiver_name: "수취인",
  receiver_safe_number: "안심번호",
  receiver_address_1: "주소 1",
  receiver_address_2: "주소 2",
  receiver_post_code: "우편번호",
  shipping_memo: "배송메모",
};

const addressChangeInclude = {
  fields: {
    orderBy: { field_name: "asc" as const },
  },
  order: true,
  api_call_log: true,
  package_group: {
    include: {
      current_carrier_shipment: true,
      invoice_replacement_works: {
        orderBy: {
          carrier_invoice_replacement_work_id: "desc" as const,
        },
        take: 1,
      },
    },
  },
  replacement_work: true,
  device: {
    include: {
      inventory: true,
    },
  },
  allocation: {
    include: {
      device: {
        include: {
          inventory: true,
        },
      },
      shipment_list_print_batch_items: {
        orderBy: { shipment_list_print_batch_item_id: "desc" as const },
        take: 1,
      },
    },
  },
} satisfies Prisma.shipment_address_change_workInclude;

type AddressChangeWorkRow = Prisma.shipment_address_change_workGetPayload<{
  include: typeof addressChangeInclude;
}>;

function normalizedStatus(value: unknown) {
  const status = String(value ?? "").trim().toUpperCase();

  if (!status) return ACTION_REQUIRED_STATUS;
  if (status === ALL_STATUS || status === ACTION_REQUIRED_STATUS) return status;

  return CHANGE_STATUS_LABELS[status] ? status : ALL_STATUS;
}

function textOrNull(value: unknown) {
  const text = String(value ?? "").trim();

  return text || null;
}

function compactText(values: Array<string | number | null | undefined>) {
  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function displayFieldValue(fieldName: string, value: string | null) {
  const text = textOrNull(value);

  if (!text) {
    return null;
  }

  if (fieldName === "receiver_safe_number") {
    return maskPhone(text, 4);
  }

  return text;
}

function statusLabel(status: string | null | undefined) {
  const text = String(status ?? "").trim();

  return text ? CHANGE_STATUS_LABELS[text] ?? text : "-";
}

function stageLabel(stage: string | null | undefined) {
  const text = String(stage ?? "").trim();

  return text ? STAGE_LABELS[text] ?? text : "-";
}

function fieldLabel(fieldName: string) {
  return FIELD_LABELS[fieldName] ?? fieldName;
}

function shipmentBatchText(row: AddressChangeWorkRow) {
  const allocation = row.allocation;

  if (!allocation) {
    return "";
  }

  const label =
    allocation.shipment_list_print_batch_label ||
    (allocation.shipment_list_print_batch_no
      ? `${allocation.shipment_list_print_batch_no}차`
      : "");
  const printLine = allocation.shipment_list_print_batch_items[0]?.print_line_no;

  return label && printLine ? `${label}-${printLine}` : label;
}

function toDto(row: AddressChangeWorkRow) {
  const device = row.allocation?.device ?? row.device ?? null;
  const inventoryStatus = device?.inventory?.inventory_status ?? null;
  const fields = row.fields.map((field) => ({
    fieldName: field.field_name,
    fieldLabel: fieldLabel(field.field_name),
    beforeValue: displayFieldValue(field.field_name, field.before_value),
    afterValue: displayFieldValue(field.field_name, field.after_value),
  }));
  const replacement =
    row.replacement_work ??
    row.package_group?.invoice_replacement_works[0] ??
    null;
  const currentShipment = row.package_group?.current_carrier_shipment ?? null;
  const canStartReplacement =
    row.change_status === "PENDING" &&
    row.shipment_stage_at_detection === "AFTER_PRINT" &&
    row.package_group?.group_status === "READY" &&
    Boolean(currentShipment) &&
    ["ALLOCATED", "REGISTERED"].includes(
      currentShipment?.shipment_status ?? ""
    ) &&
    !replacement;

  return {
    id: row.shipment_address_change_work_id,
    changeStatus: row.change_status,
    changeStatusLabel: statusLabel(row.change_status),
    shipmentStage: row.shipment_stage_at_detection,
    shipmentStageLabel: stageLabel(row.shipment_stage_at_detection),
    allocationStatus: row.allocation_status_at_detection,
    externalOrderId: row.external_order_id,
    externalShipmentId: row.external_shipment_id,
    channelStatus: row.order.external_order_status,
    orderedAt: row.order.ordered_at,
    detectedAt: row.detected_at,
    confirmedAt: row.confirmed_at,
    ignoredAt: row.ignored_at,
    failedAt: row.failed_at,
    memo: row.memo,
    pgNo: row.pg_no ?? row.allocation?.pg_no ?? null,
    uniqueNo: device
      ? formatModelSeqLabel(device.model, device.model_seq)
      : "",
    model: device?.model ?? null,
    storage: device?.storage ?? null,
    color: device?.color ?? null,
    saleGrade: device?.sale_grade ?? null,
    inventoryStatus,
    inventoryStatusLabel: inventoryStatusLabel(inventoryStatus),
    shipmentBatchText: shipmentBatchText(row),
    receiverName: row.order.receiver_name ?? "",
    receiverSafeNumber: maskPhone(row.order.receiver_safe_number, 4),
    receiverAddress: compactText([
      row.order.receiver_post_code,
      row.order.receiver_address_1,
      row.order.receiver_address_2,
    ]),
    shippingMemo: row.order.shipping_memo ?? "",
    changedFieldsText: fields.map((field) => field.fieldLabel).join(", "),
    fields,
    apiCallLogId: row.api_call_log_id,
    apiName: row.api_call_log?.api_name ?? null,
    apiReceivedAt: row.api_call_log?.received_at ?? null,
    packageGroupId: row.package_group_id,
    packageGroupStatus: row.package_group?.group_status ?? null,
    currentCarrierShipmentId:
      row.package_group?.current_carrier_shipment_id ??
      row.carrier_shipment_id_at_detection,
    currentTrackingNumber: currentShipment?.tracking_number ?? null,
    currentShipmentStatus: currentShipment?.shipment_status ?? null,
    replacementWorkId:
      replacement?.carrier_invoice_replacement_work_id ?? null,
    replacementStatus: replacement?.work_status ?? null,
    replacementStage: replacement?.current_stage ?? null,
    canStartReplacement,
    replacementBlockedReason: canStartReplacement
      ? null
      : replacement
        ? "이미 연결된 송장 교체 작업이 있습니다."
        : row.shipment_stage_at_detection === "AFTER_SHIPMENT"
          ? "집하 또는 배송이 시작되어 자동 재발급할 수 없습니다."
          : row.package_group?.group_status !== "READY"
            ? "현재 합포장 그룹이 재발급 가능한 상태가 아닙니다."
            : "송장 교체 대상을 확인할 수 없습니다.",
  };
}

export async function listShipmentAddressChangeRows(input: {
  status?: unknown;
  limit?: unknown;
  cursor?: unknown;
} = {}) {
  const status = normalizedStatus(input.status);
  const limit = normalizeKeysetLimit(input.limit, {
    defaultLimit: DEFAULT_LIMIT,
    maxLimit: MAX_LIMIT,
  });
  const where: Prisma.shipment_address_change_workWhereInput =
    status === ALL_STATUS
      ? {}
      : status === ACTION_REQUIRED_STATUS
        ? { change_status: { in: ["PENDING", "FAILED"] } }
        : { change_status: status };
  const queryIdentity = { status };
  const cursorText = String(input.cursor ?? "").trim();
  type Snapshot = {
    maxWorkId: number;
    totalCount: number;
    filteredCount: number;
    pendingCount: number;
    confirmedCount: number;
    ignoredCount: number;
    failedCount: number;
  };
  const decoded = cursorText
    ? decodeKeysetCursor<Snapshot, { detectedAt: string; workId: number }>({
        cursor: cursorText,
        contract: CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;

  return runConsistentReadSnapshot(
    prisma,
    "shipment.address-change.read",
    async (tx) => {
      const snapshot = decoded?.snapshot ??
        (await (async () => {
          const [aggregate, statusGroups, filteredCount] = await Promise.all([
            tx.shipment_address_change_work.aggregate({
              _max: { shipment_address_change_work_id: true },
              _count: { _all: true },
            }),
            tx.shipment_address_change_work.groupBy({
              by: ["change_status"],
              _count: { _all: true },
            }),
            tx.shipment_address_change_work.count({ where }),
          ]);
          const counts = Object.fromEntries(
            statusGroups.map((group) => [group.change_status, group._count._all])
          );
          return {
            maxWorkId: aggregate._max.shipment_address_change_work_id ?? 0,
            totalCount: aggregate._count._all,
            filteredCount,
            pendingCount: counts.PENDING ?? 0,
            confirmedCount: counts.CONFIRMED ?? 0,
            ignoredCount: counts.IGNORED ?? 0,
            failedCount: counts.FAILED ?? 0,
          };
        })());
      const position = decoded
        ? {
            detectedAt: new Date(decoded.position.detectedAt),
            workId: decoded.position.workId,
          }
        : null;
      if (position && Number.isNaN(position.detectedAt.getTime())) {
        throw new Error("배송지 변경 목록 cursor가 올바르지 않습니다.");
      }
      const rows = await tx.shipment_address_change_work.findMany({
        where: {
          AND: [
            where,
            {
              shipment_address_change_work_id: { lte: snapshot.maxWorkId },
            },
            ...(position
              ? [{
                  OR: [
                    { detected_at: { lt: position.detectedAt } },
                    {
                      detected_at: position.detectedAt,
                      shipment_address_change_work_id: { lt: position.workId },
                    },
                  ],
                }]
              : []),
          ],
        },
        orderBy: [
          { detected_at: "desc" },
          { shipment_address_change_work_id: "desc" },
        ],
        take: limit + 1,
        include: addressChangeInclude,
      });
      const page = createKeysetPage({
        rows,
        limit,
        coverage: "COMPLETE",
        totalCount: snapshot.filteredCount,
        cursorFor: (last) =>
          encodeKeysetCursor({
            contract: CURSOR_CONTRACT,
            queryIdentity,
            snapshot,
            position: {
              detectedAt: last.detected_at.toISOString(),
              workId: last.shipment_address_change_work_id,
            },
          }),
      });
      const items = page.items.map(toDto);
      return {
        status,
        limit,
        summary: {
          totalCount: snapshot.totalCount,
          filteredCount: snapshot.filteredCount,
          returnedCount: items.length,
          pendingCount: snapshot.pendingCount,
          confirmedCount: snapshot.confirmedCount,
          ignoredCount: snapshot.ignoredCount,
          failedCount: snapshot.failedCount,
        },
        items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        totalCount: snapshot.filteredCount,
        coverage: page.coverage,
      };
    }
  );
}
