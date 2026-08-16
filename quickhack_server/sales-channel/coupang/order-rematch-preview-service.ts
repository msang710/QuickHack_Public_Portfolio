// QuickHack note: 명시적 재매칭 전에 되돌릴 수 있는 출고 건과 제외 사유를 읽기 전용으로 판정합니다.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { findShipmentReturnConflicts } from "@/quickhack_server/returns/shipment-return-conflict-service";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import {
  ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
  INVENTORY_MATCH_STATUSES,
  RANDOM_MATCHING_OPTION_VALUE,
} from "@/quickhack_shared/sales-channel/order-matching";
import { SALES_CHANNEL_WRITE_REQUEST_STATUS } from "@/quickhack_shared/sales-channel/write-requests";
import { nowKstSqlDateTime } from "@/quickhack_shared/core/time";
import { warrantyGroupLabel } from "@/quickhack_shared/sales-channel/sales-matching";

const COUPANG_CHANNEL = "COUPANG";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const QUERY_CHUNK_SIZE = 80;
const CANDIDATE_SCAN_BATCH_SIZE = 80;
const REVERSIBLE_ALLOCATION_STATUSES = new Set(["ALLOCATED", "API_ACKED"]);
const REVERSIBLE_ORDER_STATUSES = new Set(["ACCEPT", "INSTRUCT"]);
const TERMINAL_PACKAGE_GROUP_STATUSES = new Set([
  "CANCELED",
  "INVALIDATED",
  "SPLIT",
]);
const IN_FLIGHT_WRITE_STATUSES = [
  SALES_CHANNEL_WRITE_REQUEST_STATUS.pending,
  SALES_CHANNEL_WRITE_REQUEST_STATUS.sending,
  SALES_CHANNEL_WRITE_REQUEST_STATUS.verifying,
  SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
  SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
] as const;

export const COUPANG_ORDER_REMATCH_EXCLUSION = {
  shipmentNotFullyMatched: "SHIPMENT_NOT_FULLY_MATCHED",
  currentMappingUnavailable: "CURRENT_MAPPING_UNAVAILABLE",
  allocationQuantityMismatch: "ALLOCATION_QUANTITY_MISMATCH",
  allocationNotReversible: "ALLOCATION_NOT_REVERSIBLE",
  inventoryNotReserved: "INVENTORY_NOT_RESERVED",
  outboundHandoffStarted: "OUTBOUND_HANDOFF_STARTED",
  writeRequestPending: "WRITE_REQUEST_PENDING",
  returnFlowExists: "RETURN_FLOW_EXISTS",
  salesRecordExists: "SALES_RECORD_EXISTS",
  orderStatusNotReversible: "ORDER_STATUS_NOT_REVERSIBLE",
  snapshotInconsistent: "SNAPSHOT_INCONSISTENT",
} as const;

export type CoupangOrderRematchExclusionCode =
  (typeof COUPANG_ORDER_REMATCH_EXCLUSION)[keyof typeof COUPANG_ORDER_REMATCH_EXCLUSION];

const EXCLUSION_LABELS: Record<CoupangOrderRematchExclusionCode, string> = {
  SHIPMENT_NOT_FULLY_MATCHED: "출고 건 전체가 매칭 완료 상태가 아님",
  CURRENT_MAPPING_UNAVAILABLE: "현재 적용할 상품 기본 매핑이 없음",
  ALLOCATION_QUANTITY_MISMATCH: "주문 수량과 활성 PG 배정 수량이 다름",
  ALLOCATION_NOT_REVERSIBLE: "이미 출력 확정된 PG 배정이 있음",
  INVENTORY_NOT_RESERVED: "PG 재고가 주문확인 상태가 아님",
  OUTBOUND_HANDOFF_STARTED: "출력 차수 또는 합포장 작업이 시작됨",
  WRITE_REQUEST_PENDING: "외부 API 처리 또는 확인이 진행 중임",
  RETURN_FLOW_EXISTS: "반품 처리가 진행 중이거나 연결된 이력이 있음",
  SALES_RECORD_EXISTS: "매출 원장이 이미 생성됨",
  ORDER_STATUS_NOT_REVERSIBLE: "쿠팡 주문이 재매칭 가능 단계를 지남",
  SNAPSHOT_INCONSISTENT: "주문·오퍼·PG 배정 스냅샷이 서로 다름",
};

const offerInclude = {
  model_option: true,
  storage_option: true,
  color_option: true,
  warranty_group_option: true,
} satisfies Prisma.sales_offersInclude;

const workItemInclude = {
  sales_offer: {
    include: offerInclude,
  },
} satisfies Prisma.order_matching_work_queueInclude;

const mappingInclude = {
  sales_offer: {
    include: offerInclude,
  },
} satisfies Prisma.sales_channel_product_mappingsInclude;

const allocationInclude = {
  device: {
    select: {
      pg_no: true,
      inventory: {
        select: {
          inventory_status: true,
        },
      },
    },
  },
  shipment_list_print_batch_items: {
    select: {
      batch: {
        select: {
          batch_status: true,
        },
      },
    },
  },
  package_group_members: {
    where: {
      removed_at: null,
    },
    select: {
      package_group: {
        select: {
          group_status: true,
        },
      },
    },
  },
  coupang_return_allocations: {
    select: {
      coupang_return_allocation_id: true,
    },
  },
  sales_records: {
    select: {
      sale_record_id: true,
    },
  },
} satisfies Prisma.match_worker_allocationInclude;

type WorkItemRow = Prisma.order_matching_work_queueGetPayload<{
  include: typeof workItemInclude;
}>;
type MappingRow = Prisma.sales_channel_product_mappingsGetPayload<{
  include: typeof mappingInclude;
}>;
type AllocationRow = Prisma.match_worker_allocationGetPayload<{
  include: typeof allocationInclude;
}>;
type RawOrderRow = Pick<
  Prisma.coupang_order_rawGetPayload<object>,
  "external_order_id" | "external_shipment_id" | "external_order_status"
>;

type ShipmentKey = {
  external_order_id: string;
  external_shipment_id: string;
};

type CandidateShipmentSeed = ShipmentKey & {
  firstWorkItemId: number;
};

type RawCandidateShipmentSeed = ShipmentKey & {
  first_work_item_id: number | bigint;
};

function chunks<T>(items: T[], size = QUERY_CHUNK_SIZE) {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function positiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function optionalPositiveInt(value: unknown) {
  const text = String(value ?? "").trim();

  if (!text) {
    return null;
  }

  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function shipmentKey(input: ShipmentKey) {
  return `${input.external_order_id}\u0000${input.external_shipment_id}`;
}

function itemKey(input: ShipmentKey & { external_vendor_item_id: string | null }) {
  return `${shipmentKey(input)}\u0000${input.external_vendor_item_id ?? ""}`;
}

function optionValue(
  mode: string,
  option: { label: string } | null | undefined
) {
  if (mode === "RANDOM") {
    return RANDOM_MATCHING_OPTION_VALUE;
  }

  return mode === "EXACT" ? option?.label ?? null : null;
}

function offerPreview(
  offer:
    | WorkItemRow["sales_offer"]
    | MappingRow["sales_offer"]
    | null
    | undefined
) {
  if (!offer) {
    return null;
  }

  return {
    salesOfferId: offer.sales_offer_id,
    offerCode: offer.offer_code,
    model: offer.model_option.label,
    storage: optionValue(offer.storage_match_mode, offer.storage_option),
    color: optionValue(offer.color_match_mode, offer.color_option),
    warrantyGroup: offer.warranty_group_option.option_key,
    warrantyLabel: offer.warranty_group_option.label,
    isActive: offer.is_active === 1,
  };
}

function workItemOfferPreview(row: WorkItemRow) {
  if (
    !row.sales_offer_id ||
    !row.sales_offer ||
    !row.required_model_label ||
    !row.required_warranty_group
  ) {
    return null;
  }

  return {
    salesOfferId: row.sales_offer_id,
    offerCode: row.sales_offer.offer_code,
    model: row.required_model_label,
    storage: row.required_storage_label,
    color: row.required_color_label,
    warrantyGroup: row.required_warranty_group,
    warrantyLabel: warrantyGroupLabel(row.required_warranty_group),
    isActive: row.sales_offer.is_active === 1,
  };
}

function addReason(
  target: Set<CoupangOrderRematchExclusionCode>,
  reason: CoupangOrderRematchExclusionCode
) {
  target.add(reason);
}

function reasonDto(code: CoupangOrderRematchExclusionCode) {
  return { code, label: EXCLUSION_LABELS[code] };
}

function allocationPreview(allocation: AllocationRow) {
  return {
    allocationId: allocation.allocation_id,
    pgNo: allocation.pg_no,
    salesOfferId: allocation.sales_offer_id,
    allocationStatus: allocation.allocation_status,
    inventoryStatus: allocation.device.inventory?.inventory_status ?? null,
  };
}

function evaluateShipment(input: {
  seed: CandidateShipmentSeed;
  rows: WorkItemRow[];
  allocations: AllocationRow[];
  rawOrder: RawOrderRow | null;
  mappingByVendorItemId: Map<string, MappingRow>;
  pendingWriteRequestCount: number;
  returnConflictAllocationIds: Set<number>;
}) {
  const reasons = new Set<CoupangOrderRematchExclusionCode>();
  const relevantRows = input.rows.filter(
    (row) => row.canceled !== 1 && row.matchable_quantity > 0
  );
  const activeAllocations = input.allocations.filter((allocation) =>
    (ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES as readonly string[]).includes(
      allocation.allocation_status
    )
  );
  const relevantItemKeys = new Set(relevantRows.map(itemKey));
  const activeAllocationsByItemKey = new Map<string, AllocationRow[]>();

  for (const allocation of activeAllocations) {
    const key = itemKey(allocation);
    const current = activeAllocationsByItemKey.get(key) ?? [];
    current.push(allocation);
    activeAllocationsByItemKey.set(key, current);

    if (!relevantItemKeys.has(key)) {
      addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.snapshotInconsistent);
    }
  }

  if (
    relevantRows.length === 0 ||
    relevantRows.some(
      (row) => row.work_status !== INVENTORY_MATCH_STATUSES.matched
    )
  ) {
    addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.shipmentNotFullyMatched);
  }

  for (const row of relevantRows) {
    const mapping = input.mappingByVendorItemId.get(row.external_vendor_item_id);
    const itemAllocations = activeAllocationsByItemKey.get(itemKey(row)) ?? [];

    if (
      !mapping ||
      mapping.mapping_status !== "MAPPED" ||
      !mapping.sales_offer_id ||
      !mapping.sales_offer ||
      mapping.sales_offer.is_active !== 1
    ) {
      addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.currentMappingUnavailable);
    }

    if (itemAllocations.length !== row.matchable_quantity) {
      addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.allocationQuantityMismatch);
    }

    if (
      row.mapping_status !== "MAPPED" ||
      !row.sales_offer_id ||
      !row.sales_offer ||
      itemAllocations.some(
        (allocation) => allocation.sales_offer_id !== row.sales_offer_id
      )
    ) {
      addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.snapshotInconsistent);
    }
  }

  if (
    activeAllocations.some(
      (allocation) =>
        !REVERSIBLE_ALLOCATION_STATUSES.has(allocation.allocation_status)
    )
  ) {
    addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.allocationNotReversible);
  }

  if (
    activeAllocations.some(
      (allocation) =>
        allocation.device.inventory?.inventory_status !== INVENTORY_STATUS.reserved
    )
  ) {
    addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.inventoryNotReserved);
  }

  const hasActivePrintBatch = input.allocations.some(
    (allocation) =>
      Boolean(
        allocation.shipment_list_printed_at ||
          allocation.shipment_list_print_batch_id
      ) ||
      allocation.shipment_list_print_batch_items.some(
        (item) => item.batch.batch_status !== "CANCELED"
      )
  );
  const hasActivePackageGroup = input.allocations.some((allocation) =>
    allocation.package_group_members.some(
      (member) =>
        !TERMINAL_PACKAGE_GROUP_STATUSES.has(member.package_group.group_status)
    )
  );

  if (hasActivePrintBatch || hasActivePackageGroup) {
    addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.outboundHandoffStarted);
  }

  if (input.pendingWriteRequestCount > 0) {
    addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.writeRequestPending);
  }

  if (
    input.allocations.some(
      (allocation) =>
        allocation.coupang_return_allocations.length > 0 ||
        input.returnConflictAllocationIds.has(allocation.allocation_id)
    )
  ) {
    addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.returnFlowExists);
  }

  if (input.allocations.some((allocation) => allocation.sales_records)) {
    addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.salesRecordExists);
  }

  if (
    !input.rawOrder ||
    !REVERSIBLE_ORDER_STATUSES.has(input.rawOrder.external_order_status ?? "")
  ) {
    addReason(reasons, COUPANG_ORDER_REMATCH_EXCLUSION.orderStatusNotReversible);
  }

  const first = input.rows[0];
  const items = relevantRows
    .sort((left, right) => left.work_item_id - right.work_item_id)
    .map((row) => {
      const mapping = input.mappingByVendorItemId.get(row.external_vendor_item_id);
      const allocations = activeAllocationsByItemKey.get(itemKey(row)) ?? [];

      return {
        workItemId: row.work_item_id,
        externalVendorItemId: row.external_vendor_item_id,
        vendorItemName: row.vendor_item_name,
        orderedQuantity: row.ordered_quantity,
        matchableQuantity: row.matchable_quantity,
        matchedOffer: workItemOfferPreview(row),
        currentDefaultOffer: offerPreview(mapping?.sales_offer),
        allocations: allocations
          .sort((left, right) => left.allocation_id - right.allocation_id)
          .map(allocationPreview),
      };
    });

  return {
    firstWorkItemId: input.seed.firstWorkItemId,
    externalOrderId: first.external_order_id,
    externalShipmentId: first.external_shipment_id,
    externalOrderStatus: input.rawOrder?.external_order_status ?? null,
    eligible: reasons.size === 0,
    exclusionReasons: Array.from(reasons).map(reasonDto),
    itemCount: items.length,
    allocationCount: activeAllocations.length,
    items,
  };
}

type EvaluatedShipment = ReturnType<typeof evaluateShipment>;

function manifestShipment(shipment: EvaluatedShipment) {
  return {
    firstWorkItemId: shipment.firstWorkItemId,
    externalOrderId: shipment.externalOrderId,
    externalShipmentId: shipment.externalShipmentId,
    externalOrderStatus: shipment.externalOrderStatus,
    items: shipment.items.map((item) => ({
      workItemId: item.workItemId,
      externalVendorItemId: item.externalVendorItemId,
      orderedQuantity: item.orderedQuantity,
      matchableQuantity: item.matchableQuantity,
      matchedOffer: item.matchedOffer,
      currentDefaultOffer: item.currentDefaultOffer,
      allocations: item.allocations.map((allocation) => ({
        allocationId: allocation.allocationId,
        pgNo: allocation.pgNo,
        salesOfferId: allocation.salesOfferId,
        allocationStatus: allocation.allocationStatus,
        inventoryStatus: allocation.inventoryStatus,
      })),
    })),
  };
}

function isOutsideCurrentRematchWindow(shipment: EvaluatedShipment) {
  const reasonCodes = new Set(
    shipment.exclusionReasons.map((reason) => reason.code)
  );

  return [
    COUPANG_ORDER_REMATCH_EXCLUSION.outboundHandoffStarted,
    COUPANG_ORDER_REMATCH_EXCLUSION.returnFlowExists,
    COUPANG_ORDER_REMATCH_EXCLUSION.salesRecordExists,
    COUPANG_ORDER_REMATCH_EXCLUSION.orderStatusNotReversible,
  ].some((reason) => reasonCodes.has(reason));
}

async function listCandidateShipmentSeedBatch(
  client: Prisma.TransactionClient,
  afterFirstWorkItemId: number
) {
  // Keep completed history outside the expensive eligibility scan. The service
  // evaluator repeats these guards so a state change between both reads is safe.
  const rows = await client.$queryRaw<RawCandidateShipmentSeed[]>(Prisma.sql`
    SELECT
      MIN(work.work_item_id) AS first_work_item_id,
      work.external_order_id,
      work.external_shipment_id
    FROM order_matching_work_queue AS work
    INNER JOIN coupang_order_raw AS raw_order
      ON raw_order.external_order_id = work.external_order_id
      AND raw_order.external_shipment_id = work.external_shipment_id
    WHERE work.channel = ${COUPANG_CHANNEL}
      AND work.work_status = ${INVENTORY_MATCH_STATUSES.matched}
      AND raw_order.external_order_status IN ('ACCEPT', 'INSTRUCT')
      AND NOT EXISTS (
        SELECT 1
        FROM match_worker_allocation AS allocation
        INNER JOIN sales_records AS sale
          ON sale.allocation_id = allocation.allocation_id
        WHERE allocation.external_order_id = work.external_order_id
          AND allocation.external_shipment_id = work.external_shipment_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM match_worker_allocation AS allocation
        WHERE allocation.external_order_id = work.external_order_id
          AND allocation.external_shipment_id = work.external_shipment_id
          AND (
            allocation.shipment_list_printed_at IS NOT NULL
            OR allocation.shipment_list_print_batch_id IS NOT NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM match_worker_allocation AS allocation
        INNER JOIN sales_channel_shipment_list_print_batch_items AS print_item
          ON print_item.allocation_id = allocation.allocation_id
        INNER JOIN sales_channel_shipment_list_print_batches AS print_batch
          ON print_batch.shipment_list_print_batch_id = print_item.shipment_list_print_batch_id
        WHERE allocation.external_order_id = work.external_order_id
          AND allocation.external_shipment_id = work.external_shipment_id
          AND print_batch.batch_status <> 'CANCELED'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM match_worker_allocation AS allocation
        INNER JOIN shipment_package_group_members AS package_member
          ON package_member.allocation_id = allocation.allocation_id
          AND package_member.removed_at IS NULL
        INNER JOIN shipment_package_groups AS package_group
          ON package_group.package_group_id = package_member.package_group_id
        WHERE allocation.external_order_id = work.external_order_id
          AND allocation.external_shipment_id = work.external_shipment_id
          AND package_group.group_status NOT IN ('CANCELED', 'INVALIDATED', 'SPLIT')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM match_worker_allocation AS allocation
        INNER JOIN coupang_return_allocation AS return_allocation
          ON return_allocation.allocation_id = allocation.allocation_id
        WHERE allocation.external_order_id = work.external_order_id
          AND allocation.external_shipment_id = work.external_shipment_id
      )
    GROUP BY work.external_order_id, work.external_shipment_id
    HAVING MIN(work.work_item_id) > ${afterFirstWorkItemId}
    ORDER BY MIN(work.work_item_id) ASC
    LIMIT ${CANDIDATE_SCAN_BATCH_SIZE}
  `);

  return rows.map(
    (row): CandidateShipmentSeed => ({
      firstWorkItemId: Number(row.first_work_item_id),
      external_order_id: row.external_order_id,
      external_shipment_id: row.external_shipment_id,
    })
  );
}

async function evaluateCandidateShipmentBatch(
  client: Prisma.TransactionClient,
  seeds: CandidateShipmentSeed[]
) {
  if (seeds.length === 0) return [];

  const shipmentKeys = seeds.map((seed) => ({
    external_order_id: seed.external_order_id,
    external_shipment_id: seed.external_shipment_id,
  }));
  const where = { OR: shipmentKeys };
  const [workRows, allocations, rawOrders, pendingWriteTargets] =
    await Promise.all([
      client.order_matching_work_queue.findMany({
        where: { channel: COUPANG_CHANNEL, ...where },
        include: workItemInclude,
        orderBy: { work_item_id: "asc" },
      }),
      client.match_worker_allocation.findMany({
        where,
        include: allocationInclude,
        orderBy: { allocation_id: "asc" },
      }),
      client.coupang_order_raw.findMany({
        where,
        select: {
          external_order_id: true,
          external_shipment_id: true,
          external_order_status: true,
        },
      }),
      client.sales_channel_write_request_targets.findMany({
        where: {
          ...where,
          write_request: {
            channel: COUPANG_CHANNEL,
            request_status: { in: [...IN_FLIGHT_WRITE_STATUSES] },
          },
        },
        select: {
          external_order_id: true,
          external_shipment_id: true,
        },
      }),
    ]);
  const vendorItemIds = Array.from(
    new Set(workRows.map((row) => row.external_vendor_item_id))
  );
  const mappings: MappingRow[] = [];

  for (const batch of chunks(vendorItemIds, 400)) {
    mappings.push(
      ...(await client.sales_channel_product_mappings.findMany({
        where: {
          channel: COUPANG_CHANNEL,
          external_vendor_item_id: { in: batch },
        },
        include: mappingInclude,
      }))
    );
  }

  const returnConflictAllocationIds = new Set<number>();

  for (const batch of chunks(
    allocations.map((allocation) => allocation.allocation_id),
    400
  )) {
    const conflicts = await findShipmentReturnConflicts(client, batch);

    for (const conflict of conflicts) {
      conflict.allocationIds.forEach((allocationId) =>
        returnConflictAllocationIds.add(allocationId)
      );
    }
  }

  const workRowsByShipment = new Map<string, WorkItemRow[]>();
  const allocationsByShipment = new Map<string, AllocationRow[]>();
  const rawOrderByShipment = new Map<string, RawOrderRow>();
  const pendingWriteCountByShipment = new Map<string, number>();
  const mappingByVendorItemId = new Map(
    mappings.map((mapping) => [mapping.external_vendor_item_id, mapping])
  );

  for (const row of workRows) {
    const key = shipmentKey(row);
    const current = workRowsByShipment.get(key) ?? [];
    current.push(row);
    workRowsByShipment.set(key, current);
  }

  for (const allocation of allocations) {
    const key = shipmentKey(allocation);
    const current = allocationsByShipment.get(key) ?? [];
    current.push(allocation);
    allocationsByShipment.set(key, current);
  }

  for (const rawOrder of rawOrders) {
    rawOrderByShipment.set(shipmentKey(rawOrder), rawOrder);
  }

  for (const target of pendingWriteTargets) {
    if (!target.external_order_id || !target.external_shipment_id) continue;

    const key = shipmentKey({
      external_order_id: target.external_order_id,
      external_shipment_id: target.external_shipment_id,
    });
    pendingWriteCountByShipment.set(
      key,
      (pendingWriteCountByShipment.get(key) ?? 0) + 1
    );
  }

  return seeds
    .map((seed) => {
      const key = shipmentKey(seed);
      const rows = workRowsByShipment.get(key) ?? [];

      return rows.length > 0
        ? evaluateShipment({
            seed,
            rows,
            allocations: allocationsByShipment.get(key) ?? [],
            rawOrder: rawOrderByShipment.get(key) ?? null,
            mappingByVendorItemId,
            pendingWriteRequestCount:
              pendingWriteCountByShipment.get(key) ?? 0,
            returnConflictAllocationIds,
          })
        : null;
    })
    .filter((item): item is EvaluatedShipment => item !== null)
    .sort((left, right) => left.firstWorkItemId - right.firstWorkItemId);
}

export async function listCoupangOrderRematchPreview(
  input: {
    cursor?: unknown;
    limit?: unknown;
    unpaginated?: boolean;
  } = {},
  client: Prisma.TransactionClient = prisma
) {
  const cursor = optionalPositiveInt(input.cursor);
  const limit = positiveInt(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const manifest = createHash("sha256");
  const page: EvaluatedShipment[] = [];
  const reasonCounts = new Map<CoupangOrderRematchExclusionCode, number>();
  let manifestItemCount = 0;
  let candidateShipmentCount = 0;
  let eligibleShipmentCount = 0;
  let eligibleWorkItemCount = 0;
  let eligibleAllocationCount = 0;
  let hasMore = false;
  let scanCursor = 0;

  // The exact eligible target manifest stays global, while candidate details
  // are evaluated in bounded DB batches and only the requested page is retained.
  manifest.update("[");

  while (true) {
    const seeds = await listCandidateShipmentSeedBatch(client, scanCursor);

    if (seeds.length === 0) break;

    const evaluatedBatch = await evaluateCandidateShipmentBatch(client, seeds);

    for (const shipment of evaluatedBatch) {
      if (isOutsideCurrentRematchWindow(shipment)) continue;

      candidateShipmentCount += 1;

      if (shipment.eligible) {
        if (manifestItemCount > 0) manifest.update(",");
        manifest.update(JSON.stringify(manifestShipment(shipment)));
        manifestItemCount += 1;
        eligibleShipmentCount += 1;
        eligibleWorkItemCount += shipment.itemCount;
        eligibleAllocationCount += shipment.allocationCount;
      } else {
        for (const reason of shipment.exclusionReasons) {
          reasonCounts.set(
            reason.code,
            (reasonCounts.get(reason.code) ?? 0) + 1
          );
        }
      }

      if (cursor && shipment.firstWorkItemId <= cursor) continue;

      if (input.unpaginated || page.length < limit) {
        page.push(shipment);
      } else {
        hasMore = true;
      }
    }

    scanCursor = seeds.at(-1)?.firstWorkItemId ?? scanCursor;

    if (seeds.length < CANDIDATE_SCAN_BATCH_SIZE) break;
  }

  manifest.update("]");

  return {
    generatedAt: nowKstSqlDateTime(),
    manifestToken: manifest.digest("hex"),
    cursor,
    nextCursor:
      !input.unpaginated && hasMore
        ? page.at(-1)?.firstWorkItemId ?? null
        : null,
    hasMore: !input.unpaginated && hasMore,
    summary: {
      candidateShipmentCount,
      eligibleShipmentCount,
      excludedShipmentCount:
        candidateShipmentCount - eligibleShipmentCount,
      eligibleWorkItemCount,
      eligibleAllocationCount,
      exclusionReasonCounts: Array.from(reasonCounts.entries()).map(
        ([code, count]) => ({ ...reasonDto(code), count })
      ),
    },
    items: page,
  };
}
