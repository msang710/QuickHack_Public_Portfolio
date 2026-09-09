import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import {
  completeDomainOperationKey,
  digestDomainOperation,
  reserveDomainOperationKey,
  runRetriableMeasuredTransaction,
} from "@/quickhack_server/core/database/aggregate-command";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  lockInventoryQuantityBalanceKeys,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import { canAccessRole, type AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_TRANSITION_POLICY } from "@/quickhack_shared/inventory/inventory-write-rules";
import { ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES } from "@/quickhack_shared/sales-channel/order-matching";
import { runWorkerJobWithExecutor } from "@/quickhack_server/workers/worker-jobs";
import { ORDER_MATCHING_WORKER_KEY } from "@/quickhack_server/workers/worker-keys";
import { lockDeviceAggregates } from "@/quickhack_server/inventory/device-aggregate-lock";
import { normalizePgNo, requireCanonicalPgNo } from "@/quickhack_shared/inventory/pg-no";
import { isExpectedPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import { findShipmentReturnConflicts } from "@/quickhack_server/returns/shipment-return-conflict-service";
import { readManualOrderMatchShipmentSafety } from "@/quickhack_server/sales-channel/coupang/manual-order-match-shipment-safety";
import {
  acquireManualOrderMatchIntent,
  assertManualOrderMatchIntentActive,
  MANUAL_ORDER_MATCH_INTENT_RENEW_MS,
  releaseManualOrderMatchIntent,
  renewManualOrderMatchIntent,
} from "@/quickhack_server/sales-channel/coupang/manual-order-match-intent-service";

const REVERSIBLE = ["ALLOCATED", "API_ACKED"] as const;
const REQUEST_CHANNELS = ["COUPANG_INQUIRY", "PHONE", "OTHER"] as const;
const SELECTION_RECEIPT_TTL_MS = 5 * 60 * 1000;
type RequestChannel = (typeof REQUEST_CHANNELS)[number];
type Operation = "ASSIGN" | "REPLACE" | "RELEASE";
type ManualOrderMatchPostCycleResult =
  | { status: "COMPLETED"; result: unknown }
  | {
      status: "PENDING";
      reasonCode:
        | "ORDER_MATCHING_WORKER_BUSY"
        | "IDEMPOTENT_REPLAY_REQUIRES_RECOVERY_CHECK";
    }
  | {
      status: "FAILED";
      reasonCode: "ORDER_MATCHING_POST_CYCLE_FAILED";
    };
type ManualOrderMatchDependencies = {
  sensitiveActionVerified?: boolean;
  runPostCycle?: (input: {
    externalOrderId: string;
    externalShipmentId: string;
    user: AuthUser;
  }) => Promise<ManualOrderMatchPostCycleResult>;
  afterIntentAcquire?: (input: { leaseId: string }) => Promise<void>;
};

function requiredInteger(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw publicBadRequest("MANUAL_ORDER_MATCH_INPUT_INVALID", "MANUAL_ORDER_MATCH_INPUT_INVALID");
  }
  return parsed;
}

function requiredText(value: unknown, label: string, max = 500) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) {
    throw publicBadRequest("MANUAL_ORDER_MATCH_INPUT_INVALID", "MANUAL_ORDER_MATCH_INPUT_INVALID");
  }
  return text;
}

function requestChannel(value: unknown): RequestChannel {
  const channel = String(value ?? "").trim() as RequestChannel;
  if (!REQUEST_CHANNELS.includes(channel)) {
    throw publicBadRequest("MANUAL_ORDER_MATCH_REQUEST_CHANNEL_INVALID", "MANUAL_ORDER_MATCH_REQUEST_CHANNEL_INVALID");
  }
  return channel;
}

function operation(value: unknown): Operation {
  const result = String(value ?? "").trim().toUpperCase() as Operation;
  if (!["ASSIGN", "REPLACE", "RELEASE"].includes(result)) {
    throw publicBadRequest("MANUAL_ORDER_MATCH_OPERATION_INVALID", "MANUAL_ORDER_MATCH_OPERATION_INVALID");
  }
  return result;
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function candidateFingerprint(device: Awaited<ReturnType<typeof candidate>>) {
  if (!device) return null;
  return {
    pgNo: normalizePgNo(device.pg_no),
    deviceId: device.device_id,
    deviceRevision: device.revision,
    inventoryId: device.inventory?.inventory_id ?? null,
    inventoryRevision: device.inventory?.revision ?? null,
    inventoryStatus: device.inventory?.inventory_status ?? null,
    inventorySkuId: device.inventory_sku_id,
    model: device.model,
    storage: device.storage,
    color: device.color,
    saleGrade: device.sale_grade,
    warranty: device.warranty,
    activeAllocationIds: device.match_worker_allocations
      .map((item) => item.allocation_id)
      .sort((left, right) => left - right),
  };
}

export function assertManualOrderMatchReadEnabled() {
  if (!runtimeConfigService.read().policies.manualOrderMatchReadEnabled) {
    throw publicConflict(
      "MANUAL_ORDER_MATCH_READ_DISABLED",
      "MANUAL_ORDER_MATCH_READ_DISABLED"
    );
  }
}

export function assertManualOrderMatchMutationEnabled() {
  if (!runtimeConfigService.read().policies.manualOrderMatchMutationEnabled) {
    throw publicConflict(
      "MANUAL_ORDER_MATCH_MUTATION_DISABLED",
      "MANUAL_ORDER_MATCH_MUTATION_DISABLED"
    );
  }
}

async function validSelectionReceipt(input: {
  tx: Prisma.TransactionClient;
  receiptId: unknown;
  workItemId: number;
  operation: Operation;
  pgNo: string | null;
  userId: number;
  workRevision: number;
  device: Awaited<ReturnType<typeof candidate>>;
}) {
  if (!input.pgNo || input.operation === "RELEASE") return false;
  const receiptId = String(input.receiptId ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receiptId)) return false;
  const receipt = await input.tx.manual_order_match_selection_receipts.findUnique({
    where: { receipt_id: receiptId },
  });
  return Boolean(
    receipt &&
      receipt.consumed_at === null &&
      receipt.expires_at.getTime() > databaseNow().getTime() &&
      receipt.work_item_id === input.workItemId &&
      receipt.operation === input.operation &&
      receipt.pg_no === input.pgNo &&
      receipt.issued_to_user_id === input.userId &&
      receipt.work_revision === input.workRevision &&
      receipt.candidate_fingerprint_hash === hash(candidateFingerprint(input.device))
  );
}

async function allocationsForWorkItem(tx: Prisma.TransactionClient, item: {
  external_order_id: string;
  external_shipment_id: string;
  external_vendor_item_id: string;
}) {
  return tx.match_worker_allocation.findMany({
    where: {
      external_order_id: item.external_order_id,
      external_shipment_id: item.external_shipment_id,
      external_vendor_item_id: item.external_vendor_item_id,
      allocation_status: { in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES] },
    },
    include: {
      device: { include: { inventory: true } },
      package_group_members: {
        where: { removed_at: null },
        include: { package_group: { select: { group_status: true } } },
      },
      sales_records: { select: { sale_record_id: true } },
      coupang_return_allocations: { select: { coupang_return_allocation_id: true } },
      write_requests: { select: { request_status: true } },
    },
    orderBy: { allocation_id: "asc" },
  });
}

async function allocationsForShipment(
  tx: Prisma.TransactionClient,
  item: { external_order_id: string; external_shipment_id: string }
) {
  return tx.match_worker_allocation.findMany({
    where: {
      external_order_id: item.external_order_id,
      external_shipment_id: item.external_shipment_id,
      allocation_status: { in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES] },
    },
    include: {
      device: { include: { inventory: true } },
      package_group_members: {
        where: { removed_at: null },
        include: { package_group: { select: { group_status: true } } },
      },
      sales_records: { select: { sale_record_id: true } },
      coupang_return_allocations: { select: { coupang_return_allocation_id: true } },
      write_requests: { select: { request_status: true } },
    },
    orderBy: { allocation_id: "asc" },
  });
}

function downstreamReasons(allocation: Awaited<ReturnType<typeof allocationsForWorkItem>>[number]) {
  const reasons: string[] = [];
  if (!REVERSIBLE.includes(allocation.allocation_status as (typeof REVERSIBLE)[number])) reasons.push("ALLOCATION_NOT_REVERSIBLE");
  if (allocation.shipment_list_printed_at || allocation.shipment_list_print_batch_id) reasons.push("SHIPMENT_LIST_PRINTED");
  if (allocation.package_group_members.some((m) => !["INVALIDATED", "CANCELED"].includes(m.package_group.group_status))) reasons.push("ACTIVE_PACKAGE_GROUP");
  if (allocation.sales_records) reasons.push("SALES_RECORDED");
  if (allocation.coupang_return_allocations.length) reasons.push("RETURN_STARTED");
  if (allocation.write_requests.some((r) => ["PENDING", "PROCESSING", "UNKNOWN"].includes(r.request_status))) reasons.push("CHANNEL_WRITE_PENDING");
  return reasons;
}

async function candidate(tx: Prisma.TransactionClient, pgNo: string | null) {
  if (!pgNo) return null;
  return tx.devices.findUnique({
    where: { pg_no: pgNo },
    include: {
      inventory: true,
      inventory_sku: true,
      match_worker_allocations: {
        where: { allocation_status: { in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES] } },
        select: { allocation_id: true },
      },
    },
  });
}

export async function listManualOrderMatchCandidates(input: {
  search?: string | null;
  limit?: number | null;
  workItemId: number;
  operation: Operation;
}, user: AuthUser) {
  assertManualOrderMatchReadEnabled();
  const workItemId = requiredInteger(input.workItemId, "workItemId");
  const selectedOperation = operation(input.operation);
  if (selectedOperation === "RELEASE") {
    throw publicBadRequest(
      "MANUAL_ORDER_MATCH_OPERATION_INVALID",
      "MANUAL_ORDER_MATCH_OPERATION_INVALID"
    );
  }
  const work = await prisma.order_matching_work_queue.findUnique({
    where: { work_item_id: workItemId },
    select: { revision: true, channel: true },
  });
  if (!work || work.channel !== "COUPANG") {
    throw publicNotFound("CHANNEL_ORDER_REQUIRED", "CHANNEL_ORDER_REQUIRED");
  }
  const search = String(input.search ?? "").trim();
  const limit = Math.max(1, Math.min(80, Number(input.limit ?? 40) || 40));
  if (!search) return { items: [] };
  const devices = await prisma.devices.findMany({
    where: {
      inventory: { is: { inventory_status: INVENTORY_STATUS.sellable } },
      match_worker_allocations: {
        none: {
          allocation_status: {
            in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
          },
        },
      },
      ...(search
        ? {
            OR: [
              { pg_no: { contains: search, mode: "insensitive" as const } },
              { model: { contains: search, mode: "insensitive" as const } },
              { storage: { contains: search, mode: "insensitive" as const } },
              { color: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    include: {
      inventory: true,
      inventory_sku: true,
      match_worker_allocations: {
        where: { allocation_status: { in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES] } },
        select: { allocation_id: true },
      },
    },
    orderBy: [{ updated_at: "desc" }, { pg_no: "asc" }],
    take: limit,
  });

  const issuedAt = databaseNow();
  const expiresAt = new Date(issuedAt.getTime() + SELECTION_RECEIPT_TTL_MS);
  const items = await Promise.all(devices.map(async (device) => {
    const receipt = await prisma.manual_order_match_selection_receipts.create({
      data: {
        work_item_id: workItemId,
        operation: selectedOperation,
        pg_no: requireCanonicalPgNo(device.pg_no),
        candidate_fingerprint_hash: hash(candidateFingerprint(device)),
        issued_to_user_id: user.userId,
        work_revision: work.revision,
        inventory_revision: device.inventory?.revision ?? null,
        issued_at: issuedAt,
        expires_at: expiresAt,
      },
      select: { receipt_id: true },
    });
    return {
      pgNo: device.pg_no,
      model: device.model,
      storage: device.storage,
      color: device.color,
      saleGrade: device.sale_grade,
      warranty: device.warranty,
      inventoryStatus: device.inventory?.inventory_status ?? null,
      revision: device.inventory?.revision ?? null,
      selectionReceiptId: receipt.receipt_id,
    };
  }));
  return { items };
}

function candidateDto(device: Awaited<ReturnType<typeof candidate>>, item: { required_model_label: string | null; required_storage_label: string | null; required_color_label: string | null; required_warranty_group: string | null }) {
  if (!device) return null;
  const differences = [
    ["MODEL", item.required_model_label, device.model],
    ["STORAGE", item.required_storage_label, device.storage],
    ["COLOR", item.required_color_label, device.color],
    ["WARRANTY", item.required_warranty_group, device.warranty],
  ].filter(([, required, actual]) => required && String(required) !== String(actual ?? "")).map(([field, required, actual]) => ({ field, required, actual: actual ?? "미확인" }));
  const eligible = device.inventory?.inventory_status === INVENTORY_STATUS.sellable && device.match_worker_allocations.length === 0;
  const reasonCodes = [];
  if (device.inventory?.inventory_status !== INVENTORY_STATUS.sellable) reasonCodes.push("PG_NOT_SELLABLE");
  if (device.match_worker_allocations.length > 0) reasonCodes.push("PG_ALREADY_ALLOCATED");
  return {
    pgNo: device.pg_no,
    revision: device.inventory?.revision ?? null,
    inventoryStatus: device.inventory?.inventory_status ?? null,
    model: device.model,
    storage: device.storage,
    color: device.color,
    saleGrade: device.sale_grade,
    warranty: device.warranty,
    inventorySkuId: device.inventory_sku_id,
    eligible,
    reasonCodes,
    differences,
  };
}

export async function listManualOrderMatches(input: { search?: string | null; limit?: number | null } = {}) {
  assertManualOrderMatchReadEnabled();
  const search = String(input.search ?? "").trim();
  const limit = Math.max(1, Math.min(100, Number(input.limit ?? 50) || 50));
  const items = await prisma.order_matching_work_queue.findMany({
    where: {
      channel: "COUPANG",
      ...(search ? { OR: [
        { external_order_id: { contains: search, mode: "insensitive" as const } },
        { external_shipment_id: { contains: search, mode: "insensitive" as const } },
        { external_vendor_item_id: { contains: search, mode: "insensitive" as const } },
        { vendor_item_name: { contains: search, mode: "insensitive" as const } },
      ] } : {}),
    },
    orderBy: [{ ordered_at: "desc" }, { work_item_id: "desc" }],
    take: limit,
  });
  const result = await Promise.all(items.map(async (item) => {
    const allocations = await allocationsForWorkItem(prisma, item);
    return {
      workItemId: item.work_item_id,
      revision: item.revision,
      channel: item.channel,
      externalOrderId: item.external_order_id,
      externalShipmentId: item.external_shipment_id,
      externalVendorItemId: item.external_vendor_item_id,
      itemName: item.vendor_item_name ?? item.seller_product_item_name,
      matchableQuantity: item.matchable_quantity,
      workStatus: item.work_status,
      recoveryStatus: item.manual_recovery_status,
      recoveryReason: item.work_failure_reason,
      allocations: allocations.map((a) => ({ allocationId: a.allocation_id, pgNo: a.pg_no, status: a.allocation_status, reasonCodes: downstreamReasons(a) })),
    };
  }));
  return {
    items: result,
    capabilities: {
      mutationEnabled:
        runtimeConfigService.read().policies.manualOrderMatchMutationEnabled,
    },
  };
}

export async function previewManualOrderMatch(
  raw: Record<string, unknown>,
  user: AuthUser,
  tx: Prisma.TransactionClient = prisma
) {
  assertManualOrderMatchReadEnabled();
  const workItemId = requiredInteger(raw.workItemId, "workItemId");
  const selectedOperation = operation(raw.operation);
  const allocationId = raw.allocationId == null ? null : requiredInteger(raw.allocationId, "allocationId");
  const pgNo = selectedOperation === "RELEASE" ? null : normalizePgNo(requiredText(raw.pgNo, "PG", 80));
  const channel = requestChannel(raw.requestChannel);
  const reason = requiredText(raw.reason, "변경 사유", 500);
  if (reason.length < 2) throw publicBadRequest("MANUAL_ORDER_MATCH_REASON_INVALID", "MANUAL_ORDER_MATCH_REASON_INVALID");

  const item = await tx.order_matching_work_queue.findUnique({ where: { work_item_id: workItemId } });
  if (!item || item.channel !== "COUPANG") throw publicNotFound("CHANNEL_ORDER_REQUIRED", "CHANNEL_ORDER_REQUIRED");
  const allocations = await allocationsForWorkItem(tx, item);
  const shipmentAllocations = await allocationsForShipment(tx, item);
  const [pendingShipmentWriteTargets, shipmentReturnConflicts, shipmentSafety] = await Promise.all([
    tx.sales_channel_write_request_targets.findMany({
      where: {
        external_order_id: item.external_order_id,
        external_shipment_id: item.external_shipment_id,
        write_request: {
          channel: "COUPANG",
          request_status: { in: ["PENDING", "PROCESSING", "UNKNOWN"] },
        },
      },
      select: { sales_channel_write_request_target_id: true },
      orderBy: { sales_channel_write_request_target_id: "asc" },
    }),
    findShipmentReturnConflicts(tx, shipmentAllocations.map((allocation) => allocation.allocation_id)),
    readManualOrderMatchShipmentSafety(tx, {
      externalOrderId: item.external_order_id,
      externalShipmentId: item.external_shipment_id,
      allocationIds: shipmentAllocations.map((allocation) => allocation.allocation_id),
    }),
  ]);
  const shipmentWorkItems = await tx.order_matching_work_queue.findMany({
    where: {
      channel: item.channel,
      external_order_id: item.external_order_id,
      external_shipment_id: item.external_shipment_id,
    },
    select: {
      work_item_id: true,
      revision: true,
      canceled: true,
      matchable_quantity: true,
      work_status: true,
      manual_recovery_status: true,
    },
    orderBy: { work_item_id: "asc" },
  });
  const rawOrder = await tx.coupang_order_raw.findUnique({
    where: { external_order_id_external_shipment_id: { external_order_id: item.external_order_id, external_shipment_id: item.external_shipment_id } },
    select: { external_order_status: true },
  });
  const current = allocationId ? allocations.find((a) => a.allocation_id === allocationId) ?? null : null;
  const target = await candidate(tx, pgNo);
  const targetDto = candidateDto(target, item);
  const reasonCodes: string[] = [];
  if (selectedOperation === "ASSIGN" && allocationId !== null) reasonCodes.push("MANUAL_ORDER_MATCH_OPERATION_INVALID");
  if (!rawOrder || !["ACCEPT", "INSTRUCT"].includes(rawOrder.external_order_status ?? "")) reasonCodes.push("ORDER_STATE_NOT_ELIGIBLE");
  if (item.canceled === 1 && selectedOperation !== "RELEASE") reasonCodes.push("ORDER_ITEM_CANCELED");
  if ((selectedOperation === "REPLACE" || selectedOperation === "RELEASE") && !current) reasonCodes.push("ALLOCATION_NOT_FOUND");
  if (current) reasonCodes.push(...downstreamReasons(current));
  const shipmentDownstreamReasons = shipmentAllocations.flatMap(downstreamReasons);
  if (shipmentDownstreamReasons.length > 0) {
    reasonCodes.push(...shipmentDownstreamReasons);
  }
  if (pendingShipmentWriteTargets.length > 0) reasonCodes.push("CHANNEL_WRITE_PENDING");
  if (shipmentReturnConflicts.length > 0) reasonCodes.push("RETURN_STARTED");
  reasonCodes.push(...shipmentSafety.blockerCodes);
  if (selectedOperation === "ASSIGN" && allocations.length >= item.matchable_quantity) reasonCodes.push("MATCH_QUANTITY_CONFLICT");
  if (selectedOperation !== "RELEASE" && !target) reasonCodes.push("PG_NOT_FOUND");
  if (
    target &&
    !(await validSelectionReceipt({
      tx,
      receiptId: raw.selectionReceiptId,
      workItemId,
      operation: selectedOperation,
      pgNo,
      userId: user.userId,
      workRevision: item.revision,
      device: target,
    }))
  ) reasonCodes.push("PG_SELECTION_REQUIRED");
  if (targetDto && !targetDto.eligible) reasonCodes.push(...targetDto.reasonCodes);
  if (pgNo && allocations.some((a) => a.pg_no === pgNo && a.allocation_id !== allocationId)) reasonCodes.push("PG_ALREADY_ALLOCATED");
  const snapshot = {
    workItemId,
    workRevision: item.revision,
    operation: selectedOperation,
    allocationId,
    allocationStatus: current?.allocation_status ?? null,
    previousPgNo: current?.pg_no ?? null,
    pgNo,
    pgRevision: targetDto?.revision ?? null,
    candidateFingerprint: candidateFingerprint(target),
    selectionReceiptId: selectedOperation === "RELEASE" ? null : String(raw.selectionReceiptId ?? "").trim(),
    rawOrderStatus: rawOrder?.external_order_status ?? null,
    pendingShipmentWriteTargetIds: pendingShipmentWriteTargets.map((target) => target.sales_channel_write_request_target_id),
    returnConflictAllocationIds: shipmentReturnConflicts.flatMap((conflict) => conflict.allocationIds).sort((left, right) => left - right),
    shipmentSafety,
    requestChannel: channel,
    reason,
    activeAllocationIds: allocations.map((a) => a.allocation_id),
    shipmentWorkItems,
    shipmentAllocations: shipmentAllocations.map((allocation) => ({
      allocationId: allocation.allocation_id,
      pgNo: allocation.pg_no,
      status: allocation.allocation_status,
      reasonCodes: downstreamReasons(allocation),
    })),
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
  return {
    eligible: snapshot.reasonCodes.length === 0,
    reasonCodes: snapshot.reasonCodes,
    manifestToken: hash(snapshot),
    snapshot,
    item: { externalOrderId: item.external_order_id, externalShipmentId: item.external_shipment_id, itemName: item.vendor_item_name ?? item.seller_product_item_name, matchableQuantity: item.matchable_quantity, workStatus: item.work_status },
    currentAllocation: current ? { allocationId: current.allocation_id, pgNo: current.pg_no, status: current.allocation_status, inventorySkuId: current.inventory_sku_id } : null,
    candidate: targetDto,
  };
}

function nextWorkStatus(required: number, active: number) {
  if (active <= 0) return "UNMATCHED";
  if (active < required) return "PARTIAL";
  return "MATCHED";
}

async function runManualOrderMatchPostCycle(input: {
  externalOrderId: string;
  externalShipmentId: string;
  user: AuthUser;
}): Promise<ManualOrderMatchPostCycleResult> {
  try {
    const workerResult = await runWorkerJobWithExecutor(
      ORDER_MATCHING_WORKER_KEY,
      input.user,
      async (context) => {
        const { runCoupangMatchingPostCycleForShipment } = await import(
          "@/quickhack_server/sales-channel/coupang/order-matching-service"
        );
        const result = await runCoupangMatchingPostCycleForShipment(
          {
            externalOrderId: input.externalOrderId,
            externalShipmentId: input.externalShipmentId,
          },
          context
        );
        await context.updateProgress(1, 1);
        return { summary: result, progressCurrent: 1, progressTotal: 1 };
      }
    );

    if (workerResult.skipped) {
      return {
        status: "PENDING",
        reasonCode: "ORDER_MATCHING_WORKER_BUSY",
      };
    }

    return { status: "COMPLETED", result: workerResult.result };
  } catch {
    return {
      status: "FAILED",
      reasonCode: "ORDER_MATCHING_POST_CYCLE_FAILED",
    };
  }
}

async function executeManualOrderMatchWithIntent(
  raw: Record<string, unknown>,
  user: AuthUser,
  leaseId: string,
  assertLeaseHealthy: () => void,
  dependencies: ManualOrderMatchDependencies = {}
) {
  assertManualOrderMatchReadEnabled();
  assertManualOrderMatchMutationEnabled();
  const idempotencyKey = requiredText(raw.idempotencyKey, "idempotencyKey", 160);
  const expectedManifest = requiredText(raw.manifestToken, "manifestToken", 64);
  const mutation = await runRetriableMeasuredTransaction(prisma, "manual-order-match.execute", async (tx) => {
    const workItemId = requiredInteger(raw.workItemId, "workItemId");
    const targetWork = await tx.order_matching_work_queue.findUnique({
      where: { work_item_id: workItemId },
      select: { external_order_id: true, external_shipment_id: true },
    });
    if (!targetWork) {
      throw publicNotFound("CHANNEL_ORDER_REQUIRED", "CHANNEL_ORDER_REQUIRED");
    }
    await tx.$queryRaw`
      SELECT work_item_id
      FROM order_matching_work_queue
      WHERE channel = 'COUPANG'
        AND external_order_id = ${targetWork.external_order_id}
        AND external_shipment_id = ${targetWork.external_shipment_id}
      ORDER BY work_item_id
      FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT coupang_order_raw_id
      FROM coupang_order_raw
      WHERE external_order_id = ${targetWork.external_order_id}
        AND external_shipment_id = ${targetWork.external_shipment_id}
      FOR UPDATE
    `;
    assertLeaseHealthy();
    await assertManualOrderMatchIntentActive(tx, leaseId, user.userId);
    const commandDigest = digestDomainOperation({
      workItemId,
      operation: operation(raw.operation),
      allocationId: raw.allocationId == null ? null : requiredInteger(raw.allocationId, "allocationId"),
      pgNo: normalizePgNo(raw.pgNo) || null,
      selectionReceiptId: String(raw.selectionReceiptId ?? "").trim() || null,
      requestChannel: requestChannel(raw.requestChannel),
      reason: requiredText(raw.reason, "변경 사유", 500),
      manifestToken: expectedManifest,
    });
    const operationRow = await reserveDomainOperationKey(tx, {
      scope: "MANUAL_ORDER_MATCH",
      operationKey: idempotencyKey,
      aggregateType: "ORDER_MATCHING_WORK_ITEM",
      aggregateId: String(workItemId),
      requestDigest: commandDigest,
    });
    if (!operationRow.owned) {
      return {
        replayed: true as const,
        workItemId,
        operation: operation(raw.operation),
      };
    }
    const initial = await previewManualOrderMatch(raw, user, tx);
    if (initial.manifestToken !== expectedManifest || !initial.eligible) throw publicConflict("MANUAL_ORDER_MATCH_PREVIEW_STALE", "MANUAL_ORDER_MATCH_PREVIEW_STALE", { refreshRequired: true, reasonCodes: initial.reasonCodes });

    const now = databaseNow();
    const selectedOperation = initial.snapshot.operation;
    const previous = initial.currentAllocation;
    const shipmentAllocationIds = initial.snapshot.shipmentAllocations
      .map((allocation) => allocation.allocationId)
      .sort((left, right) => left - right);
    await lockDeviceAggregates(tx, {
      pgNos: [
        ...initial.snapshot.shipmentAllocations.map((allocation) => allocation.pgNo),
        previous?.pgNo,
        initial.candidate?.pgNo,
      ].filter(
        (value): value is string => Boolean(value)
      ),
      requireDevice: true,
      requireInventory: true,
    });
    if (shipmentAllocationIds.length > 0) {
      await tx.$queryRaw`
        SELECT allocation_id
        FROM match_worker_allocation
        WHERE allocation_id IN (${Prisma.join(shipmentAllocationIds)})
        ORDER BY allocation_id
        FOR UPDATE
      `;
    }
    const lockedPreview = await previewManualOrderMatch(raw, user, tx);
    if (lockedPreview.manifestToken !== expectedManifest || !lockedPreview.eligible) {
      throw publicConflict("MANUAL_ORDER_MATCH_PREVIEW_STALE", "MANUAL_ORDER_MATCH_PREVIEW_STALE", { refreshRequired: true, reasonCodes: lockedPreview.reasonCodes });
    }
    const balanceSkuIds = [
      previous?.inventorySkuId,
      lockedPreview.candidate?.inventorySkuId,
    ].filter(
      (value): value is number => Number.isSafeInteger(value) && Number(value) > 0
    );
    await lockInventoryQuantityBalanceKeys(
      tx,
      balanceSkuIds.flatMap((inventorySkuId) => [
        { inventorySkuId, inventoryStatus: INVENTORY_STATUS.sellable },
        { inventorySkuId, inventoryStatus: INVENTORY_STATUS.reserved },
      ])
    );
    if (previous) {
      await transitionInventoryStatusWithLedger(tx, {
        pgNo: previous.pgNo,
        expectedFromStatus: INVENTORY_STATUS.reserved,
        toStatus: INVENTORY_STATUS.sellable,
        transitionPolicy: INVENTORY_TRANSITION_POLICY.orderRematchRelease,
        operationKey: `MANUAL_ORDER_MATCH:${idempotencyKey}:RELEASE:${previous.pgNo}`,
        movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "MANUAL_ORDER_MATCH",
        sourceId: String(workItemId),
        reason: initial.snapshot.reason,
        actorUserId: user.userId,
        occurredAt: now,
      });
      await tx.match_worker_allocation.update({ where: { allocation_id: previous.allocationId }, data: { allocation_status: "CANCELED", released_at: now, updated_at: now } });
    }

    let createdAllocationId: number | null = null;
    if (selectedOperation !== "RELEASE" && initial.candidate) {
      const reserved = await transitionInventoryStatusWithLedger(tx, {
        pgNo: initial.candidate.pgNo,
        expectedFromStatus: INVENTORY_STATUS.sellable,
        expectedRevision: initial.candidate.revision ?? undefined,
        toStatus: INVENTORY_STATUS.reserved,
        transitionPolicy: INVENTORY_TRANSITION_POLICY.orderMatchingReservation,
        operationKey: `MANUAL_ORDER_MATCH:${idempotencyKey}:RESERVE:${initial.candidate.pgNo}`,
        movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
        sourceType: "MANUAL_ORDER_MATCH",
        sourceId: String(workItemId),
        reason: initial.snapshot.reason,
        actorUserId: user.userId,
        occurredAt: now,
      });
      const item = await tx.order_matching_work_queue.findUniqueOrThrow({ where: { work_item_id: workItemId } });
      let created;
      try {
        created = await tx.match_worker_allocation.create({ data: {
        external_order_id: item.external_order_id,
        pg_no: initial.candidate.pgNo,
        external_shipment_id: item.external_shipment_id,
        external_vendor_item_id: item.external_vendor_item_id,
        external_product_id: item.seller_product_id,
        vendor_item_name: item.vendor_item_name,
        seller_product_name: item.seller_product_name,
        seller_product_item_name: item.seller_product_item_name,
        option_name: item.seller_product_item_name,
        available_quantity_at_allocation: item.matchable_quantity,
        sales_offer_id: item.sales_offer_id,
        inventory_sku_id: reserved.inventorySkuId,
        required_model: item.required_model_label,
        required_storage: item.required_storage_label,
        required_color: item.required_color_label,
        required_warranty_group: item.required_warranty_group,
        inventory_status_before_allocation: INVENTORY_STATUS.sellable,
        allocation_status: "ALLOCATED",
        allocated_at: now,
        created_at: now,
        updated_at: now,
        } });
      } catch (error) {
        if (isExpectedPostgresqlUniqueViolation(error, ["uq_match_worker_allocation_active_pg", "pg_no"])) {
          throw publicConflict("PG_ALREADY_ALLOCATED", "PG_ALREADY_ALLOCATED", { refreshRequired: true });
        }
        throw error;
      }
      createdAllocationId = created.allocation_id;
    }

    const item = await tx.order_matching_work_queue.findUniqueOrThrow({ where: { work_item_id: workItemId } });
    const activeCount = await tx.match_worker_allocation.count({ where: { external_order_id: item.external_order_id, external_shipment_id: item.external_shipment_id, external_vendor_item_id: item.external_vendor_item_id, allocation_status: { in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES] } } });
    const status = nextWorkStatus(item.matchable_quantity, activeCount);
    const requiresRecovery =
      selectedOperation === "RELEASE" && previous?.status === "API_ACKED";
    await tx.order_matching_work_queue.update({
      where: { work_item_id: workItemId },
      data: {
        work_status: status,
        work_failure_reason: requiresRecovery
          ? "MANUAL_REASSIGNMENT_REQUIRED"
          : activeCount < item.matchable_quantity
            ? "INSUFFICIENT_INVENTORY"
            : null,
        matched_at: activeCount > 0 ? now : null,
        ...(requiresRecovery
          ? {
              manual_recovery_status: "REASSIGNMENT_REQUIRED",
              manual_recovery_started_at: now,
              manual_recovery_started_by_user_id: user.userId,
            }
          : {}),
        revision: { increment: 1 },
        updated_at: now,
      },
    });
    const result = {
      replayed: false as const,
      workItemId,
      operation: selectedOperation,
      previousAllocationId: previous?.allocationId ?? null,
      allocationId: createdAllocationId,
      workStatus: status,
      externalOrderId: item.external_order_id,
      externalShipmentId: item.external_shipment_id,
    };
    await tx.employee_activity_logs.create({ data: { user_id: user.userId, action_type: `CHANNEL_ORDER_MANUAL_${selectedOperation}`, target_type: "SALES_CHANNEL_ORDER_ITEM", target_id: String(workItemId), ...activityLogChangeData(
      {
        allocationId: previous?.allocationId ?? null,
        pgNo: previous?.pgNo ?? null,
      },
      {
        allocationId: createdAllocationId,
        pgNo: initial.candidate?.pgNo ?? null,
        operation: selectedOperation,
        idempotencyKey,
        requestChannel: initial.snapshot.requestChannel,
        reason: initial.snapshot.reason,
      }
    ), result: "SUCCESS", created_at: now } });
    if (selectedOperation !== "RELEASE") {
      await tx.manual_order_match_selection_receipts.update({
        where: { receipt_id: initial.snapshot.selectionReceiptId! },
        data: { consumed_at: now },
      });
    }
    assertLeaseHealthy();
    await assertManualOrderMatchIntentActive(tx, leaseId, user.userId);
    await completeDomainOperationKey(tx, operationRow.row.operation_id, digestDomainOperation(result));
    return result;
  }, { isolationLevel: "Serializable", maxAttempts: 3 });

  if (mutation.replayed) {
    const current = await prisma.order_matching_work_queue.findUnique({
      where: { work_item_id: mutation.workItemId },
      select: {
        manual_recovery_status: true,
        external_order_id: true,
        external_shipment_id: true,
        external_vendor_item_id: true,
      },
    });
    const activeAllocations = current
      ? await prisma.match_worker_allocation.findMany({
          where: {
            external_order_id: current.external_order_id,
            external_shipment_id: current.external_shipment_id,
            external_vendor_item_id: current.external_vendor_item_id,
            allocation_status: { in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES] },
          },
          select: { allocation_status: true },
        })
      : [];
    const postCycleCompleted =
      current?.manual_recovery_status === "NONE" &&
      activeAllocations.length > 0 &&
      activeAllocations.every((allocation) => allocation.allocation_status !== "ALLOCATED");
    return {
      ...mutation,
      postCycle:
        mutation.operation === "RELEASE"
          ? { status: "NOT_REQUIRED" as const }
          : postCycleCompleted
            ? { status: "COMPLETED" as const, result: { recovered: true } }
          : {
              status: "PENDING" as const,
              reasonCode: "IDEMPOTENT_REPLAY_REQUIRES_RECOVERY_CHECK" as const,
            },
    };
  }

  if (mutation.operation === "RELEASE" || mutation.workStatus !== "MATCHED") {
    return { ...mutation, postCycle: { status: "NOT_REQUIRED" as const } };
  }

  const postCycle = await (dependencies.runPostCycle ?? runManualOrderMatchPostCycle)({
    externalOrderId: mutation.externalOrderId,
    externalShipmentId: mutation.externalShipmentId,
    user,
  });
  return { ...mutation, postCycle };
}

export async function executeManualOrderMatch(
  raw: Record<string, unknown>,
  user: AuthUser,
  dependencies: ManualOrderMatchDependencies = {}
) {
  assertManualOrderMatchReadEnabled();
  assertManualOrderMatchMutationEnabled();
  if (!canAccessRole(user.role, "MANAGER")) {
    throw publicBadRequest("MANUAL_ORDER_MATCH_FORBIDDEN", "MANUAL_ORDER_MATCH_FORBIDDEN");
  }
  if (!dependencies.sensitiveActionVerified) {
    throw publicBadRequest("MANUAL_ORDER_MATCH_OTP_REQUIRED", "MANUAL_ORDER_MATCH_OTP_REQUIRED");
  }
  requiredInteger(raw.workItemId, "workItemId");
  const selectedOperation = operation(raw.operation);
  requiredText(raw.idempotencyKey, "idempotencyKey", 160);
  const expectedManifest = requiredText(raw.manifestToken, "manifestToken", 64);
  if (selectedOperation !== "RELEASE") requireCanonicalPgNo(raw.pgNo);
  const validatedPreview = await previewManualOrderMatch(raw, user);
  if (!validatedPreview.eligible || validatedPreview.manifestToken !== expectedManifest) {
    throw publicConflict("MANUAL_ORDER_MATCH_PREVIEW_STALE", "MANUAL_ORDER_MATCH_PREVIEW_STALE", { refreshRequired: true, reasonCodes: validatedPreview.reasonCodes });
  }
  const lease = await acquireManualOrderMatchIntent(raw, user);
  let leaseLost = false;
  const renewal = setInterval(() => {
    void renewManualOrderMatchIntent(lease.lease_id)
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch(() => { leaseLost = true; });
  }, MANUAL_ORDER_MATCH_INTENT_RENEW_MS);
  renewal.unref();
  try {
    await dependencies.afterIntentAcquire?.({ leaseId: lease.lease_id });
    return await executeManualOrderMatchWithIntent(raw, user, lease.lease_id, () => {
      if (leaseLost) throw publicConflict("MANUAL_INTENT_LOST", "MANUAL_INTENT_LOST", { refreshRequired: true });
    }, dependencies);
  } finally {
    clearInterval(renewal);
    await releaseManualOrderMatchIntent(lease.lease_id).catch(() => undefined);
  }
}
