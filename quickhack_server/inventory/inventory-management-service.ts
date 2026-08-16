// QuickHack object: Manual inventory add/delete operations for sensitive stock administration.
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { normalizeOptionalImei } from "@/quickhack_shared/device/device-identifiers";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import { PURCHASE_PRICE_ENTRY_MODE } from "@/quickhack_shared/inbound/purchase-price-entry-mode";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { assertManualInventoryInitialStatus } from "@/quickhack_shared/inventory/inventory-write-rules";
import { explicitActivityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  normalizeInspectionField,
  type RecordColumn,
} from "@/quickhack_shared/inspection/inspection-schema";
import {
  INSPECTION_SOURCE_TYPE,
  INSPECTION_TYPE,
} from "@/quickhack_shared/inspection/inspection-types";
import { DEVICE_WARRANTY_OPTIONS } from "@/quickhack_shared/device/types";
import { resolveInboundBatchId } from "@/quickhack_server/inbound/inbound-batch-reference";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { lockAggregateKey } from "@/quickhack_server/core/database/aggregate-command";
import { raiseModelSequenceFloor } from "@/quickhack_server/inbound/model-sequence-service";
import { lockDeviceAggregateRow } from "@/quickhack_server/inventory/device-aggregate-lock";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  recordInventoryCreatedWithLedger,
  recordInventoryRemovedWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import {
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import {
  strictOptionalDatabaseDate,
  strictOptionalKstDateTime,
} from "@/quickhack_server/core/database/strict-business-time";

const PG_NO_PATTERN = /^[A-Z]{2}\d{10}$/;
const SALE_GRADE_VALUES = new Set(["A", "A-", "B+", "B"]);
const WARRANTY_VALUES = new Set<string>(DEVICE_WARRANTY_OPTIONS);
const INVENTORY_STATUS_VALUES = new Set<string>(Object.values(INVENTORY_STATUS));
const DEFAULT_MANUAL_INVENTORY_LOCATION = "상품화 대기";

function inventoryInputError(message: string) {
  return publicBadRequest("INVENTORY_INPUT_INVALID", message);
}

function assertInventoryManagementInitialStatus(status: string) {
  try {
    assertManualInventoryInitialStatus(status);
  } catch (error) {
    throw inventoryInputError(
      error instanceof Error
        ? error.message
        : "신규 재고상태가 올바르지 않습니다."
    );
  }
}

type InventoryManagementInput = Record<string, unknown>;
type TransactionClient = Prisma.TransactionClient;

function text(input: InventoryManagementInput, key: string) {
  const value = input[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function nullableText(input: InventoryManagementInput, key: string) {
  const value = text(input, key);
  return value === "" ? null : value;
}

function nullableInspectionText(
  input: InventoryManagementInput,
  key: string,
  column: RecordColumn
) {
  const value = normalizeInspectionField(column, input[key]);
  return value === "" ? null : value;
}

function nullableDateTime(input: InventoryManagementInput, key: string) {
  const value = input[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  try {
    return strictOptionalKstDateTime(value);
  } catch {
    throw inventoryInputError(`${key} 값은 실제 존재하는 YYYY-MM-DD HH:mm:ss 형식이어야 합니다.`);
  }
}

function nullableInspectionDateTime(
  input: InventoryManagementInput,
  key: string,
  column: RecordColumn
) {
  const value = text(input, key);
  if (value === "") return null;
  try {
    return strictOptionalKstDateTime(value);
  } catch {
    throw inventoryInputError(`${column} 값은 실제 존재하는 YYYY-MM-DD HH:mm:ss 형식이어야 합니다.`);
  }
}

function nullableInspectionDate(
  input: InventoryManagementInput,
  key: string,
  column: RecordColumn
) {
  const value = text(input, key);
  if (value === "") return null;
  try {
    return strictOptionalDatabaseDate(value);
  } catch {
    throw inventoryInputError(`${column} 값은 실제 존재하는 YYYY-MM-DD 형식이어야 합니다.`);
  }
}

function requiredText(
  input: InventoryManagementInput,
  key: string,
  label: string
) {
  const value = text(input, key);

  if (!value) {
    throw inventoryInputError(`${label} 값이 필요합니다.`);
  }

  return value;
}

function nullableInt(
  input: InventoryManagementInput,
  key: string,
  label: string
) {
  const value = text(input, key).replace(/,/g, "");

  if (!value) {
    return null;
  }

  if (!/^-?\d+$/.test(value)) {
    throw inventoryInputError(`${label} 값은 숫자로 입력해야 합니다.`);
  }

  return Number.parseInt(value, 10);
}

function nullableModelSeq(input: InventoryManagementInput) {
  const value = text(input, "modelSeq").replace(/,/g, "");

  if (!value) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  const displayMatch = value.match(/-(\d+)$/);

  if (displayMatch) {
    return Number.parseInt(displayMatch[1], 10);
  }

  throw inventoryInputError("고유번호는 숫자 또는 'S24-345' 형식으로 입력해야 합니다.");
}

function normalizePgNo(input: InventoryManagementInput) {
  const pgNo = requiredText(input, "pgNo", "PG").toUpperCase();

  if (!PG_NO_PATTERN.test(pgNo)) {
    throw inventoryInputError("PG는 알파벳 2자리 + 숫자 10자리 형식이어야 합니다.");
  }

  return pgNo;
}

function normalizeImei(input: InventoryManagementInput) {
  try {
    return normalizeOptionalImei(input.imei);
  } catch (error) {
    throw inventoryInputError(
      error instanceof Error ? error.message : "IMEI는 숫자 15자리 형식이어야 합니다."
    );
  }
}

function normalizeSaleGrade(input: InventoryManagementInput) {
  const saleGrade = nullableText(input, "saleGrade");

  if (saleGrade && !SALE_GRADE_VALUES.has(saleGrade)) {
    throw inventoryInputError("판매등급은 A, A-, B+, B 중 하나만 입력할 수 있습니다.");
  }

  return saleGrade;
}

function normalizeWarranty(input: InventoryManagementInput) {
  const warranty = nullableText(input, "warranty");

  if (warranty && !WARRANTY_VALUES.has(warranty)) {
    throw inventoryInputError("보증서는 1년 보증 또는 2년 보증만 입력할 수 있습니다.");
  }

  return warranty;
}

function normalizeInboundStatus(input: InventoryManagementInput) {
  const inboundStatus = text(input, "inboundStatus") || INBOUND_STATUS.purchased;

  if (inboundStatus !== INBOUND_STATUS.purchased) {
    throw inventoryInputError(
      "재고 추가는 매입 완료(PURCHASED) 입고만 생성할 수 있습니다."
    );
  }

  return inboundStatus;
}

function normalizeInventoryStatus(input: InventoryManagementInput) {
  const inventoryStatus =
    text(input, "inventoryStatus") || INVENTORY_STATUS.sellable;

  if (!INVENTORY_STATUS_VALUES.has(inventoryStatus)) {
    throw inventoryInputError("재고상태 값이 올바르지 않습니다.");
  }

  assertInventoryManagementInitialStatus(inventoryStatus);

  return inventoryStatus;
}

function normalizeReason(input: InventoryManagementInput, label: string) {
  return requiredText(input, "reason", label);
}

function normalizeReturnYn(input: InventoryManagementInput, key: string) {
  return normalizeInspectionField("매입처반품유무", input[key]) || "N";
}

function hasAnyText(input: InventoryManagementInput, keys: readonly string[]) {
  return keys.some((key) => text(input, key) !== "");
}

async function createInspectionRecordsIfPresent(
  tx: TransactionClient,
  pgNo: string,
  inboundId: number,
  input: InventoryManagementInput,
  timestamp: Date,
  user: AuthUser
) {
  const hasAppearanceInput =
    hasAnyText(input, [
      "appearanceGrade",
      "appearanceDefect",
      "appearanceWorker",
      "appearanceCheckedAt",
      "appearanceNote",
    ]) || normalizeReturnYn(input, "appearanceReturnYn") === "Y";
  const hasFunctionInput =
    hasAnyText(input, [
      "functionDefect",
      "csc",
      "firstCallDate",
      "functionWorker",
      "functionCheckedAt",
      "functionNote",
    ]) || normalizeReturnYn(input, "functionReturnYn") === "Y";

  if (hasAppearanceInput) {
    await tx.inspections.create({
      data: {
        pg_no: pgNo,
        inbound_id: inboundId,
        inspection_type: INSPECTION_TYPE.appearance,
        inspection_round: 1,
        source_type: INSPECTION_SOURCE_TYPE.manual,
        checked_by_user_id: user.userId,
        appearance_grade: nullableInspectionText(
          input,
          "appearanceGrade",
          "외관등급"
        ),
        appearance_defect: nullableInspectionText(
          input,
          "appearanceDefect",
          "외관하자"
        ),
        return_yn: normalizeReturnYn(input, "appearanceReturnYn"),
        appearance_worker: nullableInspectionText(
          input,
          "appearanceWorker",
          "외관검수자"
        ),
        appearance_checked_at:
          nullableInspectionDateTime(input, "appearanceCheckedAt", "외관검수일시") ??
          timestamp,
        checked_at:
          nullableInspectionDateTime(input, "appearanceCheckedAt", "외관검수일시") ??
          timestamp,
        note: nullableText(input, "appearanceNote"),
        created_at: timestamp,
      },
    });
  }

  if (hasFunctionInput) {
    await tx.inspections.create({
      data: {
        pg_no: pgNo,
        inbound_id: inboundId,
        inspection_type: INSPECTION_TYPE.function,
        inspection_round: 1,
        source_type: INSPECTION_SOURCE_TYPE.manual,
        checked_by_user_id: user.userId,
        function_defect: nullableInspectionText(
          input,
          "functionDefect",
          "기능하자"
        ),
        return_yn: normalizeReturnYn(input, "functionReturnYn"),
        csc: nullableInspectionText(input, "csc", "통신사"),
        first_call_date:
          nullableInspectionDate(input, "firstCallDate", "최초통화일"),
        function_worker: nullableInspectionText(
          input,
          "functionWorker",
          "기능검수자"
        ),
        function_checked_at:
          nullableInspectionDateTime(input, "functionCheckedAt", "기능검수일시") ??
          timestamp,
        checked_at:
          nullableInspectionDateTime(input, "functionCheckedAt", "기능검수일시") ??
          timestamp,
        note: nullableText(input, "functionNote"),
        created_at: timestamp,
      },
    });
  }
}

async function readDeviceSnapshot(tx: TransactionClient, pgNo: string) {
  const device = await tx.devices.findUnique({
    where: { pg_no: pgNo },
    include: {
      inbounds: {
        orderBy: { inbound_id: "desc" },
        take: 3,
        include: { inbound_batch: true },
      },
      inspections: { orderBy: { inspection_id: "desc" }, take: 3 },
      inventory: true,
      order_items: { select: { order_item_id: true, order_id: true } },
      match_worker_allocations: {
        select: { allocation_id: true, external_order_id: true },
      },
      _count: {
        select: {
          inbounds: true,
          inspections: true,
          order_items: true,
          match_worker_allocations: true,
          sales_records: true,
          sales_channel_write_requests: true,
          sales_channel_write_targets: true,
          shipment_address_change_works: true,
          inventory_audit_location_changes: true,
          supply_consumption_events: true,
        },
      },
    },
  });

  if (!device) {
    return null;
  }

  return {
    device: {
      createdAt: device.created_at,
      pgNo: device.pg_no,
      imei: device.imei,
      adbSerial: device.adb_serial,
      model: device.model,
      modelCode: device.model_code,
      modelSeq: device.model_seq,
      storage: device.storage,
      color: device.color,
      saleGrade: device.sale_grade,
      warranty: device.warranty,
    },
    inbounds: device.inbounds.map((item) => ({
      inboundId: item.inbound_id,
      batchId: item.inbound_batch_id,
      batchDate: item.inbound_batch?.batch_date ?? null,
      batchNo: item.inbound_batch?.batch_no ?? null,
      supplierName: item.supplier_name,
      purchasePrice: item.purchase_price,
      receivedAt: item.received_at,
      priceAgreedAt: item.price_agreed_at,
      status: item.inbound_status,
      note: item.note,
    })),
    inspections: device.inspections.map((item) => ({
      inspectionId: item.inspection_id,
      inboundId: item.inbound_id,
      inspectionType: item.inspection_type,
      inspectionRound: item.inspection_round,
      inspectionResult: item.inspection_result,
      sourceType: item.source_type,
      coupangReturnAllocationId: item.coupang_return_allocation_id,
      checkedByUserId: item.checked_by_user_id,
      checkedAt: item.checked_at,
      appearanceGrade: item.appearance_grade,
      appearanceDefect: item.appearance_defect,
      functionDefect: item.function_defect,
      returnYn: item.return_yn,
      csc: item.csc,
      firstCallDate: item.first_call_date,
    })),
    inventory: device.inventory
      ? {
          status: device.inventory.inventory_status,
          location: device.inventory.location,
          stockedAt: device.inventory.stocked_at,
        }
      : null,
    linkedCounts: {
      orderItems: device._count.order_items,
      channelOrderMatches: device._count.match_worker_allocations,
      salesRecords: device._count.sales_records,
      channelWriteRequests: device._count.sales_channel_write_requests,
      channelWriteTargets: device._count.sales_channel_write_targets,
      shipmentAddressChanges: device._count.shipment_address_change_works,
      inventoryAuditChanges: device._count.inventory_audit_location_changes,
      supplyConsumptionEvents: device._count.supply_consumption_events,
    },
    ownedCounts: {
      inbounds: device._count.inbounds,
      inspections: device._count.inspections,
    },
  };
}

async function writeActivityLog({
  tx,
  user,
  actionType,
  pgNo,
  beforeValue,
  afterValue,
  result,
  timestamp,
}: {
  tx: TransactionClient;
  user: AuthUser;
  actionType: string;
  pgNo: string;
  beforeValue: unknown;
  afterValue: unknown;
  result: string;
  timestamp: Date;
}) {
  await tx.employee_activity_logs.create({
    data: {
      user_id: user.userId,
      action_type: actionType,
      target_type: "DEVICE",
      target_id: pgNo,
      ...inventoryManagementActivityChangeData(beforeValue, afterValue),
      result,
      created_at: timestamp,
    },
  });
}

type DeviceSnapshot = NonNullable<Awaited<ReturnType<typeof readDeviceSnapshot>>>;
type ExplicitChange = {
  fieldName: string;
  beforeValue: string | null;
  afterValue: string | null;
};

function inventoryAuditEnvelope(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reason: null, deleted: null, snapshot: null };
  }
  const record = value as Record<string, unknown>;
  if ("snapshot" in record) {
    return {
      reason: typeof record.reason === "string" ? record.reason : null,
      deleted: null,
      snapshot: record.snapshot as DeviceSnapshot | null,
    };
  }
  if ("device" in record && "inbounds" in record && "inspections" in record) {
    return { reason: null, deleted: null, snapshot: value as DeviceSnapshot };
  }
  return {
    reason: typeof record.reason === "string" ? record.reason : null,
    deleted: record.deleted === true ? true : null,
    snapshot: null,
  };
}

function inventoryAuditScalar(value: unknown) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.some((item) => item !== null && typeof item === "object")) {
      throw new Error("Inventory audit object arrays require stable target keys.");
    }
    return value.map((item) => String(item ?? "")).join(", ");
  }
  if (typeof value === "object") {
    throw new Error("Inventory audit objects must be flattened before serialization.");
  }
  return String(value);
}

function appendInventoryAuditObjectChanges(
  changes: ExplicitChange[],
  prefix: string,
  before: unknown,
  after: unknown
) {
  const beforeRecord = before && typeof before === "object" && !Array.isArray(before)
    ? before as Record<string, unknown>
    : {};
  const afterRecord = after && typeof after === "object" && !Array.isArray(after)
    ? after as Record<string, unknown>
    : {};
  const keys = Array.from(
    new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])
  ).sort();

  for (const key of keys) {
    const beforeValue = beforeRecord[key];
    const afterValue = afterRecord[key];
    const nestedObject = [beforeValue, afterValue].some(
      (value) => value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
    );
    if (nestedObject) {
      appendInventoryAuditObjectChanges(
        changes,
        `${prefix}.${key}`,
        beforeValue,
        afterValue
      );
      continue;
    }
    const beforeText = inventoryAuditScalar(beforeValue);
    const afterText = inventoryAuditScalar(afterValue);
    if (beforeText !== afterText) {
      changes.push({
        fieldName: `${prefix}.${key}`,
        beforeValue: beforeText,
        afterValue: afterText,
      });
    }
  }
}

function appendInventoryAuditTargets<T extends Record<string, unknown>>(
  changes: ExplicitChange[],
  prefix: string,
  beforeItems: readonly T[],
  afterItems: readonly T[],
  identity: keyof T
) {
  const beforeById = new Map(beforeItems.map((item) => [String(item[identity]), item]));
  const afterById = new Map(afterItems.map((item) => [String(item[identity]), item]));
  const ids = Array.from(new Set([...beforeById.keys(), ...afterById.keys()])).sort();
  for (const id of ids) {
    appendInventoryAuditObjectChanges(
      changes,
      `${prefix}.${id}`,
      beforeById.get(id),
      afterById.get(id)
    );
  }
}

function inventoryAuditSummary(value: ReturnType<typeof inventoryAuditEnvelope>) {
  const snapshot = value.snapshot;
  return [
    value.reason ? `reason=${value.reason}` : null,
    snapshot ? `device=${snapshot.device.pgNo}` : null,
    snapshot ? `inbounds=${snapshot.inbounds.length}` : null,
    snapshot ? `inspections=${snapshot.inspections.length}` : null,
    value.deleted ? "deleted=true" : null,
  ].filter(Boolean).join(" / ") || "device=absent";
}

export function inventoryManagementActivityChangeData(
  beforeValue: unknown,
  afterValue: unknown
) {
  const before = inventoryAuditEnvelope(beforeValue);
  const after = inventoryAuditEnvelope(afterValue);
  const changes: ExplicitChange[] = [];
  appendInventoryAuditObjectChanges(changes, "metadata", {
    reason: before.reason,
    deleted: before.deleted,
  }, {
    reason: after.reason,
    deleted: after.deleted,
  });
  const beforeSnapshot = before.snapshot;
  const afterSnapshot = after.snapshot;
  appendInventoryAuditObjectChanges(changes, "snapshot", beforeSnapshot
    ? {
        device: beforeSnapshot.device,
        inventory: beforeSnapshot.inventory,
        linkedCounts: beforeSnapshot.linkedCounts,
        ownedCounts: beforeSnapshot.ownedCounts,
      }
    : null, afterSnapshot
    ? {
        device: afterSnapshot.device,
        inventory: afterSnapshot.inventory,
        linkedCounts: afterSnapshot.linkedCounts,
        ownedCounts: afterSnapshot.ownedCounts,
      }
    : null);
  appendInventoryAuditTargets(
    changes,
    "snapshot.inbounds",
    beforeSnapshot?.inbounds ?? [],
    afterSnapshot?.inbounds ?? [],
    "inboundId"
  );
  appendInventoryAuditTargets(
    changes,
    "snapshot.inspections",
    beforeSnapshot?.inspections ?? [],
    afterSnapshot?.inspections ?? [],
    "inspectionId"
  );
  return explicitActivityLogChangeData(changes, {
    beforeSummary: inventoryAuditSummary(before),
    afterSummary: inventoryAuditSummary(after),
  });
}

export async function createManualInventoryRecord(
  client: PrismaClient,
  input: InventoryManagementInput,
  user: AuthUser
) {
  const pgNo = normalizePgNo(input);
  const reason = normalizeReason(input, "재고 추가 사유");
  const timestamp = databaseNow();
  const model = requiredText(input, "model", "모델");
  const modelSeq = nullableModelSeq(input);
  const inventoryStatus = normalizeInventoryStatus(input);
  const inboundStatus = normalizeInboundStatus(input);
  const purchasePrice = nullableInt(input, "purchasePrice", "매입가");

  return runMeasuredTransaction(client, "inventory.manual.create", async (tx) => {
    await lockAggregateKey(tx, { namespace: "device-inbound", key: pgNo });
    await lockDeviceAggregateRow(tx, pgNo);
    const existing = await tx.devices.findUnique({
      where: { pg_no: pgNo },
      select: { pg_no: true },
    });

    if (existing) {
      throw publicConflict(
        "INVENTORY_ALREADY_EXISTS",
        `${pgNo}는 이미 등록된 PG입니다.`
      );
    }

    await tx.devices.create({
      data: {
        pg_no: pgNo,
        imei: normalizeImei(input),
        adb_serial: nullableText(input, "adbSerial"),
        model,
        model_code: nullableText(input, "modelCode"),
        model_seq: modelSeq,
        storage: nullableText(input, "storage"),
        color: nullableText(input, "color"),
        sale_grade: normalizeSaleGrade(input),
        warranty: normalizeWarranty(input),
        created_at: timestamp,
        updated_at: timestamp,
      },
    });

    await raiseModelSequenceFloor(tx, {
      model,
      floor: modelSeq,
      timestamp,
    });

    const receivedAt = nullableDateTime(input, "receivedAt") ?? timestamp;
    const inboundBatchId = await resolveInboundBatchId(
      tx,
      nullableInt(input, "batchNo", "차수"),
      receivedAt
    );

    const inbound = await tx.inbounds.create({
      data: {
        pg_no: pgNo,
        inbound_batch_id: inboundBatchId,
        supplier_name: nullableText(input, "supplierName"),
        purchase_price: purchasePrice,
        purchase_price_entry_mode:
          purchasePrice === null ? null : PURCHASE_PRICE_ENTRY_MODE.manual,
        received_at: receivedAt,
        price_agreed_at: nullableDateTime(input, "priceAgreedAt"),
        supplier_returned_at: null,
        inbound_status: inboundStatus,
        note: nullableText(input, "inboundNote"),
        created_at: timestamp,
        updated_at: timestamp,
        purchase_price_updated_by_user_id: user.userId,
        purchase_price_updated_at: timestamp,
      },
    });

    await createInspectionRecordsIfPresent(
      tx,
      pgNo,
      inbound.inbound_id,
      input,
      timestamp,
      user
    );

    await tx.inventory.create({
      data: {
        pg_no: pgNo,
        inventory_status: inventoryStatus,
        location:
          nullableText(input, "location") ?? DEFAULT_MANUAL_INVENTORY_LOCATION,
        stocked_at: nullableDateTime(input, "stockedAt") ?? timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await recordInventoryCreatedWithLedger(tx, {
      pgNo,
      inventoryStatus,
      operationKey: `MANUAL_INVENTORY_CREATE:${pgNo}:${randomUUID()}`,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated,
      sourceType: "MANUAL_INVENTORY",
      sourceId: pgNo,
      reason,
      actorUserId: user.userId,
      occurredAt: timestamp,
    });

    const after = await readDeviceSnapshot(tx, pgNo);

    await writeActivityLog({
      tx,
      user,
      actionType: "INVENTORY_MANUAL_CREATE",
      pgNo,
      beforeValue: null,
      afterValue: {
        reason,
        snapshot: after,
      },
      result: "SUCCESS",
      timestamp,
    });

    return { pgNo };
  });
}

export async function deleteManualInventoryRecord(
  client: PrismaClient,
  pgNoInput: string,
  input: InventoryManagementInput,
  user: AuthUser
) {
  const pgNo = pgNoInput.trim().toUpperCase();
  const reason = normalizeReason(input, "재고 삭제 사유");
  const expectedRevision = Number(input.expectedRevision);
  const timestamp = databaseNow();

  if (!pgNo) {
    throw inventoryInputError("삭제할 PG가 필요합니다.");
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw inventoryInputError("삭제 대상 기기의 revision이 올바르지 않습니다.");
  }

  return runMeasuredTransaction(client, "inventory.manual.delete", async (tx) => {
    await lockAggregateKey(tx, { namespace: "device-inbound", key: pgNo });
    await lockDeviceAggregateRow(tx, pgNo);
    const before = await readDeviceSnapshot(tx, pgNo);

    if (!before) {
      throw publicNotFound(
        "INVENTORY_NOT_FOUND",
        `${pgNo} 재고를 찾을 수 없습니다.`
      );
    }

    const linkedCounts = before.linkedCounts;
    const linkedTotal = Object.values(linkedCounts).reduce(
      (total, count) => total + count,
      0
    );

    if (linkedTotal > 0) {
      throw publicConflict(
        "INVENTORY_DELETE_CONFLICT",
        `${pgNo}는 주문·판매·출고·채널 처리·재고실사·비품 사용 이력이 있어 삭제할 수 없습니다.`
      );
    }

    const current = await tx.devices.findUnique({
      where: { pg_no: pgNo },
      select: {
        device_id: true,
        revision: true,
        inventory_sku_id: true,
        inventory: {
          select: { inventory_status: true },
        },
      },
    });

    if (!current || current.revision !== expectedRevision) {
      throw publicConflict(
        "INVENTORY_DELETE_TARGET_CHANGED",
        `${pgNo} 기기 정보가 조회 후 변경되었습니다. 목록을 새로 고쳐 주세요.`
      );
    }

    const manualCreateLog = await tx.employee_activity_logs.findFirst({
      where: {
        action_type: "INVENTORY_MANUAL_CREATE",
        target_type: "DEVICE",
        target_id: pgNo,
        result: "SUCCESS",
        created_at: { gte: before.device.createdAt },
      },
      select: { id: true },
      orderBy: { id: "desc" },
    });
    const ownedInbound = before.inbounds.length === 1 ? before.inbounds[0] : null;
    const manualOwnedShape =
      Boolean(manualCreateLog) &&
      before.ownedCounts.inbounds === 1 &&
      before.ownedCounts.inspections === before.inspections.length &&
      before.ownedCounts.inspections <= 2 &&
      ownedInbound?.status === INBOUND_STATUS.purchased &&
      Boolean(before.inventory) &&
      before.inspections.every(
        (inspection) =>
          inspection.sourceType === INSPECTION_SOURCE_TYPE.manual &&
          inspection.inboundId === ownedInbound?.inboundId
      );
    if (!manualOwnedShape) {
      throw publicConflict(
        "INVENTORY_DELETE_CONFLICT",
        `${pgNo}는 수동 재고 추가에서 생성된 현재 행만 가진 기기가 아니므로 삭제할 수 없습니다.`
      );
    }

    if (current?.inventory && !current.inventory_sku_id) {
      throw publicConflict(
        "INVENTORY_LEDGER_CONFLICT",
        `${pgNo}의 재고 SKU가 확정되지 않아 수량 원장에 삭제 이력을 기록할 수 없습니다.`
      );
    }

    if (current?.inventory && current.inventory_sku_id) {
      await recordInventoryRemovedWithLedger(tx, {
        pgNo,
        inventorySkuId: current.inventory_sku_id,
        inventoryStatus: current.inventory.inventory_status,
        operationKey: `MANUAL_INVENTORY_DELETE:${pgNo}:${randomUUID()}`,
        movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryRemoved,
        sourceType: "MANUAL_INVENTORY",
        sourceId: pgNo,
        reason,
        actorUserId: user.userId,
        occurredAt: timestamp,
      });
    }

    await tx.inventory.deleteMany({ where: { pg_no: pgNo } });
    await tx.inspections.deleteMany({ where: { pg_no: pgNo } });
    await tx.inbounds.deleteMany({ where: { pg_no: pgNo } });
    const deleted = await tx.devices.deleteMany({
      where: { device_id: current.device_id, pg_no: pgNo, revision: expectedRevision },
    });
    if (deleted.count !== 1) {
      throw publicConflict(
        "INVENTORY_DELETE_TARGET_CHANGED",
        `${pgNo} 기기 정보가 삭제 중 변경되었습니다. 목록을 새로 고쳐 주세요.`
      );
    }

    await writeActivityLog({
      tx,
      user,
      actionType: "INVENTORY_MANUAL_DELETE",
      pgNo,
      beforeValue: before,
      afterValue: {
        reason,
        deleted: true,
      },
      result: "SUCCESS",
      timestamp,
    });

    return { pgNo };
  });
}
