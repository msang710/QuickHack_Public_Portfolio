import type { Prisma } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { nowKstSqlDateTime } from "@/quickhack_shared/core/time";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_TRANSITION_POLICY } from "@/quickhack_shared/inventory/inventory-write-rules";
import {
  ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
  isRandomMatchingOption,
} from "@/quickhack_shared/sales-channel/order-matching";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import type { MobileRegistrationSecurityContext } from "@/quickhack_server/mobile/mobile-device-service";
import { requireMobilePackingDeviceInTransaction } from "@/quickhack_server/mobile/mobile-device-service";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import { findShipmentReturnConflicts } from "@/quickhack_server/returns/shipment-return-conflict-service";
import { consumePackingConfirmedSupplies } from "@/quickhack_server/supplies/outbound-supply-service";

type PackingCheckInput = {
  orderBarcode?: unknown;
  deviceBarcode?: unknown;
  scannedValues?: unknown;
  componentBarcodes?: unknown;
  clientId?: unknown;
  appInstanceId?: unknown;
  deviceToken?: unknown;
};

type PackingCheckCode =
  | "MATCH"
  | "MISSING_INPUT"
  | "DEVICE_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_ALLOCATED"
  | "ORDER_SCAN_AMBIGUOUS"
  | "STALE_INVOICE"
  | "ORDER_DEVICE_MISMATCH"
  | "MODEL_MISMATCH"
  | "RETURN_PROCESSING_REQUIRED"
  | "RETURNED_ALLOCATION"
  | "PACKING_STATUS_REQUIRED";

type PackingCheckResult = {
  matched: boolean;
  code: PackingCheckCode;
  message: string;
  orderLookupSource?: "ORDER_OR_SHIPMENT" | "CURRENT_INVOICE";
  device?: {
    pgNo: string;
    model: string;
    modelCode: string | null;
    modelSeq: number | null;
    storage: string | null;
    color: string | null;
  };
  order?: {
    externalOrderId: string;
    externalShipmentId: string | null;
    allocationStatus: string;
    shipmentListPrintBatchLabel: string | null;
  };
  expected?: {
    model: string | null;
    storage: string | null;
    color: string | null;
  };
  scanned?: { values: string[]; componentBarcodes: string[] };
};

type TransactionClient = Prisma.TransactionClient;
type DeviceLookup = NonNullable<Awaited<ReturnType<typeof findDeviceByScan>>>;
type AllocationLookup = Awaited<ReturnType<typeof findActiveAllocationsByOrderScan>>[number];

function text(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeScan(value: unknown) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeProductText(value: unknown) {
  return text(value).toUpperCase().replace(/[\s\p{P}]+/gu, "");
}

function inputList(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(text).filter(Boolean);
}

function scanCandidates(value: unknown) {
  const candidates = new Set<string>();
  for (const raw of inputList(value)) {
    const normalized = normalizeScan(raw);
    candidates.add(raw);
    if (normalized) candidates.add(normalized);
    for (const match of normalized.matchAll(/[A-Z0-9]{5,}/g)) candidates.add(match[0]);
    for (const match of normalized.matchAll(/\d{5,}/g)) candidates.add(match[0]);
  }
  return [...candidates].filter(Boolean);
}

function uniqueInputValues(input: PackingCheckInput) {
  return [...new Set([...inputList(input.scannedValues), text(input.orderBarcode), text(input.deviceBarcode)].filter(Boolean))];
}

const allocationSelect = {
  allocation_id: true,
  external_order_id: true,
  external_shipment_id: true,
  pg_no: true,
  allocation_status: true,
  shipment_list_print_batch_label: true,
  required_model: true,
  required_storage: true,
  required_color: true,
  device: {
    select: {
      device_id: true,
      pg_no: true,
      imei: true,
      model: true,
      model_code: true,
      model_seq: true,
      storage: true,
      color: true,
    },
  },
} satisfies Prisma.match_worker_allocationSelect;

async function findDeviceByScan(tx: TransactionClient, deviceBarcode: unknown) {
  const candidates = scanCandidates(deviceBarcode);
  if (candidates.length === 0) return null;
  return tx.devices.findFirst({
    where: { OR: [{ pg_no: { in: candidates } }, { imei: { in: candidates } }] },
    select: allocationSelect.device.select,
  });
}

async function findActiveAllocationsByOrderScan(
  tx: TransactionClient,
  orderBarcode: unknown
) {
  const candidates = scanCandidates(orderBarcode);
  if (candidates.length === 0) return [];
  return tx.match_worker_allocation.findMany({
    where: {
      allocation_status: { in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES] },
      OR: [
        { external_order_id: { in: candidates } },
        { external_shipment_id: { in: candidates } },
      ],
    },
    select: allocationSelect,
    orderBy: { allocation_id: "asc" },
  });
}

async function findInvoiceAllocations(tx: TransactionClient, orderBarcode: unknown) {
  const candidates = scanCandidates(orderBarcode);
  if (candidates.length === 0) {
    return { allocations: [] as AllocationLookup[], packageGroupId: null as number | null, staleInvoice: false };
  }
  const groups = await tx.shipment_package_groups.findMany({
    where: {
      current_carrier_shipment: { is: { tracking_number: { in: candidates } } },
      members: {
        some: {
          removed_at: null,
          allocation: {
            allocation_status: { in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES] },
          },
        },
      },
    },
    select: {
      package_group_id: true,
      members: {
        where: {
          removed_at: null,
          allocation: {
            allocation_status: { in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES] },
          },
        },
        select: { allocation: { select: allocationSelect } },
        orderBy: { member_sequence: "asc" },
      },
    },
  });
  if (groups.length > 1) {
    return { allocations: [] as AllocationLookup[], packageGroupId: -1, staleInvoice: false };
  }
  if (groups.length === 1) {
    return {
      allocations: groups[0].members.map((member) => member.allocation),
      packageGroupId: groups[0].package_group_id,
      staleInvoice: false,
    };
  }
  const staleInvoice =
    (await tx.carrier_shipments.count({ where: { tracking_number: { in: candidates } } })) > 0;
  return { allocations: [] as AllocationLookup[], packageGroupId: null, staleInvoice };
}

async function orderWorkRowCount(tx: TransactionClient, orderBarcode: unknown) {
  const candidates = scanCandidates(orderBarcode);
  if (candidates.length === 0) return 0;
  return tx.order_matching_work_queue.count({
    where: {
      OR: [
        { external_order_id: { in: candidates } },
        { external_shipment_id: { in: candidates } },
      ],
    },
  });
}

function summarizeDevice(device: DeviceLookup) {
  return {
    pgNo: device.pg_no,
    model: device.model,
    modelCode: device.model_code,
    modelSeq: device.model_seq,
    storage: device.storage,
    color: device.color,
  };
}

function summarizeOrder(allocation: AllocationLookup) {
  return {
    externalOrderId: allocation.external_order_id,
    externalShipmentId: allocation.external_shipment_id,
    allocationStatus: allocation.allocation_status,
    shipmentListPrintBatchLabel: allocation.shipment_list_print_batch_label,
  };
}

function summarizeExpected(allocation: AllocationLookup) {
  return {
    model: allocation.required_model,
    storage: allocation.required_storage,
    color: allocation.required_color,
  };
}

function optionMatches(required: unknown, actual: unknown) {
  const requiredText = text(required);
  if (!requiredText || isRandomMatchingOption(requiredText)) return true;
  const actualText = normalizeProductText(actual);
  return !!actualText && actualText === normalizeProductText(requiredText);
}

function allocationMatchesOrderScan(allocation: AllocationLookup, input: unknown) {
  const candidates = new Set(scanCandidates(input));
  return (
    candidates.has(allocation.external_order_id) ||
    candidates.has(allocation.external_shipment_id)
  );
}

function modelMatches(device: DeviceLookup, allocation: AllocationLookup) {
  const requiredModel = normalizeProductText(allocation.required_model);
  const deviceModel = normalizeProductText(`${device.model} ${device.model_code ?? ""}`);
  const modelOk =
    !requiredModel ||
    (!!deviceModel &&
      (deviceModel.includes(requiredModel) || requiredModel.includes(deviceModel)));
  return (
    modelOk &&
    optionMatches(allocation.required_storage, device.storage) &&
    optionMatches(allocation.required_color, device.color)
  );
}

function baseResult(input: {
  orderBarcode: string;
  deviceBarcode: string;
  scannedValues: string[];
  componentBarcodes: string[];
  device: DeviceLookup | null;
  allocations: AllocationLookup[];
  orderWorkCount: number;
  lookupSource: "ORDER_OR_SHIPMENT" | "CURRENT_INVOICE";
  staleInvoice: boolean;
  ambiguousInvoice: boolean;
}): PackingCheckResult {
  const scanned = { values: input.scannedValues, componentBarcodes: input.componentBarcodes };
  if (input.scannedValues.length < 2 && (!input.orderBarcode || !input.deviceBarcode)) {
    return { matched: false, code: "MISSING_INPUT", message: "주문/송장과 기기 바코드를 모두 스캔하세요.", scanned };
  }
  if (!input.device) {
    return { matched: false, code: "DEVICE_NOT_FOUND", message: "QuickHack에서 스캔한 PG/IMEI를 찾을 수 없습니다.", scanned };
  }
  if (input.ambiguousInvoice) {
    return { matched: false, code: "ORDER_SCAN_AMBIGUOUS", message: "같은 송장번호가 둘 이상의 현재 포장 그룹에 연결되어 있습니다.", device: summarizeDevice(input.device), scanned };
  }
  if (input.allocations.length === 0) {
    if (input.staleInvoice) {
      return { matched: false, code: "STALE_INVOICE", message: "교체되었거나 현재 포장 그룹에서 제거된 송장입니다.", device: summarizeDevice(input.device), scanned };
    }
    return {
      matched: false,
      code: input.orderWorkCount > 0 ? "ORDER_NOT_ALLOCATED" : "ORDER_NOT_FOUND",
      message: input.orderWorkCount > 0 ? "주문은 확인되지만 현재 활성 배정이 없습니다." : "주문·배송·현재 송장 바코드를 찾을 수 없습니다.",
      device: summarizeDevice(input.device),
      scanned,
    };
  }
  const matching = input.allocations.find((allocation) => allocation.pg_no === input.device?.pg_no);
  if (!matching) {
    return {
      matched: false,
      code: "ORDER_DEVICE_MISMATCH",
      message: "스캔한 PG가 이 주문·배송·현재 송장에 배정되지 않았습니다.",
      orderLookupSource: input.lookupSource,
      device: summarizeDevice(input.device),
      order: summarizeOrder(input.allocations[0]),
      expected: summarizeExpected(input.allocations[0]),
      scanned,
    };
  }
  if (!modelMatches(input.device, matching)) {
    return {
      matched: false,
      code: "MODEL_MISMATCH",
      message: "스캔한 기기의 모델·용량·색상이 주문 조건과 일치하지 않습니다.",
      orderLookupSource: input.lookupSource,
      device: summarizeDevice(input.device),
      order: summarizeOrder(matching),
      expected: summarizeExpected(matching),
      scanned,
    };
  }
  return {
    matched: true,
    code: "MATCH",
    message: "주문과 기기가 일치합니다.",
    orderLookupSource: input.lookupSource,
    device: summarizeDevice(input.device),
    order: summarizeOrder(matching),
    expected: summarizeExpected(matching),
    scanned,
  };
}

function packingStatusRequiredResult(result: PackingCheckResult, currentStatus?: string | null): PackingCheckResult {
  return { ...result, matched: false, code: "PACKING_STATUS_REQUIRED", message: `포장 검수는 PACKING 재고만 확정할 수 있습니다. 현재 상태: ${currentStatus || "-"}` };
}

function returnBlockedResult(result: PackingCheckResult, code: "RETURN_PROCESSING_REQUIRED" | "RETURNED_ALLOCATION"): PackingCheckResult {
  return {
    ...result,
    matched: false,
    code,
    message: code === "RETURNED_ALLOCATION" ? "반품 처리로 취소된 배정입니다." : "반품 접수가 연결된 주문입니다. 반품 업무를 먼저 처리하세요.",
  };
}

async function logPackingCheck(
  tx: TransactionClient,
  input: {
    user: AuthUser;
    clientId: string;
    orderBarcode: string;
    deviceBarcode: string;
    scannedValues: string[];
    componentBarcodes: string[];
    checkedAt: string;
    inventoryStatusBefore?: string | null;
    inventoryStatusAfter?: string | null;
    result: PackingCheckResult;
  }
) {
  await tx.employee_activity_logs.create({
    data: {
      user_id: input.user.userId,
      action_type: "MOBILE_PACKING_CHECK",
      target_type: "PACKING_CHECK",
      target_id: input.result.order?.externalShipmentId ?? input.result.order?.externalOrderId ?? input.result.device?.pgNo ?? null,
      ...activityLogChangeData(
        {
          clientId: input.clientId || null,
          orderBarcode: input.orderBarcode,
          deviceBarcode: input.deviceBarcode,
          scannedValues: input.scannedValues,
          componentBarcodes: input.componentBarcodes,
          checkedAt: input.checkedAt,
          inventoryStatusBefore: input.inventoryStatusBefore ?? null,
        },
        { ...input.result, inventoryStatusAfter: input.inventoryStatusAfter ?? null }
      ),
      result: input.result.matched ? "SUCCESS" : "FAILED",
      created_at: databaseDateTime(input.checkedAt),
    },
  });
}

export async function checkPackingIntegrity(
  input: PackingCheckInput,
  user: AuthUser,
  securityContext: MobileRegistrationSecurityContext
) {
  const orderBarcode = text(input.orderBarcode);
  const deviceBarcode = text(input.deviceBarcode);
  const scannedValues = uniqueInputValues(input);
  const componentBarcodes = inputList(input.componentBarcodes);
  const clientId = text(input.appInstanceId ?? input.clientId);
  const checkedAt = nowKstSqlDateTime();
  const deviceScanInput = deviceBarcode || scannedValues;
  const orderScanInput = orderBarcode || scannedValues;

  return runMeasuredTransaction(prisma, "shipment.packing-check", async (tx) => {
    await requireMobilePackingDeviceInTransaction(tx, input, securityContext);
    let device = await findDeviceByScan(tx, deviceScanInput);
    if (device) {
      await tx.$queryRaw`SELECT device_id FROM devices WHERE device_id = ${device.device_id} FOR SHARE`;
      device = await tx.devices.findUnique({
        where: { device_id: device.device_id },
        select: allocationSelect.device.select,
      });
    }

    const directAllocations = await findActiveAllocationsByOrderScan(tx, orderScanInput);
    const invoice = await findInvoiceAllocations(tx, orderScanInput);
    let allocations = directAllocations;
    let lookupSource: "ORDER_OR_SHIPMENT" | "CURRENT_INVOICE" = "ORDER_OR_SHIPMENT";
    const packageGroupId = invoice.packageGroupId;
    let staleInvoice = directAllocations.length === 0 && invoice.staleInvoice;
    let ambiguousInvoice = packageGroupId === -1;
    if (invoice.allocations.length > 0) {
      const invoiceAllocationIds = new Set(
        invoice.allocations.map((allocation) => allocation.allocation_id)
      );
      const sameLogicalTarget = directAllocations.every((allocation) =>
        invoiceAllocationIds.has(allocation.allocation_id)
      );
      if (directAllocations.length > 0 && !sameLogicalTarget) {
        allocations = [];
        ambiguousInvoice = true;
      } else {
        allocations = invoice.allocations;
        lookupSource = "CURRENT_INVOICE";
      }
    } else if (directAllocations.length === 0) {
      allocations = invoice.allocations;
    }
    if (packageGroupId && packageGroupId > 0) {
      await tx.$queryRaw`SELECT package_group_id FROM shipment_package_groups WHERE package_group_id = ${packageGroupId} FOR UPDATE`;
      const currentInvoice = await findInvoiceAllocations(tx, orderScanInput);
      if (currentInvoice.packageGroupId !== packageGroupId) {
        allocations = [];
        ambiguousInvoice = currentInvoice.packageGroupId === -1;
        staleInvoice = !ambiguousInvoice;
      } else {
        allocations = currentInvoice.allocations;
      }
    }

    const result = baseResult({
      orderBarcode,
      deviceBarcode,
      scannedValues,
      componentBarcodes,
      device,
      allocations,
      orderWorkCount: allocations.length === 0 ? await orderWorkRowCount(tx, orderScanInput) : 0,
      lookupSource,
      staleInvoice,
      ambiguousInvoice,
    });
    const matchedAllocation =
      result.matched && result.device?.pgNo
        ? allocations.find((allocation) => allocation.pg_no === result.device?.pgNo) ?? null
        : null;

    if (!matchedAllocation || !result.device?.pgNo) {
      await logPackingCheck(tx, {
        user,
        clientId,
        orderBarcode,
        deviceBarcode,
        scannedValues,
        componentBarcodes,
        checkedAt,
        result,
      });
      return result;
    }

    await tx.$queryRaw`SELECT allocation_id FROM match_worker_allocation WHERE allocation_id = ${matchedAllocation.allocation_id} FOR UPDATE`;
    const currentAllocation = await tx.match_worker_allocation.findUnique({
      where: { allocation_id: matchedAllocation.allocation_id },
      select: allocationSelect,
    });
    const currentInventory = await tx.inventory.findUnique({
      where: { pg_no: result.device.pgNo },
      select: { inventory_status: true },
    });
    const currentInvoiceAfterAllocationLock =
      lookupSource === "CURRENT_INVOICE" && packageGroupId && packageGroupId > 0
        ? await findInvoiceAllocations(tx, orderScanInput)
        : null;
    const currentInvoiceStillOwnsAllocation =
      !currentInvoiceAfterAllocationLock ||
      (currentInvoiceAfterAllocationLock.packageGroupId === packageGroupId &&
        currentInvoiceAfterAllocationLock.allocations.some(
          (allocation) => allocation.allocation_id === matchedAllocation.allocation_id
        ));
    let finalResult = result;
    if (!currentInvoiceStillOwnsAllocation) {
      finalResult = {
        ...result,
        matched: false,
        code: "STALE_INVOICE",
        message: "검증 중 현재 송장 또는 합포장 구성이 변경되었습니다. 다시 스캔하세요.",
      };
    } else if (
      !currentAllocation ||
      !(ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES as readonly string[]).includes(currentAllocation.allocation_status) ||
      currentAllocation.pg_no !== result.device.pgNo ||
      (lookupSource === "ORDER_OR_SHIPMENT" &&
        !allocationMatchesOrderScan(currentAllocation, orderScanInput))
    ) {
      finalResult = returnBlockedResult(result, "RETURNED_ALLOCATION");
    } else if (!device || !modelMatches(device, currentAllocation)) {
      finalResult = {
        ...result,
        matched: false,
        code: "MODEL_MISMATCH",
        message: "검증 중 기기 또는 주문 옵션 조건이 변경되었습니다. 다시 스캔하세요.",
        expected: summarizeExpected(currentAllocation),
      };
    } else if ((await findShipmentReturnConflicts(tx, [currentAllocation.allocation_id])).length > 0) {
      finalResult = returnBlockedResult(result, "RETURN_PROCESSING_REQUIRED");
    } else if (currentInventory?.inventory_status !== INVENTORY_STATUS.packing) {
      finalResult = packingStatusRequiredResult(result, currentInventory?.inventory_status);
    }

    if (!finalResult.matched) {
      await logPackingCheck(tx, {
        user,
        clientId,
        orderBarcode,
        deviceBarcode,
        scannedValues,
        componentBarcodes,
        checkedAt,
        inventoryStatusBefore: currentInventory?.inventory_status ?? null,
        inventoryStatusAfter: currentInventory?.inventory_status ?? null,
        result: finalResult,
      });
      return finalResult;
    }

    if (!currentAllocation || !currentInventory) {
      throw new Error("Packing state changed after validation.");
    }

    await consumePackingConfirmedSupplies(tx, {
      allocationId: currentAllocation.allocation_id,
      pgNo: result.device.pgNo,
      occurredAt: checkedAt,
      actorUserId: user.userId,
    });
    await transitionInventoryStatusWithLedger(tx, {
      pgNo: result.device.pgNo,
      toStatus: INVENTORY_STATUS.packed,
      expectedFromStatus: INVENTORY_STATUS.packing,
      transitionPolicy: INVENTORY_TRANSITION_POLICY.packingValidation,
      operationKey: `packing-check:allocation:${currentAllocation.allocation_id}:pg:${result.device.pgNo}`,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "PACKING_CHECK",
      sourceId: String(currentAllocation.allocation_id),
      reason: "포장 검증 통과",
      actorUserId: user.userId,
      occurredAt: checkedAt,
    });
    await logPackingCheck(tx, {
      user,
      clientId,
      orderBarcode,
      deviceBarcode,
      scannedValues,
      componentBarcodes,
      checkedAt,
      inventoryStatusBefore: currentInventory.inventory_status,
      inventoryStatusAfter: INVENTORY_STATUS.packed,
      result,
    });
    return result;
  });
}
